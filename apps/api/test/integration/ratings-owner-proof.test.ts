import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import request from 'supertest';
import {
  ratingRuntimeFixture,
  approveRating,
  setRatingReviewState,
} from '../support/rating-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { seedTemporaryErrandBase } from '../support/errand-runtime-fixture.js';
import { inTransaction } from '../../src/database/database.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { RatingSafetyFacade } from '../../src/safety/rating.facade.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { AuthorDisplayService } from '../../src/profile/author-display.service.js';

test('ratings owner authorities use canonical grants, independent temporary base and mandatory final proof', async (t) => {
  const f = await ratingRuntimeFixture();
  t.after(() => f.close());
  const owner = await f.actor(),
    viewer = await f.actor(),
    other = await f.actor();
  const catalog = await f.catalog(owner),
    target = catalog.targets[0]!;
  type Actor = typeof owner;
  const get = (
    path: string,
    actor = viewer,
    query: Record<string, unknown> = {},
  ) => f.auth(request(f.http).get(path), actor).query(query);
  const count = async (table: string, column: string, value: string) =>
    Number(
      (
        await f.pool.query(
          `SELECT count(*) n FROM ${table} WHERE ${column}=$1`,
          [value],
        )
      ).rows[0]!.n,
    );
  const temporary = async (
    accountId: string,
    state: 'verified' | 'unverified' | 'revoked',
  ) =>
    withCommunityScopeWriter(f.pool, async (tx) => {
      const id = randomUUID();
      await tx.query(
        `INSERT INTO whaleu_verification.rating_base_assertions(id,account_id,state,coverage,provenance,issuer,source_reference,policy_reference,effective_at,valid_until) VALUES($1,$2,$3,'complete','accepted','synthetic-rating-base-owner','synthetic-rating-base-source','synthetic-rating-base-policy',clock_timestamp(),clock_timestamp()+interval '1 hour')`,
        [id, accountId, state],
      );
      await tx.query(
        'INSERT INTO whaleu_verification.rating_base_heads(account_id,assertion_id) VALUES($1,$2) ON CONFLICT(account_id) DO UPDATE SET assertion_id=EXCLUDED.assertion_id',
        [accountId, id],
      );
    });
  const block = async (
    blocker: Actor,
    blocked: Actor,
    active = true,
    raw = false,
  ) => {
    // Test fixture deliberately creates the synthetic public profile through
    // its canonical owner; ordinary rating reads never initialize profiles.
    const profile = await inTransaction(f.pool, async (tx) => {
      await lockSafetyPolicy(tx);
      return f.app.get(AuthorDisplayService).prepare(blocked.accountId, tx);
    });
    assert.ok(profile.profileId);
    const write = async (tx: PoolClient) => {
      const existing = (
        await tx.query<{ id: string }>(
          'SELECT id FROM whaleu_safety.blocks WHERE blocker_id=$1 AND blocked_id=$2',
          [blocker.accountId, blocked.accountId],
        )
      ).rows[0];
      const id = existing?.id ?? randomUUID();
      if (existing)
        await tx.query(
          'UPDATE whaleu_safety.blocks SET active=$2,revision=revision+1 WHERE id=$1',
          [id, active],
        );
      else
        await tx.query(
          `INSERT INTO whaleu_safety.blocks(id,blocker_id,blocked_id,active,revision,display_snapshot,source_kind,source_id) VALUES($1,$2,$3,$4,1,'Synthetic rating visibility','profile',$5)`,
          [id, blocker.accountId, blocked.accountId, active, profile.profileId],
        );
      await tx.query(
        'INSERT INTO whaleu_safety.events(id,account_id,relationship_id,kind,revision) SELECT $1,blocker_id,id,$2,revision FROM whaleu_safety.blocks WHERE id=$3',
        [randomUUID(), active ? 'blocked' : 'unblocked', id],
      );
    };
    if (raw) await inTransaction(f.pool, write);
    else await withCommunityScopeWriter(f.pool, write);
  };
  await t.test(
    'temporary rating eligibility never reuses errand base, and anonymous publication does not depend on scoring',
    async () => {
      const actor = await f.actor({
        affiliation: 'unverified',
        identity: false,
      });
      await temporary(actor.accountId, 'unverified');
      await seedTemporaryErrandBase(f.pool, actor.accountId);
      let detail = await get(`/v1/ratings/targets/${target.id}`, actor);
      assert.deepEqual(detail.body.allowedActions.authorModes, ['named']);
      const denied = f.body(catalog, target, {
        authorMode: 'anonymous',
        body: 'Synthetic errand base is not rating permission',
      });
      await approveRating(f.pool, f.envelope(actor, catalog, target, denied));
      const rejection = await f
        .auth(
          request(f.http).post(`/v1/ratings/targets/${target.id}/comments`),
          actor,
        )
        .send(denied);
      assert.equal(
        rejection.body.outcome,
        'rejected',
        JSON.stringify(rejection.body),
      );
      assert.equal(rejection.body.code, 'AFFILIATION_VERIFICATION_REQUIRED');
      await temporary(actor.accountId, 'verified');
      detail = await get(`/v1/ratings/targets/${target.id}`, actor);
      assert.deepEqual(detail.body.allowedActions.authorModes, [
        'named',
        'anonymous',
      ]);
      const published = await f.publish(
        actor,
        catalog,
        target,
        f.body(catalog, target, {
          authorMode: 'anonymous',
          body: 'Synthetic rating-purpose base',
        }),
      );
      assert.equal(
        (await get(`/v1/ratings/targets/${target.id}/my-score`, actor)).body
          .myScore,
        null,
      );
      await temporary(actor.accountId, 'revoked');
      assert.deepEqual(
        (await get(`/v1/ratings/targets/${target.id}`, actor)).body
          .allowedActions.authorModes,
        ['named'],
      );
      const retained = await get(`/v1/ratings/comments/${published.id}`);
      assert.equal(retained.status, 200, JSON.stringify(retained.body));
      assert.equal(retained.body.author.mode, 'anonymous');
      assert.ok(!JSON.stringify(retained.body).includes(actor.accountId));
    },
  );
  await t.test(
    'school administrator scope is fixed and unique; current global grant may use any valid region',
    async () => {
      const admin = await f.actor({
        affiliation: 'unverified',
        identity: false,
      });
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'school_admin',$3,$2,'synthetic-rating-fixed-admin')`,
          [randomUUID(), admin.accountId, f.scope.related.regionId],
        ),
      );
      const related = await f.catalog(owner, {
          regionId: f.scope.related.regionId,
        }),
        foreign = await f.catalog(owner, {
          regionId: f.scope.foreign.regionId,
        });
      const context = await get('/v1/ratings/context', admin);
      assert.equal(context.status, 200, JSON.stringify(context.body));
      assert.deepEqual(context.body.regions, [
        {
          id: f.scope.related.regionId,
          label: context.body.regions[0].label,
          relation: 'managed',
        },
      ]);
      assert.equal(
        (
          await get(`/v1/ratings/targets/${related.targets[0]!.id}`, admin, {
            regionId: f.scope.related.regionId,
          })
        ).status,
        200,
      );
      assert.equal(
        (
          await get(`/v1/ratings/targets/${foreign.targets[0]!.id}`, admin, {
            regionId: f.scope.foreign.regionId,
          })
        ).body.error.code,
        'RATING_SCOPE_UNAVAILABLE',
      );
      assert.equal(
        (await get(`/v1/ratings/targets/${target.id}`, admin)).status,
        200,
      );
      await assert.rejects(
        withCommunityScopeWriter(f.pool, (tx) =>
          tx.query(
            `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'school_admin',$3,$2,'synthetic-duplicate-forbidden')`,
            [randomUUID(), admin.accountId, f.scope.foreign.regionId],
          ),
        ),
      );
      const global = await f.actor({
        affiliation: 'unverified',
        identity: false,
      });
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'developer',NULL,$2,'synthetic-rating-global-admin')`,
          [randomUUID(), global.accountId],
        ),
      );
      assert.equal(
        (
          await get(`/v1/ratings/targets/${foreign.targets[0]!.id}`, global, {
            regionId: f.scope.foreign.regionId,
          })
        ).status,
        200,
      );
    },
  );
  let named: Awaited<ReturnType<typeof f.publish>>,
    anonymous: Awaited<ReturnType<typeof f.publish>>;
  await t.test(
    'named list is outgoing-only; direct is bilateral; anonymous never consults hidden author blocks',
    async () => {
      named = await f.publish(
        owner,
        catalog,
        target,
        f.body(catalog, target, { body: 'Synthetic named relationship' }),
      );
      await f.publish(
        other,
        catalog,
        target,
        f.body(catalog, target, { body: 'Synthetic visible continuation' }),
      );
      anonymous = await f.publish(
        owner,
        catalog,
        target,
        f.body(catalog, target, {
          body: 'Synthetic anonymous bypass',
          authorMode: 'anonymous',
        }),
      );
      await block(owner, viewer);
      const incoming = await get(`/v1/ratings/targets/${target.id}/comments`);
      assert.equal(incoming.status, 200, JSON.stringify(incoming.body));
      assert.ok(
        incoming.body.items.some((c: { id: string }) => c.id === named.id),
      );
      assert.equal((await get(`/v1/ratings/comments/${named.id}`)).status, 404);
      const anonymousDirect = await get(`/v1/ratings/comments/${anonymous.id}`);
      assert.equal(
        anonymousDirect.status,
        200,
        JSON.stringify(anonymousDirect.body),
      );
      assert.equal(anonymousDirect.body.author.mode, 'anonymous');
      assert.ok(
        !JSON.stringify(anonymousDirect.body).includes(owner.accountId),
      );
      await block(viewer, owner);
      const outgoing = await get(`/v1/ratings/targets/${target.id}/comments`);
      assert.equal(outgoing.status, 200, JSON.stringify(outgoing.body));
      assert.ok(
        !outgoing.body.items.some((c: { id: string }) => c.id === named.id),
      );
      assert.ok(
        outgoing.body.items.some((c: { id: string }) => c.id === anonymous.id),
      );
    },
  );
  await t.test(
    'unblock and previously filtered review-allow both require cursor restart',
    async () => {
      const page = await get(
        `/v1/ratings/targets/${target.id}/comments`,
        viewer,
        { limit: 1 },
      );
      assert.ok(page.body.nextCursor, JSON.stringify(page.body));
      await block(viewer, owner, false);
      const restart = await get(
        `/v1/ratings/targets/${target.id}/comments`,
        viewer,
        { limit: 1, cursor: page.body.nextCursor },
      );
      assert.equal(restart.body.error.code, 'DISCOVERY_RESTART_REQUIRED');
      await setRatingReviewState(f.pool, named.approval.decisionId, 'held');
      const held = await get(
        `/v1/ratings/targets/${target.id}/comments`,
        viewer,
        { limit: 1 },
      );
      assert.ok(held.body.nextCursor, JSON.stringify(held.body));
      await setRatingReviewState(f.pool, named.approval.decisionId, 'allow');
      assert.equal(
        (
          await get(`/v1/ratings/targets/${target.id}/comments`, viewer, {
            limit: 1,
            cursor: held.body.nextCursor,
          })
        ).body.error.code,
        'DISCOVERY_RESTART_REQUIRED',
      );
    },
  );
  await t.test(
    'raw negative block change after an observed allow is caught by required owner epoch',
    async () => {
      const a = await f.actor(),
        b = await f.actor();
      await assert.rejects(
        inTransaction(
          f.pool,
          async (tx) => {
            await lockSafetyPolicy(tx);
            assert.equal(
              (
                await f.app
                  .get(RatingSafetyFacade)
                  .named(a.accountId, b.accountId, 'rating_list', tx)
              ).kind,
              'allow',
            );
            await block(a, b, true, true);
          },
          { isolationLevel: 'read committed' },
        ),
        (e: unknown) =>
          e instanceof ApplicationError && e.code === 'SAFETY_UNAVAILABLE',
      );
    },
  );
  const installWait = () =>
    f.pool.query(
      `CREATE FUNCTION whaleu_ratings.synthetic_owner_deferred_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2.4); RETURN NULL; END $$; CREATE CONSTRAINT TRIGGER synthetic_owner_deferred_wait AFTER INSERT ON whaleu_ratings.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.synthetic_owner_deferred_wait()`,
    );
  const removeWait = () =>
    f.pool.query(
      'DROP TRIGGER synthetic_owner_deferred_wait ON whaleu_ratings.requests; DROP FUNCTION whaleu_ratings.synthetic_owner_deferred_wait()',
    );
  await t.test(
    'scheduled school grant activation narrows ordinary regional authority before commit',
    async () => {
      const actor = await f.actor(),
        local = await f.catalog(owner, { regionId: f.scope.home.regionId }),
        localTarget = local.targets[0]!,
        key = randomUUID();
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference,valid_from) VALUES($1,$2,'school_admin',$3,$2,'synthetic-scheduled-rating-school',clock_timestamp()+interval '2 seconds')`,
          [randomUUID(), actor.accountId, f.scope.foreign.regionId],
        ),
      );
      await installWait();
      try {
        const started = Date.now();
        const response = await f
          .auth(
            request(f.http).put(
              `/v1/ratings/targets/${localTarget.id}/my-score`,
            ),
            actor,
          )
          .send({
            clientRequestId: key,
            regionId: f.scope.home.regionId,
            expectedTargetRevision: localTarget.revision,
            expectedRevision: null,
            score: 3,
          });
        assert.ok(
          Date.now() - started >= 2300,
          'The database deferred wait must actually execute',
        );
        assert.equal(
          response.body.error.code,
          'AUTHORIZATION_UNAVAILABLE',
          JSON.stringify(response.body),
        );
        assert.equal(
          await count('whaleu_ratings.requests', 'request_id', key),
          0,
        );
        assert.equal(
          await count('whaleu_ratings.scores', 'account_id', actor.accountId),
          0,
        );
      } finally {
        await removeWait();
      }
    },
  );
  await t.test(
    'phone expiration during deferred waits rolls back score transition, summary and receipt',
    async () => {
      const actor = await f.actor({
          affiliation: 'unverified',
          identity: false,
          expiresAt: new Date(Date.now() + 2000),
        }),
        key = randomUUID();
      const before = (
        await f.pool.query(
          'SELECT * FROM whaleu_ratings.score_summaries WHERE target_id=$1',
          [target.id],
        )
      ).rows;
      await installWait();
      try {
        const started = Date.now();
        const r = await f
          .auth(
            request(f.http).put(`/v1/ratings/targets/${target.id}/my-score`),
            actor,
          )
          .send({
            clientRequestId: key,
            regionId: null,
            expectedTargetRevision: target.revision,
            expectedRevision: null,
            score: 4,
          });
        assert.ok(
          Date.now() - started >= 2300,
          'The database deferred wait must actually execute',
        );
        assert.equal(
          r.body.error.code,
          'VERIFICATION_UNAVAILABLE',
          JSON.stringify(r.body),
        );
        assert.equal(
          await count('whaleu_ratings.requests', 'request_id', key),
          0,
        );
        assert.equal(
          await count('whaleu_ratings.scores', 'account_id', actor.accountId),
          0,
        );
        assert.equal(
          await count(
            'whaleu_ratings.score_transitions',
            'account_id',
            actor.accountId,
          ),
          0,
        );
        assert.deepEqual(
          (
            await f.pool.query(
              'SELECT * FROM whaleu_ratings.score_summaries WHERE target_id=$1',
              [target.id],
            )
          ).rows,
          before,
        );
      } finally {
        await removeWait();
      }
    },
  );
  await t.test(
    'presented session token expiry after deferred waits rolls back a tentative score and receipt',
    async () => {
      const actor = await f.actor(),
        key = randomUUID();
      await f.pool.query(
        "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '2 seconds' WHERE session_id=$1",
        [actor.sessionId],
      );
      await installWait();
      try {
        const started = Date.now();
        const r = await f
          .auth(
            request(f.http).put(`/v1/ratings/targets/${target.id}/my-score`),
            actor,
          )
          .send({
            clientRequestId: key,
            regionId: null,
            expectedTargetRevision: target.revision,
            expectedRevision: null,
            score: 2,
          });
        assert.ok(
          Date.now() - started >= 2300,
          'The database deferred wait must actually execute',
        );
        assert.equal(
          r.body.error.code,
          'ACCESS_TOKEN_EXPIRED',
          JSON.stringify(r.body),
        );
        assert.equal(
          await count('whaleu_ratings.requests', 'request_id', key),
          0,
        );
        assert.equal(
          await count('whaleu_ratings.scores', 'account_id', actor.accountId),
          0,
        );
      } finally {
        await removeWait();
      }
    },
  );
  await t.test(
    'exact Review consumption expires during deferred waits and rolls back comment, binding and receipt',
    async () => {
      const actor = await f.actor(),
        input = f.body(catalog, target, {
          body: 'Synthetic final review expiry',
        });
      const approval = await approveRating(
        f.pool,
        f.envelope(actor, catalog, target, input),
        { consumeUntil: new Date(Date.now() + 2000) },
      );
      await installWait();
      try {
        const started = Date.now();
        const r = await f
          .auth(
            request(f.http).post(`/v1/ratings/targets/${target.id}/comments`),
            actor,
          )
          .send(input);
        assert.ok(
          Date.now() - started >= 2300,
          'The database deferred wait must actually execute',
        );
        assert.equal(
          r.body.error.code,
          'CONTENT_REVIEW_UNAVAILABLE',
          JSON.stringify(r.body),
        );
        assert.equal(
          await count(
            'whaleu_ratings.requests',
            'request_id',
            input.clientRequestId,
          ),
          0,
        );
        assert.equal(
          await count('whaleu_ratings.comments', 'account_id', actor.accountId),
          0,
        );
        assert.equal(
          await count(
            'whaleu_community.rating_approval_bindings',
            'decision_id',
            approval.decisionId,
          ),
          0,
        );
      } finally {
        await removeWait();
      }
    },
  );
});
