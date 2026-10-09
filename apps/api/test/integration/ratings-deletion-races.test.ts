import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { ratingDeletionFixture } from '../support/rating-deletion-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';

test('deletion contexts fence changing authority, serialize ownership races, and roll back after deferred expiry', async (t) => {
  const f = await ratingDeletionFixture();
  t.after(() => f.close());
  const owner = await f.actor(),
    admin = await f.actor();
  await f.grant(admin, 'super_admin');
  const catalog = await f.catalog(owner, { count: 3 }),
    target = catalog.targets[0]!,
    originTarget = catalog.targets[1]!,
    expiringTarget = catalog.targets[2]!;
  const root = await f.publish(owner, catalog, target),
    originRoot = await f.publish(owner, catalog, originTarget),
    expiringRoot = await f.publish(owner, catalog, expiringTarget);
  const countRequest = async (key: string) =>
    (
      await f.pool.query(
        'SELECT count(*)::int n FROM whaleu_ratings.requests WHERE request_id=$1',
        [key],
      )
    ).rows[0]!.n;
  await t.test(
    'absent origin becoming known invalidates global context rather than silently rewriting intent',
    async () => {
      const old = f.command(await f.context(admin, 'comment', originRoot.id));
      await f.origin(originTarget.id, 'known_school', f.scope.home.campusId);
      const denied = await f.remove(admin, 'comment', originRoot.id, old);
      assert.equal(
        denied.body.error?.code,
        'RATING_DELETION_CONTEXT_CHANGED',
        JSON.stringify(denied.body),
      );
      assert.equal(await countRequest(old.clientRequestId), 0);
      const known = f.command(await f.context(admin, 'comment', originRoot.id));
      await f.origin(originTarget.id, 'unknown');
      await f.origin(originTarget.id, 'known_school', f.scope.home.campusId);
      const aba = await f.remove(admin, 'comment', originRoot.id, known);
      assert.equal(
        aba.body.error?.code,
        'RATING_DELETION_CONTEXT_CHANGED',
        JSON.stringify(aba.body),
      );
      assert.equal(await countRequest(known.clientRequestId), 0);
    },
  );
  await t.test(
    'owner and admin race leaves exactly one lifecycle transition and effect',
    async () => {
      const input = f.command(await f.context(admin, 'comment', root.id));
      const ownerInput = {
        clientRequestId: randomUUID(),
        regionId: null,
        targetId: target.id,
        expectedTargetRevision: target.revision,
        expectedRevision: root.revision,
      };
      const results = await Promise.all([
        f.remove(admin, 'comment', root.id, input),
        f
          .auth(
            request(f.http).delete(`/v1/ratings/comments/${root.id}`),
            owner,
          )
          .send(ownerInput),
      ]);
      assert.equal(
        results.filter((r) => r.body.outcome === 'applied').length,
        1,
        JSON.stringify(results.map((r) => r.body)),
      );
      assert.equal(
        results.filter((r) => r.body.code === 'RATING_REVISION_CONFLICT')
          .length,
        1,
        JSON.stringify(results.map((r) => r.body)),
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::int n FROM whaleu_ratings.comment_transitions WHERE comment_id=$1 AND operation='delete_comment'",
            [root.id],
          )
        ).rows[0]!.n,
        1,
      );
      assert.equal(
        (
          await f.pool.query(
            "SELECT count(*)::int n FROM whaleu_ratings.effect_events WHERE root_id=$1 AND event_kind='root_deleted'",
            [root.id],
          )
        ).rows[0]!.n,
        1,
      );
    },
  );
  await t.test(
    'grant added while target lock waits invalidates the complete grant fingerprint',
    async () => {
      const input = f.command(await f.context(admin, 'comment', originRoot.id));
      const blocker = await f.pool.connect();
      await blocker.query('BEGIN');
      await blocker.query(
        'SELECT id FROM whaleu_ratings.targets WHERE id=$1 FOR UPDATE',
        [originTarget.id],
      );
      const pending = f
        .remove(admin, 'comment', originRoot.id, input)
        .then((result) => result);
      try {
        await f.waitForLock(
          'SELECT id,revision,active,region_id FROM whaleu_ratings.targets',
        );
        // Canonical grant rows deliberately have no broad Safety writer gate.
        // The new row does not conflict with the already locked selected grant.
        await f.pool.query(
          "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'school_admin',$3,$2,'synthetic-added-during-deletion-wait')",
          [randomUUID(), admin.accountId, f.scope.foreign.regionId],
        );
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
      }
      const result = await pending;
      assert.equal(
        result.body.error?.code,
        'AUTHORIZATION_UNAVAILABLE',
        JSON.stringify(result.body),
      );
      assert.equal(await countRequest(input.clientRequestId), 0);
      assert.equal(
        (
          await f.pool.query(
            'SELECT deleted_at FROM whaleu_ratings.comments WHERE id=$1',
            [originRoot.id],
          )
        ).rows[0]!.deleted_at,
        null,
      );
    },
  );
  await t.test(
    'grant expiry after deferred constraint waits rolls back tentative audit/cause/transition/effect/receipt',
    async () => {
      const short = await f.actor();
      await f.grant(short, 'super_admin', null, new Date(Date.now() + 2000));
      const input = f.command(
        await f.context(short, 'comment', expiringRoot.id),
      );
      await f.pool.query(
        'CREATE FUNCTION whaleu_ratings.synthetic_deletion_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2.4); RETURN NULL; END $$; CREATE CONSTRAINT TRIGGER synthetic_deletion_wait AFTER INSERT ON whaleu_ratings.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.synthetic_deletion_wait()',
      );
      try {
        const started = Date.now();
        const denied = await f.remove(short, 'comment', expiringRoot.id, input);
        assert.ok(
          Date.now() - started >= 2300,
          'Actual deferred SQL wait must run',
        );
        assert.equal(
          denied.body.error?.code,
          'AUTHORIZATION_UNAVAILABLE',
          JSON.stringify(denied.body),
        );
        assert.equal(await countRequest(input.clientRequestId), 0);
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_ratings.admin_delete_audits WHERE request_id=$1',
              [input.clientRequestId],
            )
          ).rows[0]!.n,
          0,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_ratings.effect_events WHERE request_id=$1',
              [input.clientRequestId],
            )
          ).rows[0]!.n,
          0,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT deleted_at,admin_delete_audit_id FROM whaleu_ratings.comments WHERE id=$1',
              [expiringRoot.id],
            )
          ).rows[0]!.deleted_at,
          null,
        );
      } finally {
        await f.pool.query(
          'DROP TRIGGER synthetic_deletion_wait ON whaleu_ratings.requests; DROP FUNCTION whaleu_ratings.synthetic_deletion_wait()',
        );
      }
    },
  );
});

