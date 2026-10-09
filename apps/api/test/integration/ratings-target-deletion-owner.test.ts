import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { ratingDeletionFixture } from '../support/rating-deletion-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { setRatingReviewState } from '../support/rating-runtime-fixture.js';
import { observeDirectoryQueries } from '../support/directory-query-observer.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';

const prefix = '/v1/ratings/management/owner-deletion';

// Ordinary HTTP and disposable canonical owner facts. These tests intentionally
// do not reuse administrator deletion authority or a public target projection.
test('M2A creator-only target cleanup, private metadata and durable command recovery', async (t) => {
  const f = await ratingDeletionFixture();
  t.after(() => f.close());
  const owner = await f.actor(),
    outsider = await f.actor();
  const catalog = await f.catalog(owner, { count: 8 });
  const [visible, hidden, gates, raceTarget, cancelTarget, namespaceTarget] =
    catalog.targets;
  assert.ok(
    visible && hidden && gates && raceTarget && cancelTarget && namespaceTarget,
  );
  type Actor = typeof owner;
  type Target = typeof visible;
  const input = (target: Target, expectedTargetRevision = target.revision) => ({
    clientRequestId: randomUUID(),
    expectedTargetRevision,
  });
  const context = (target: Target, actor = owner) =>
    f.auth(
      request(f.http).get(`${prefix}/targets/${target.id}/context`),
      actor,
    );
  const remove = (target: Target, body: object, actor = owner) =>
    f
      .auth(request(f.http).post(`${prefix}/targets/${target.id}`), actor)
      .send(body);
  const cancel = (target: Target, body: object, actor = owner) =>
    f
      .auth(request(f.http).post(`${prefix}/cancel`), actor)
      .send({ targetId: target.id, ...body });
  const recover = (id: string, actor = owner) =>
    f.auth(request(f.http).get(`${prefix}/requests/${id}`), actor);
  const rejected = (body: unknown, requestId: string, code: string) =>
    assert.deepEqual(body, {
      requestId,
      operation: 'delete_target',
      outcome: 'rejected',
      code,
    });
  const state = async (target: Target) =>
    (
      await f.pool.query(
        'SELECT id,revision,active FROM whaleu_ratings.targets WHERE id=$1',
        [target.id],
      )
    ).rows[0];
  const noTerminal = async (requestId: string) => {
    for (const [table, actorColumn] of [
      ['requests', 'account_id'],
      ['command_claims', 'account_id'],
      ['target_owner_delete_audits', 'actor_account_id'],
      ['target_owner_delete_closures', 'actor_account_id'],
    ])
      assert.equal(
        (
          await f.pool.query(
            `SELECT 1 FROM whaleu_ratings.${table} WHERE ${actorColumn}=$1 AND request_id=$2`,
            [owner.accountId, requestId],
          )
        ).rowCount,
        0,
        table,
      );
  };

  await t.test(
    'strict metadata/context and command DTOs never accept hidden authority fields',
    async () => {
      const response = await context(visible);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.deepEqual(response.body, {
        targetId: visible.id,
        revision: visible.revision,
        deletion: { kind: 'not_owner_deleted' },
      });
      assert.equal(response.headers['cache-control'], 'no-store');
      assert.match(response.headers['vary'] ?? '', /Authorization/i);
      for (const extra of [
        { regionId: null },
        { creatorId: owner.accountId },
        { role: 'super_admin' },
        { name: 'Changed definition' },
        { description: 'Changed definition' },
        { targetId: visible.id },
        { deleted: true },
        { expectedContextRevision: 'x'.repeat(43) },
      ]) {
        const body = { ...input(visible), ...extra };
        const invalid = await remove(visible, body);
        assert.equal(invalid.status, 400, JSON.stringify(invalid.body));
        await noTerminal(body.clientRequestId);
      }
      assert.equal(
        (await context(visible).query({ regionId: randomUUID() })).status,
        400,
      );
      assert.equal(
        (
          await f
            .auth(request(f.http).post(`${prefix}/cancel`), owner)
            .send(input(visible))
        ).status,
        400,
      );
    },
  );

  await t.test(
    'non-creators, including every administrator role, get no ownership or revision disclosure',
    async () => {
      const actors: Actor[] = [outsider];
      for (const role of [
        'super_admin',
        'developer',
        'school_admin',
      ] as const) {
        const actor = await f.actor();
        await f.grant(
          actor,
          role,
          role === 'school_admin' ? f.scope.home.regionId : null,
        );
        actors.push(actor);
      }
      for (const actor of actors) {
        const response = await context(visible, actor);
        assert.equal(
          response.body.error?.code,
          'RATING_NOT_FOUND',
          JSON.stringify(response.body),
        );
        const body = input(visible, randomUUID());
        const denied = await remove(visible, body, actor);
        assert.equal(denied.status, 200, JSON.stringify(denied.body));
        rejected(denied.body, body.clientRequestId, 'RATING_NOT_FOUND');
        assert.deepEqual(
          (await recover(body.clientRequestId, actor)).body,
          denied.body,
        );
        assert.equal(JSON.stringify(denied.body).includes(visible.id), false);
      }
      assert.equal((await state(visible)).active, true);
    },
  );

  let applied: request.Response;
  let original: ReturnType<typeof input>;
  await t.test(
    'discarded success recovers with the exact key; CAS precedes owner-deleted noop',
    async () => {
      original = input(visible);
      // Deliberately discard the response, as a client would after losing delivery.
      await remove(visible, original);
      applied = await recover(original.clientRequestId);
      assert.equal(applied.status, 200, JSON.stringify(applied.body));
      assert.equal(
        applied.body.outcome,
        'applied',
        JSON.stringify(applied.body),
      );
      assert.deepEqual(Object.keys(applied.body).sort(), [
        'occurredAt',
        'operation',
        'outcome',
        'requestId',
        'revision',
        'targetId',
      ]);
      assert.equal(applied.body.operation, 'delete_target');
      assert.equal(applied.body.targetId, visible.id);
      assert.notEqual(applied.body.revision, visible.revision);
      assert.deepEqual((await remove(visible, original)).body, applied.body);
      assert.deepEqual((await cancel(visible, original)).body, applied.body);
      assert.deepEqual(await state(visible), {
        id: visible.id,
        revision: applied.body.revision,
        active: false,
      });
      const stale = input(visible);
      rejected(
        (await remove(visible, stale)).body,
        stale.clientRequestId,
        'RATING_REVISION_CONFLICT',
      );
      visible.revision = applied.body.revision;
      assert.deepEqual((await context(visible)).body, {
        targetId: visible.id,
        revision: visible.revision,
        deletion: { kind: 'owner_deleted' },
      });
      const before = (
        await f.pool.query(
          'SELECT * FROM whaleu_ratings.target_state_revisions WHERE target_id=$1 ORDER BY revision',
          [visible.id],
        )
      ).rows;
      const originalTombstone = (
        await f.pool.query(
          'SELECT * FROM whaleu_ratings.target_owner_tombstones WHERE target_id=$1',
          [visible.id],
        )
      ).rows;
      const noop = await remove(visible, input(visible));
      assert.equal(noop.body.outcome, 'noop', JSON.stringify(noop.body));
      assert.equal(noop.body.revision, applied.body.revision);
      assert.ok(Number.isFinite(Date.parse(noop.body.occurredAt)));
      const exactNoop = (
        await f.pool.query<{ exact: boolean }>(
          `SELECT a.occurred_at=$3::timestamptz AND a.occurred_at>=d.deleted_at AND a.source_delete_audit_id=d.delete_audit_id exact
      FROM whaleu_ratings.target_owner_delete_audits a JOIN whaleu_ratings.target_owner_tombstones d ON d.target_id=a.target_id
      WHERE a.actor_account_id=$1 AND a.request_id=$2`,
          [owner.accountId, noop.body.requestId, noop.body.occurredAt],
        )
      ).rows[0]!;
      assert.equal(exactNoop.exact, true);
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT * FROM whaleu_ratings.target_owner_tombstones WHERE target_id=$1',
            [visible.id],
          )
        ).rows,
        originalTombstone,
      );
      assert.deepEqual(
        (
          await f.pool.query(
            'SELECT * FROM whaleu_ratings.target_state_revisions WHERE target_id=$1 ORDER BY revision',
            [visible.id],
          )
        ).rows,
        before,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=$1',
            [visible.id],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (await recover(original.clientRequestId, outsider)).body.error?.code,
        'REQUEST_NOT_FOUND',
      );
      for (const [target, body] of [
        [visible, { ...original, expectedTargetRevision: visible.revision }],
        [namespaceTarget, original],
      ] as const)
        assert.equal(
          (await remove(target, body)).body.error?.code,
          'REQUEST_CONFLICT',
        );
    },
  );

  await t.test(
    'historic receipt survives a new same-account session and changed present eligibility',
    async () => {
      const identity = (
        await f.pool.query<{
          provider: 'wechat';
          app_id: string;
          subject: string;
        }>(
          'SELECT provider,app_id,subject FROM whaleu_identity.provider_identities WHERE account_id=$1',
          [owner.accountId],
        )
      ).rows[0]!;
      const token = mintToken('access');
      const session = await f.app.get(IdentityRepository).createSession(
        {
          provider: identity.provider,
          appId: identity.app_id,
          subject: identity.subject,
        },
        {
          access: hashToken(token),
          refresh: hashToken(mintToken('refresh')),
        },
      );
      const refreshed = { ...owner, ...session, accessToken: token };
      await f.certify(owner.accountId, {
        affiliation: 'unavailable',
        phone: 'unavailable',
        identity: false,
      });
      assert.deepEqual(
        (await recover(original.clientRequestId, refreshed)).body,
        applied.body,
      );
      assert.deepEqual(
        (await remove(visible, original, refreshed)).body,
        applied.body,
      );
      assert.deepEqual(
        (await cancel(visible, original, refreshed)).body,
        applied.body,
      );
      owner.accessToken = token;
      await f.certify(owner.accountId);
    },
  );

  await t.test(
    'cancel-before-submit and concurrent cancel/delete have one durable terminal history',
    async () => {
      const cancelledInput = input(cancelTarget);
      const cancelled = await cancel(cancelTarget, cancelledInput);
      assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
      rejected(
        cancelled.body,
        cancelledInput.clientRequestId,
        'RATING_TARGET_DELETION_CANCELLED',
      );
      assert.deepEqual(
        (await remove(cancelTarget, cancelledInput)).body,
        cancelled.body,
      );
      assert.deepEqual(
        (await cancel(cancelTarget, cancelledInput)).body,
        cancelled.body,
      );
      assert.equal((await state(cancelTarget)).active, true);
      const body = input(raceTarget);
      const [one, two] = await Promise.all([
        remove(raceTarget, body),
        cancel(raceTarget, body),
      ]);
      assert.equal(one.status, 200, JSON.stringify(one.body));
      assert.equal(two.status, 200, JSON.stringify(two.body));
      assert.deepEqual(one.body, two.body);
      assert.deepEqual((await recover(body.clientRequestId)).body, one.body);
      const won = one.body.outcome === 'applied';
      if (!won)
        rejected(
          one.body,
          body.clientRequestId,
          'RATING_TARGET_DELETION_CANCELLED',
        );
      assert.equal((await state(raceTarget)).active, !won);
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=$1',
            [raceTarget.id],
          )
        ).rowCount,
        won ? 1 : 0,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_ratings.target_owner_delete_audits WHERE actor_account_id=$1 AND request_id=$2',
            [owner.accountId, body.clientRequestId],
          )
        ).rowCount,
        won ? 1 : 0,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_ratings.target_owner_delete_closures WHERE actor_account_id=$1 AND request_id=$2',
            [owner.accountId, body.clientRequestId],
          )
        ).rowCount,
        won ? 0 : 1,
      );
    },
  );

  await t.test(
    'delete uses the shared score and create command namespace in both directions',
    async () => {
      const key = randomUUID();
      const score = {
        clientRequestId: key,
        regionId: null,
        expectedTargetRevision: namespaceTarget.revision,
        expectedRevision: null,
        score: 4,
      };
      const scored = await f
        .auth(
          request(f.http).put(
            `/v1/ratings/targets/${namespaceTarget.id}/my-score`,
          ),
          owner,
        )
        .send(score);
      assert.equal(scored.body.outcome, 'applied', JSON.stringify(scored.body));
      assert.equal(
        (
          await remove(namespaceTarget, {
            ...input(namespaceTarget),
            clientRequestId: key,
          })
        ).body.error?.code,
        'REQUEST_CONFLICT',
      );
      assert.equal((await recover(key)).body.error?.code, 'REQUEST_NOT_FOUND');
      const create = {
        clientRequestId: randomUUID(),
        regionId: null,
        categoryId: catalog.categoryId,
        expectedCategoryRevision: catalog.categoryRevision,
        expectedCatalogRevision: catalog.catalogId,
        name: 'Cancelled synthetic M1 target',
        description: '',
        assetIds: [],
      };
      const closed = await f
        .auth(request(f.http).post('/v1/ratings/management/cancel'), owner)
        .send(create);
      assert.equal(
        closed.body.code,
        'RATING_CREATION_CANCELLED',
        JSON.stringify(closed.body),
      );
      assert.equal(
        (
          await remove(namespaceTarget, {
            ...input(namespaceTarget),
            clientRequestId: create.clientRequestId,
          })
        ).body.error?.code,
        'REQUEST_CONFLICT',
      );
      for (const response of [
        await f
          .auth(
            request(f.http).put(
              `/v1/ratings/targets/${namespaceTarget.id}/my-score`,
            ),
            owner,
          )
          .send({ ...score, clientRequestId: original.clientRequestId }),
        await f
          .auth(request(f.http).post('/v1/ratings/management/cancel'), owner)
          .send({ ...create, clientRequestId: original.clientRequestId }),
      ])
        assert.equal(
          response.body.error?.code,
          'REQUEST_CONFLICT',
          JSON.stringify(response.body),
        );
      assert.equal(
        (
          await f.auth(
            request(f.http).get(
              `/v1/ratings/requests/${original.clientRequestId}`,
            ),
            owner,
          )
        ).body.error?.code,
        'REQUEST_NOT_FOUND',
      );
      assert.equal(
        (
          await f.auth(
            request(f.http).get(
              `/v1/ratings/management/requests/${original.clientRequestId}`,
            ),
            owner,
          )
        ).body.error?.code,
        'REQUEST_NOT_FOUND',
      );
    },
  );

  await t.test(
    'two creator writers serialize before target locks and only one revision-changing command wins',
    async () => {
      const selected = catalog.targets[6]!;
      const first = input(selected),
        second = input(selected);
      const pair = await Promise.all([
        remove(selected, first),
        remove(selected, second),
      ]);
      assert.ok(
        pair.every((response) => response.status === 200),
        JSON.stringify(pair.map((response) => response.body)),
      );
      assert.deepEqual(pair.map((response) => response.body.outcome).sort(), [
        'applied',
        'rejected',
      ]);
      const loser = pair.find(
        (response) => response.body.outcome === 'rejected',
      )!;
      rejected(loser.body, loser.body.requestId, 'RATING_REVISION_CONFLICT');
      const selectedAgain = catalog.targets[7]!;
      const sameKey = input(selectedAgain);
      const duplicates = await Promise.all([
        remove(selectedAgain, sameKey),
        remove(selectedAgain, sameKey),
      ]);
      assert.equal(
        duplicates[0]!.body.outcome,
        'applied',
        JSON.stringify(duplicates[0]!.body),
      );
      assert.deepEqual(duplicates[0]!.body, duplicates[1]!.body);
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_ratings.target_owner_delete_audits WHERE target_id=$1',
            [selectedAgain.id],
          )
        ).rowCount,
        1,
      );
    },
  );

  await t.test(
    'explicit phone/Safety denial closes durably; unknown verification never invents a terminal result',
    async () => {
      await f.certify(owner.accountId, { phone: 'unverified' });
      const phone = input(gates);
      rejected(
        (await remove(gates, phone)).body,
        phone.clientRequestId,
        'PHONE_VERIFICATION_REQUIRED',
      );
      await f.certify(owner.accountId);
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=$1',
          [owner.accountId],
        ),
      );
      const safety = input(gates);
      rejected(
        (await remove(gates, safety)).body,
        safety.clientRequestId,
        'SAFETY_ACTION_RESTRICTED',
      );
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          'UPDATE whaleu_safety.account_heads SET actions_allowed=true WHERE account_id=$1',
          [owner.accountId],
        ),
      );
      await f.certify(owner.accountId, {
        phone: 'unavailable',
        affiliation: 'unavailable',
        identity: false,
      });
      const unknown = input(gates);
      const response = await remove(gates, unknown);
      assert.equal(
        response.body.error?.code,
        'VERIFICATION_UNAVAILABLE',
        JSON.stringify(response.body),
      );
      await noTerminal(unknown.clientRequestId);
      assert.equal((await state(gates)).active, true);
      await f.certify(owner.accountId);
      const unknownSafety = input(gates);
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          "UPDATE whaleu_safety.account_heads SET restriction_coverage='missing' WHERE account_id=$1",
          [owner.accountId],
        ),
      );
      assert.equal(
        (await remove(gates, unknownSafety)).body.error?.code,
        'SAFETY_UNAVAILABLE',
      );
      await noTerminal(unknownSafety.clientRequestId);
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          "UPDATE whaleu_safety.account_heads SET restriction_coverage='complete' WHERE account_id=$1",
          [owner.accountId],
        ),
      );
      assert.deepEqual(
        (await remove(gates, phone)).body,
        (await recover(phone.clientRequestId)).body,
      );
      rejected(
        (await recover(phone.clientRequestId)).body,
        phone.clientRequestId,
        'PHONE_VERIFICATION_REQUIRED',
      );
      rejected(
        (await recover(safety.clientRequestId)).body,
        safety.clientRequestId,
        'SAFETY_ACTION_RESTRICTED',
      );
      assert.equal((await remove(gates, unknown)).body.outcome, 'applied');
    },
  );

  await t.test(
    'withdrawn review/catalog plus inactive lifecycle still require an independent owner tombstone',
    async () => {
      const priorRevision = hidden.revision;
      hidden.revision = randomUUID();
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          'UPDATE whaleu_ratings.targets SET active=false,revision=$2 WHERE id=$1',
          [hidden.id, hidden.revision],
        ),
      );
      await f.catalog(owner, { hidden: true });
      await setRatingReviewState(f.pool, hidden.approval.decisionId, 'revoked');
      await f.certify(owner.accountId, {
        affiliation: 'unavailable',
        identity: false,
      });
      const observer = observeDirectoryQueries(f.app);
      const targetReads: string[] = [];
      observer.setHook(async ({ sql }) => {
        if (/^\s*SELECT[\s\S]*FROM whaleu_ratings\.targets\b/i.test(sql))
          targetReads.push(sql);
      });
      try {
        assert.deepEqual((await context(hidden)).body, {
          targetId: hidden.id,
          revision: hidden.revision,
          deletion: { kind: 'not_owner_deleted' },
        });
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.target_owner_tombstones WHERE target_id=$1',
              [hidden.id],
            )
          ).rowCount,
          0,
        );
        const stale = input(hidden, priorRevision);
        rejected(
          (await remove(hidden, stale)).body,
          stale.clientRequestId,
          'RATING_REVISION_CONFLICT',
        );
        const inactiveRevision = hidden.revision;
        const response = await remove(hidden, input(hidden));
        assert.equal(
          response.body.outcome,
          'applied',
          JSON.stringify(response.body),
        );
        assert.notEqual(
          response.body.revision,
          inactiveRevision,
          'inactive→inactive owner deletion needs its own lifecycle revision',
        );
        assert.equal((await state(hidden)).active, false);
        assert.equal(
          (
            await f.pool.query(
              'SELECT before_active FROM whaleu_ratings.target_owner_delete_audits WHERE actor_account_id=$1 AND request_id=$2',
              [owner.accountId, response.body.requestId],
            )
          ).rows[0]!.before_active,
          false,
        );
        assert.deepEqual((await context(hidden)).body, {
          targetId: hidden.id,
          revision: response.body.revision,
          deletion: { kind: 'owner_deleted' },
        });
        assert.ok(targetReads.length > 0);
        for (const sql of targetReads)
          assert.doesNotMatch(
            sql,
            /\b(name|description|envelope|region_id|source_id|category_id)\b|SELECT\s+(?:t\.)?\*/i,
            sql,
          );
      } finally {
        observer.restore();
      }
    },
  );
});
