import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import request from 'supertest';
import {
  errandRuntimeFixture,
  seedErrandFeature,
  syntheticErrandRestriction,
} from '../support/errand-runtime-fixture.js';
import { discoveryCursorBucket } from '../../src/community/discovery-cursors.js';
const duration = { kind: 'finite', unit: 'days', value: 7 };
test(
  'E2B actual HTTP final-role rollback, exclusive writer contention, temporal history and profile proofs',
  { timeout: 120000 },
  async (t) => {
    const f = await errandRuntimeFixture();
    type Actor = Awaited<ReturnType<typeof f.actor>>;
    const grant = async (a: Actor, expiry: Date | null = null) => {
      await f.pool.query(
        "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference,expires_at) VALUES($1,$2,'super_admin',NULL,$2,'Synthetic atomicity test',$3)",
        [randomUUID(), a.accountId, expiry],
      );
    };
    const profile = async (a: Actor) => {
      await f.pool.query(
        "INSERT INTO whaleu_profile.profiles(account_id,nickname) VALUES($1,'PublicName')",
        [a.accountId],
      );
      return (
        await f.pool.query(
          'SELECT public_id FROM whaleu_profile.profiles WHERE account_id=$1',
          [a.accountId],
        )
      ).rows[0].public_id as string;
    };
    const deletion = (
      a: Actor,
      order: { id: string; revision: string },
      requestId: string,
    ) =>
      f
        .auth(request(f.http).post(`/v1/admin/errands/${order.id}/delete`), a)
        .send({
          clientRequestId: requestId,
          expectedRevision: order.revision,
          deleteReason: 'Atomic reason',
          publisherRestriction: duration,
        });
    const issue = (a: Actor, targetProfileId: string) =>
      f.auth(request(f.http).post('/v1/admin/errand-restrictions'), a).send({
        clientRequestId: randomUUID(),
        targetProfileId,
        action: 'accept',
        reason: 'Known local fact',
        duration: { kind: 'permanent' },
      });
    const get = (a: Actor, path: string) =>
      f.auth(request(f.http).get(path), a);
    try {
      await t.test(
        'direct target role inserted after tentative combined writes rolls back every effect and same key remains retryable',
        async () => {
          const admin = await f.actor(),
            p = await f.actor();
          await grant(admin);
          const order = await f.publish(p),
            key = randomUUID();
          const head = (
            await f.pool.query(
              'SELECT snapshot_id FROM whaleu_safety.errand_feature_heads WHERE account_id=$1',
              [p.accountId],
            )
          ).rows[0].snapshot_id;
          const blocker = await f.pool.connect();
          try {
            await blocker.query('BEGIN');
            await blocker.query(
              'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
              [`whaleu:errand-notices:${p.accountId}`],
            );
            const pending = deletion(admin, order, key).then((r) => r);
            await f.waitForLock('pg_advisory_xact_lock(hashtextextended');
            await grant(p);
            await blocker.query('COMMIT');
            const response = await pending;
            assert.equal(response.status, 503, JSON.stringify(response.body));
            assert.equal(response.body.error.code, 'AUTHORIZATION_UNAVAILABLE');
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
          }
          const row = (
            await f.pool.query(
              'SELECT revision,deleted_at FROM whaleu_errands.orders WHERE id=$1',
              [order.id],
            )
          ).rows[0];
          assert.equal(row.revision, order.revision);
          assert.equal(row.deleted_at, null);
          assert.equal(
            (
              await f.pool.query(
                'SELECT snapshot_id FROM whaleu_safety.errand_feature_heads WHERE account_id=$1',
                [p.accountId],
              )
            ).rows[0].snapshot_id,
            head,
          );
          for (const table of [
            'whaleu_errands.requests',
            'whaleu_errands.admin_events',
            'whaleu_safety.errand_restriction_commands',
          ]) {
            const actor = table.endsWith('requests')
              ? 'account_id'
              : 'actor_id';
            assert.equal(
              (
                await f.pool.query(
                  `SELECT count(*)::int n FROM ${table} WHERE ${actor}=$1 AND request_id=$2`,
                  [admin.accountId, key],
                )
              ).rows[0].n,
              0,
            );
          }
          assert.equal(
            (await get(p, '/v1/me/errand-notices')).body.items.length,
            0,
          );
          const retry = await deletion(admin, order, key);
          assert.equal(retry.status, 200);
          assert.equal(retry.body.code, 'ERRAND_RESTRICTION_TARGET_PROTECTED');
        },
      );
      await t.test(
        'selected actor authority expiring during late notice lock cannot commit deletion or restriction',
        async () => {
          const admin = await f.actor(),
            p = await f.actor();
          const order = await f.publish(p);
          await grant(admin, new Date(Date.now() + 650));
          const blocker = await f.pool.connect();
          try {
            await blocker.query('BEGIN');
            await blocker.query(
              'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
              [`whaleu:errand-notices:${p.accountId}`],
            );
            const pending = deletion(admin, order, randomUUID()).then((r) => r);
            await f.waitForLock('pg_advisory_xact_lock(hashtextextended');
            await sleep(700);
            await blocker.query('COMMIT');
            const response = await pending;
            assert.equal(response.status, 503, JSON.stringify(response.body));
            assert.equal(response.body.error.code, 'AUTHORIZATION_UNAVAILABLE');
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
          }
          assert.equal(
            (
              await f.pool.query(
                'SELECT deleted_at FROM whaleu_errands.orders WHERE id=$1',
                [order.id],
              )
            ).rows[0].deleted_at,
            null,
          );
        },
      );
      await t.test(
        'external target account lock followed by Safety request causes bounded atomic abort instead of a grant-writer protocol',
        async () => {
          const admin = await f.actor(),
            p = await f.actor();
          await grant(admin);
          const order = await f.publish(p),
            blocker = await f.pool.connect();
          try {
            await blocker.query('BEGIN');
            await blocker.query(
              'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR UPDATE',
              [p.accountId],
            );
            const pending = deletion(admin, order, randomUUID()).then((r) => r);
            await f.waitForLock('INSERT INTO whaleu_safety.errand_restriction');
            const writerGate = blocker.query(
              "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0))",
            );
            const response = await pending;
            assert.equal(response.status, 503, JSON.stringify(response.body));
            await writerGate;
            await blocker.query('COMMIT');
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
          }
          assert.equal(
            (
              await f.pool.query(
                'SELECT deleted_at FROM whaleu_errands.orders WHERE id=$1',
                [order.id],
              )
            ).rows[0].deleted_at,
            null,
          );
        },
      );
      await t.test(
        'expired initially empty query retains future active horizon through a blocked source read and fresh query changes without writes',
        async () => {
          const admin = await f.actor(),
            p = await f.actor();
          await grant(admin);
          const targetProfileId = await profile(p);
          const endsAt = new Date(Date.now() + 1800);
          await seedErrandFeature(f.pool, p.accountId, [
            syntheticErrandRestriction('publish', { endsAt }),
          ]);
          const seeded = await issue(admin, targetProfileId);
          assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
          assert.equal(seeded.body.outcome, 'applied');
          const blocker = await f.pool.connect();
          try {
            await blocker.query('BEGIN');
            await blocker.query(
              'LOCK TABLE whaleu_safety.errand_restriction_definitions IN ACCESS EXCLUSIVE MODE',
            );
            const pending = get(admin, '/v1/admin/errand-restrictions')
              .query({ targetProfileId, state: 'expired' })
              .then((r) => r);
            await f.waitForLock('min(d.ends_at)');
            await sleep(Math.max(0, endsAt.getTime() - Date.now() + 30));
            await blocker.query('COMMIT');
            const stale = await pending;
            assert.equal(stale.status, 409, JSON.stringify(stale.body));
            assert.equal(stale.body.error.code, 'DISCOVERY_RESTART_REQUIRED');
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
          }
          const fresh = await get(admin, '/v1/admin/errand-restrictions').query(
            { targetProfileId, state: 'expired' },
          );
          assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
          assert.equal(fresh.body.items.length, 1);
          assert.deepEqual(fresh.body.recordedTotal, {
            status: 'known',
            value: '1',
          });
        },
      );
      await t.test(
        'late Profile change invalidates global public projection; source event change invalidates continuation',
        async () => {
          const admin = await f.actor(),
            p = await f.actor();
          await grant(admin);
          const targetProfileId = await profile(p);
          let first = await issue(admin, targetProfileId);
          assert.equal(first.status, 200, JSON.stringify(first.body));
          first = await issue(admin, targetProfileId);
          assert.equal(first.status, 200, JSON.stringify(first.body));
          const blocker = await f.pool.connect();
          try {
            await blocker.query('BEGIN');
            await blocker.query(
              'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
              [
                `whaleu:discovery:quota:v1:${discoveryCursorBucket(admin.accountId).hash}`,
              ],
            );
            // No target filter here: its ordinary resolver deliberately holds that exact profile row.
            const pending = get(admin, '/v1/admin/errand-restrictions')
              .query({ limit: 1 })
              .then((r) => r);
            await f.waitForLock('pg_advisory_xact_lock(hashtextextended');
            await f.pool.query(
              "UPDATE whaleu_profile.profiles SET nickname='ChangedPublic' WHERE account_id=$1",
              [p.accountId],
            );
            await blocker.query('COMMIT');
            const stale = await pending;
            assert.equal(stale.status, 503, JSON.stringify(stale.body));
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
          }
          const page = await get(admin, '/v1/admin/errand-restrictions').query({
            targetProfileId,
            limit: 1,
          });
          assert.equal(page.status, 200, JSON.stringify(page.body));
          assert.ok(page.body.nextCursor);
          const changed = await issue(admin, targetProfileId);
          assert.equal(changed.status, 200, JSON.stringify(changed.body));
          const next = await get(admin, '/v1/admin/errand-restrictions').query({
            targetProfileId,
            limit: 1,
            cursor: page.body.nextCursor,
          });
          assert.equal(next.body.error.code, 'DISCOVERY_RESTART_REQUIRED');
        },
      );

      await t.test(
        'notice and terminal receipt faults roll back the complete command and the original key can recover',
        async () => {
          const admin = await f.actor();
          await grant(admin);
          for (const stage of ['notice', 'receipt']) {
            const p = await f.actor(),
              order = await f.publish(p),
              key = randomUUID();
            const head = (
              await f.pool.query(
                'SELECT snapshot_id FROM whaleu_safety.errand_feature_heads WHERE account_id=$1',
                [p.accountId],
              )
            ).rows[0].snapshot_id;
            const table =
              stage === 'notice'
                ? 'whaleu_notifications.errand_feature_notices'
                : 'whaleu_errands.requests';
            await f.pool.query(
              `CREATE FUNCTION whaleu_errands.synthetic_admin_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic atomic failure' USING ERRCODE='23514'; END $$`,
            );
            await f.pool.query(
              `CREATE TRIGGER synthetic_admin_failure BEFORE ${stage === 'notice' ? 'INSERT' : 'UPDATE'} ON ${table} FOR EACH ROW EXECUTE FUNCTION whaleu_errands.synthetic_admin_failure()`,
            );
            try {
              const failed = await deletion(admin, order, key);
              assert.equal(failed.status, 503, JSON.stringify(failed.body));
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT deleted_at FROM whaleu_errands.orders WHERE id=$1',
                    [order.id],
                  )
                ).rows[0].deleted_at,
                null,
              );
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT snapshot_id FROM whaleu_safety.errand_feature_heads WHERE account_id=$1',
                    [p.accountId],
                  )
                ).rows[0].snapshot_id,
                head,
              );
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT count(*)::int n FROM whaleu_safety.errand_restriction_definitions WHERE subject_id=$1',
                    [p.accountId],
                  )
                ).rows[0].n,
                0,
              );
              assert.equal(
                (
                  await f.pool.query(
                    'SELECT count(*)::int n FROM whaleu_errands.requests WHERE account_id=$1 AND request_id=$2',
                    [admin.accountId, key],
                  )
                ).rows[0].n,
                0,
              );
              assert.equal(
                (await get(p, '/v1/me/errand-notices')).body.items.length,
                0,
              );
            } finally {
              await f.pool.query(
                `DROP TRIGGER synthetic_admin_failure ON ${table}`,
              );
              await f.pool.query(
                'DROP FUNCTION whaleu_errands.synthetic_admin_failure()',
              );
            }
            const recovered = await deletion(admin, order, key);
            assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
            assert.equal(recovered.body.outcome, 'applied');
            const replay = await deletion(admin, order, key);
            assert.deepEqual(replay.body, recovered.body);
            assert.equal(
              (await get(p, '/v1/me/errand-notices')).body.items.length,
              2,
            );
          }
        },
      );
      await t.test(
        'multiple administrators, release versus replacement, and E1 lifecycle competitors serialize without lost effects',
        async () => {
          const admins = await Promise.all(
            Array.from({ length: 4 }, () => f.actor()),
          );
          for (const admin of admins) await grant(admin);
          const p = await f.actor(),
            order = await f.publish(p);
          const deletions = await Promise.all(
            admins.map((admin) =>
              f
                .auth(
                  request(f.http).post(`/v1/admin/errands/${order.id}/delete`),
                  admin,
                )
                .send({
                  clientRequestId: randomUUID(),
                  expectedRevision: order.revision,
                  deleteReason: '',
                }),
            ),
          );
          assert.equal(
            deletions.filter((r) => r.body.outcome === 'applied').length,
            1,
          );
          assert.equal(
            deletions.filter(
              (r) =>
                r.body.outcome === 'rejected' &&
                r.body.code === 'ERRAND_REVISION_CONFLICT',
            ).length,
            3,
          );
          const subject = await f.actor(),
            targetProfileId = await profile(subject);
          const old = await issue(admins[0]!, targetProfileId);
          assert.equal(old.body.outcome, 'applied');
          const [replacement, released] = await Promise.all([
            issue(admins[1]!, targetProfileId),
            f
              .auth(
                request(f.http).post(
                  `/v1/admin/errand-restrictions/${old.body.restrictionId}/release`,
                ),
                admins[2]!,
              )
              .send({
                clientRequestId: randomUUID(),
                reason: 'Concurrent release',
              }),
          ]);
          assert.equal(
            replacement.body.outcome,
            'applied',
            JSON.stringify(replacement.body),
          );
          assert.ok(
            released.body.outcome === 'applied' ||
              released.body.code === 'ERRAND_RESTRICTION_NOT_ACTIVE',
            JSON.stringify(released.body),
          );
          const active = await get(
            admins[0]!,
            '/v1/admin/errand-restrictions',
          ).query({ targetProfileId, state: 'active' });
          assert.equal(active.body.items.length, 1);
          assert.equal(
            active.body.items[0].restrictionId,
            replacement.body.restrictionId,
          );
          const runner = await f.actor(),
            pending = await f.publish(p);
          const [accepted, deleted] = await Promise.all([
            f.command(runner, pending.id, pending.revision, 'accept'),
            f
              .auth(
                request(f.http).post(`/v1/admin/errands/${pending.id}/delete`),
                admins[0]!,
              )
              .send({
                clientRequestId: randomUUID(),
                expectedRevision: pending.revision,
                deleteReason: '',
              }),
          ]);
          assert.equal(
            [accepted, deleted].filter((r) => r.body.outcome === 'applied')
              .length,
            1,
          );
          const acceptedOrder = await f.publish(p),
            claim = await f.command(
              runner,
              acceptedOrder.id,
              acceptedOrder.revision,
              'accept',
            );
          assert.equal(claim.body.outcome, 'applied');
          const [cancelled, restricted] = await Promise.all([
            f.command(p, acceptedOrder.id, claim.body.revision, 'cancel'),
            f
              .auth(
                request(f.http).post(
                  `/v1/admin/errands/${acceptedOrder.id}/restrict-accepter`,
                ),
                admins[0]!,
              )
              .send({
                clientRequestId: randomUUID(),
                expectedRevision: claim.body.revision,
                reason: 'Concurrent restriction',
                duration,
              }),
          ]);
          assert.equal(cancelled.body.outcome, 'applied');
          assert.ok(
            restricted.body.outcome === 'applied' ||
              restricted.body.code === 'ERRAND_REVISION_CONFLICT',
            JSON.stringify(restricted.body),
          );
          if (restricted.body.outcome === 'applied')
            assert.equal(restricted.body.revision, claim.body.revision);
        },
      );
      await t.test(
        'public profile reference reassignment changes opaque cursor subject scope even without any Safety mutation',
        async () => {
          const admin = await f.actor(),
            a = await f.actor(),
            b = await f.actor();
          await grant(admin);
          const publicA = await profile(a),
            publicB = await profile(b);
          await issue(admin, publicA);
          await issue(admin, publicA);
          const bIssue = await issue(admin, publicB);
          assert.equal(bIssue.body.outcome, 'applied');
          const first = await get(admin, '/v1/admin/errand-restrictions').query(
            { targetProfileId: publicA, limit: 1 },
          );
          assert.equal(first.status, 200, JSON.stringify(first.body));
          assert.ok(first.body.nextCursor);
          const before = (
            await f.pool.query(
              'SELECT max(sequence)::text version FROM whaleu_safety.errand_restriction_events',
            )
          ).rows[0].version;
          const tx = await f.pool.connect();
          try {
            await tx.query('BEGIN');
            await tx.query(
              'UPDATE whaleu_profile.profiles SET public_id=$2 WHERE account_id=$1',
              [a.accountId, randomUUID()],
            );
            await tx.query(
              'UPDATE whaleu_profile.profiles SET public_id=$2 WHERE account_id=$1',
              [b.accountId, publicA],
            );
            await tx.query(
              'UPDATE whaleu_profile.profiles SET public_id=$2 WHERE account_id=$1',
              [a.accountId, publicB],
            );
            await tx.query('COMMIT');
          } finally {
            await tx.query('ROLLBACK');
            tx.release();
          }
          assert.equal(
            (
              await f.pool.query(
                'SELECT max(sequence)::text version FROM whaleu_safety.errand_restriction_events',
              )
            ).rows[0].version,
            before,
          );
          const next = await get(admin, '/v1/admin/errand-restrictions').query({
            targetProfileId: publicA,
            limit: 1,
            cursor: first.body.nextCursor,
          });
          assert.equal(next.body.error.code, 'DISCOVERY_RESTART_REQUIRED');
          const fresh = await get(admin, '/v1/admin/errand-restrictions').query(
            { targetProfileId: publicA, limit: 1 },
          );
          assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
          assert.equal(
            fresh.body.items[0].restrictionId,
            bIssue.body.restrictionId,
          );
        },
      );
    } finally {
      await f.close();
    }
  },
);