test('source activation and finite negative Safety coverage cannot cross deferred deletion waits', async (t) => {
  const f = await ratingDeletionFixture();
  t.after(() => f.close());
  const owner = await f.actor(),
    admin = await f.actor();
  await f.grant(admin, 'super_admin');
  const catalog = await f.catalog(owner, { count: 2 }),
    target = catalog.targets[0]!,
    otherTarget = catalog.targets[1]!;
  const root = await f.publish(owner, catalog, target),
    otherRoot = await f.publish(owner, catalog, otherTarget);
  const install = () =>
    f.pool.query(
      'CREATE FUNCTION whaleu_ratings.synthetic_deletion_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(2.4); RETURN NULL; END $$; CREATE CONSTRAINT TRIGGER synthetic_deletion_wait AFTER INSERT ON whaleu_ratings.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.synthetic_deletion_wait()',
    );
  const remove = () =>
    f.pool.query(
      'DROP TRIGGER synthetic_deletion_wait ON whaleu_ratings.requests; DROP FUNCTION whaleu_ratings.synthetic_deletion_wait()',
    );
  const absent = async (key: string, id: string) => {
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_ratings.requests WHERE request_id=$1',
          [key],
        )
      ).rows[0]!.n,
      0,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT deleted_at FROM whaleu_ratings.comments WHERE id=$1',
          [id],
        )
      ).rows[0]!.deleted_at,
      null,
    );
  };
  await t.test(
    'future source under a global grant becomes effective only at exact SQL time and invalidates tentative deletion',
    async () => {
      await f.origin(target.id, 'known_school', f.scope.home.campusId, {
        effectiveAt: new Date(Date.now() + 2000),
      });
      const input = f.command(await f.context(admin, 'comment', root.id));
      await install();
      try {
        const result = await f.remove(admin, 'comment', root.id, input);
        assert.equal(
          result.body.error?.code,
          'RATING_DELETION_AUTHORITY_UNAVAILABLE',
          JSON.stringify(result.body),
        );
        await absent(input.clientRequestId, root.id);
      } finally {
        await remove();
      }
    },
  );
  await t.test(
    'expired negative Safety evidence rolls back an otherwise terminal owner rejection',
    async () => {
      await withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          "UPDATE whaleu_safety.account_heads SET actions_allowed=false,valid_until=clock_timestamp()+interval '2 seconds' WHERE account_id=$1",
          [owner.accountId],
        ),
      );
      const key = randomUUID();
      await install();
      try {
        const result = await f
          .auth(
            request(f.http).delete(`/v1/ratings/comments/${otherRoot.id}`),
            owner,
          )
          .send({
            clientRequestId: key,
            regionId: null,
            targetId: otherTarget.id,
            expectedTargetRevision: otherTarget.revision,
            expectedRevision: otherRoot.revision,
          });
        assert.equal(
          result.body.error?.code,
          'SAFETY_UNAVAILABLE',
          JSON.stringify(result.body),
        );
        await absent(key, otherRoot.id);
      } finally {
        await remove();
      }
    },
  );
});
