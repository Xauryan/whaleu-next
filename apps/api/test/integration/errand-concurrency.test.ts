import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import request from 'supertest';
import type { Response } from 'supertest';
import {
  errandRuntimeFixture,
  seedErrandFeature,
  seedTemporaryErrandBase,
  syntheticErrandRestriction,
} from '../support/errand-runtime-fixture.js';
import { discoveryCursorBucket } from '../../src/community/discovery-cursors.js';
import {
  withCommunityScopeWriter,
  appendIdentitySelection,
} from '../support/community-scope-fixtures.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import {
  approveErrand,
  revokeErrandReview,
} from '../support/errand-review-fixtures.js';
function denied(r: Response, code?: string) {
  assert.ok(r.status >= 400, JSON.stringify(r.body));
  if (code) assert.equal(r.body.error?.code, code);
  assert.equal(r.headers['cache-control'], 'no-store');
  assert.equal(r.headers['vary'], 'Authorization');
}
test(
  'errand real-connection races, deferred deadline proofs, rollback and exact decimal continuations',
  { timeout: 120000 },
  async (t) => {
    const f = await errandRuntimeFixture();
    const count = async (table: string, where: string, value: string) =>
      Number(
        (
          await f.pool.query(
            `SELECT count(*)::int n FROM ${table} WHERE ${where}=$1`,
            [value],
          )
        ).rows[0].n,
      );
    try {
      await t.test(
        'N claims produce exactly one winner, one accepted event/notice and only winner remembered contacts',
        async () => {
          const p = await f.actor(),
            runners = await Promise.all(
              Array.from({ length: 8 }, () => f.actor()),
            ),
            order = await f.publish(p);
          const results = await Promise.all(
            runners.map((a, i) =>
              f.command(a, order.id, order.revision, 'accept', {
                contacts: { wechat: `runner_${i}`, phone: '' },
              }),
            ),
          );
          assert.equal(
            results.filter((r) => r.body.outcome === 'applied').length,
            1,
            JSON.stringify(results.map((r) => r.body)),
          );
          for (const r of results.filter((r) => r.body.outcome !== 'applied')) {
            assert.equal(r.body.outcome, 'rejected');
            assert.equal(r.body.code, 'ERRAND_REVISION_CONFLICT');
          }
          const winner = results.findIndex((r) => r.body.outcome === 'applied');
          assert.equal(
            await count(
              'whaleu_notifications.errand_notices',
              'order_id',
              order.id,
            ),
            1,
          );
          assert.equal(
            (
              await f.pool.query(
                "SELECT count(*)::int n FROM whaleu_errands.transitions WHERE order_id=$1 AND operation='accept'",
                [order.id],
              )
            ).rows[0].n,
            1,
          );
          for (const [i, a] of runners.entries())
            assert.equal(
              await count(
                'whaleu_errands.contact_history',
                'account_id',
                a.accountId,
              ),
              i === winner ? 1 : 0,
            );
        },
      );
      await t.test(
        'accept/cancel and accepted complete/cancel/delete races cannot overwrite a winner',
        async () => {
          for (const other of ['cancel', 'delete'] as const) {
            const p = await f.actor(),
              r = await f.actor(),
              o = await f.publish(p);
            const results = await Promise.all([
              f.command(r, o.id, o.revision, 'accept'),
              f.command(p, o.id, o.revision, other),
            ]);
            assert.equal(
              results.filter((x) => x.body.outcome === 'applied').length,
              1,
            );
          }
          for (const other of ['cancel', 'delete'] as const) {
            const p = await f.actor(),
              r = await f.actor(),
              o = await f.publish(p),
              a = await f.command(r, o.id, o.revision, 'accept');
            const results = await Promise.all([
              f.command(p, o.id, a.body.revision, 'complete'),
              f.command(p, o.id, a.body.revision, other),
            ]);
            assert.equal(
              results.filter((x) => x.body.outcome === 'applied').length,
              1,
            );
          }
        },
      );
      await t.test(
        'same command key replays once, different acceptance contacts conflict and failed notice rolls back every effect',
        async () => {
          const p = await f.actor(),
            r = await f.actor(),
            o = await f.publish(p),
            key = randomUUID();
          const results = await Promise.all(
            Array.from({ length: 6 }, () =>
              f.command(r, o.id, o.revision, 'accept', {
                clientRequestId: key,
              }),
            ),
          );
          for (const result of results)
            assert.deepEqual(result.body, results[0]!.body);
          denied(
            await f.command(r, o.id, o.revision, 'accept', {
              clientRequestId: key,
              contacts: { wechat: 'changed', phone: '' },
            }),
            'REQUEST_CONFLICT',
          );
          assert.equal(
            await count(
              'whaleu_notifications.errand_notices',
              'order_id',
              o.id,
            ),
            1,
          );
          const o2 = await f.publish(p),
            key2 = randomUUID();
          await f.pool.query(
            `CREATE FUNCTION whaleu_notifications.synthetic_notice_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Synthetic notice failure'; END $$; CREATE TRIGGER synthetic_notice_failure BEFORE INSERT ON whaleu_notifications.errand_notices FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.synthetic_notice_failure();`,
          );
          try {
            denied(
              await f.command(r, o2.id, o2.revision, 'accept', {
                clientRequestId: key2,
              }),
            );
            assert.equal((await f.detail(p, o2.id)).body.state, 'pending');
            assert.equal(
              await count('whaleu_errands.requests', 'request_id', key2),
              0,
            );
            assert.equal(
              await count(
                'whaleu_notifications.errand_notices',
                'order_id',
                o2.id,
              ),
              0,
            );
          } finally {
            await f.pool.query(
              'DROP TRIGGER synthetic_notice_failure ON whaleu_notifications.errand_notices; DROP FUNCTION whaleu_notifications.synthetic_notice_failure()',
            );
          }
          assert.equal(
            (
              await f.command(r, o2.id, o2.revision, 'accept', {
                clientRequestId: key2,
              })
            ).body.outcome,
            'applied',
          );
        },
      );
      await t.test(
        'temporary base expiry while waiting on order lock rolls back all effects and leaves request retryable',
        async () => {
          const p = await f.actor(),
            r = await f.actor({ affiliation: 'unverified', identity: false }),
            o = await f.publish(p),
            key = randomUUID();
          await seedTemporaryErrandBase(f.pool, r.accountId, {
            validUntil: new Date(Date.now() + 700),
          });
          const blocker = await f.pool.connect();
          try {
            await blocker.query('BEGIN');
            await blocker.query(
              'SELECT id FROM whaleu_errands.orders WHERE id=$1 FOR UPDATE',
              [o.id],
            );
            const pending = f
              .command(r, o.id, o.revision, 'accept', { clientRequestId: key })
              .then((x) => x);
            await f.waitForLock('whaleu_errands.orders WHERE id');
            await sleep(850);
            await blocker.query('COMMIT');
            denied(await pending, 'VERIFICATION_UNAVAILABLE');
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
          }
          assert.equal((await f.detail(p, o.id)).body.state, 'pending');
          assert.equal(
            await count('whaleu_errands.requests', 'request_id', key),
            0,
          );
          assert.equal(
            await count(
              'whaleu_errands.contact_history',
              'account_id',
              r.accountId,
            ),
            0,
          );
        },
      );
      await t.test(
        'phone deadline expires after last blocking cursor quota and no stale page or cursor commits',
        async () => {
          const p = await f.actor();
          await f.publish(p);
          await f.publish(p);
          const r = await f.actor({ expiresAt: new Date(Date.now() + 700) }),
            bucket = discoveryCursorBucket(r.accountId);
          const blocker = await f.pool.connect();
          try {
            await blocker.query('BEGIN');
            await blocker.query(
              'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
              [`whaleu:discovery:quota:v1:${bucket.hash}`],
            );
            const pending = f.list(r, { limit: 1 }).then((x) => x);
            await f.waitForLock('pg_advisory_xact_lock(hashtextextended');
            await sleep(850);
            await blocker.query('COMMIT');
            denied(await pending, 'VERIFICATION_UNAVAILABLE');
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
          }
          assert.equal(
            await count(
              'whaleu_community.discovery_cursors',
              'bucket_hash',
              bucket.hash,
            ),
            0,
          );
        },
      );
      await t.test(
        'terminal rejection rolls back provisional deadlines, while selected privileged grants expire through commit',
        async () => {
          const p = await f.actor(),
            r = await f.actor({ affiliation: 'unverified', identity: false }),
            o = await f.publish(p);
          await f.command(p, o.id, o.revision, 'cancel');
          await seedTemporaryErrandBase(f.pool, r.accountId, {
            validUntil: new Date(Date.now() + 700),
          });
          const blocker = await f.pool.connect();
          try {
            await blocker.query('BEGIN');
            await blocker.query(
              'SELECT id FROM whaleu_errands.orders WHERE id=$1 FOR UPDATE',
              [o.id],
            );
            const pending = f
              .command(r, o.id, o.revision, 'accept')
              .then((x) => x);
            await f.waitForLock('whaleu_errands.orders WHERE id');
            await sleep(850);
            await blocker.query('COMMIT');
            const result = await pending;
            assert.equal(result.status, 200);
            assert.equal(result.body.code, 'ERRAND_REVISION_CONFLICT');
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
          }
          const admin = await f.actor({
              affiliation: 'unverified',
              identity: false,
            }),
            o2 = await f.publish(p),
            key = randomUUID();
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference,expires_at) VALUES($1,$2,'school_admin',$3,$2,'Synthetic bounded grant',$4)",
              [
                randomUUID(),
                admin.accountId,
                f.scope.foreign.regionId,
                new Date(Date.now() + 700),
              ],
            ),
          );
          const wait = await f.pool.connect();
          try {
            await wait.query('BEGIN');
            await wait.query(
              'SELECT id FROM whaleu_errands.orders WHERE id=$1 FOR UPDATE',
              [o2.id],
            );
            const pending = f
              .command(admin, o2.id, o2.revision, 'accept', {
                clientRequestId: key,
              })
              .then((x) => x);
            await f.waitForLock('whaleu_errands.orders WHERE id');
            await sleep(850);
            await wait.query('COMMIT');
            denied(await pending, 'AUTHORIZATION_UNAVAILABLE');
          } finally {
            await wait.query('ROLLBACK');
            wait.release();
          }
          assert.equal(
            await count('whaleu_errands.requests', 'request_id', key),
            0,
          );
        },
      );
      await t.test(
        'exact review consumption expiry after deferred constraint waits rolls back publication, receipt, binding and transition',
        async () => {
          const p = await f.actor(),
            input = f.body();
          await approveErrand(f.pool, await f.envelope(p, input), {
            consumeUntil: new Date(Date.now() + 700),
          });
          await f.pool.query(
            'CREATE FUNCTION whaleu_errands.synthetic_deferred_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.85); RETURN NULL; END $$; CREATE CONSTRAINT TRIGGER synthetic_deferred_wait AFTER INSERT ON whaleu_errands.requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_errands.synthetic_deferred_wait();',
          );
          try {
            denied(
              await f.auth(request(f.http).post('/v1/errands'), p).send(input),
              'CONTENT_REVIEW_UNAVAILABLE',
            );
            assert.equal(
              await count(
                'whaleu_errands.requests',
                'request_id',
                input.clientRequestId,
              ),
              0,
            );
            assert.equal(
              await count('whaleu_errands.orders', 'publisher_id', p.accountId),
              0,
            );
            assert.equal(
              await count(
                'whaleu_community.errand_approval_bindings',
                'account_id',
                p.accountId,
              ),
              0,
            );
          } finally {
            await f.pool.query(
              'DROP TRIGGER synthetic_deferred_wait ON whaleu_errands.requests; DROP FUNCTION whaleu_errands.synthetic_deferred_wait()',
            );
          }
        },
      );
      await t.test(
        'fresh sanction writer gate serializes ahead of acceptance; missing/unknown feature facts never become permission',
        async () => {
          const p = await f.actor(),
            r = await f.actor(),
            o = await f.publish(p),
            writer = await f.pool.connect();
          try {
            await writer.query('BEGIN');
            await lockSafetyPolicy(writer, true);
            const id = randomUUID();
            await writer.query(
              `INSERT INTO whaleu_safety.errand_feature_snapshots(id,account_id,coverage,provenance,source_reference,policy_reference,effective_at,restrictions) VALUES($1,$2,'complete','accepted','synthetic','synthetic',clock_timestamp(),$3)`,
              [
                id,
                r.accountId,
                JSON.stringify([syntheticErrandRestriction('accept')]),
              ],
            );
            await writer.query(
              'UPDATE whaleu_safety.errand_feature_heads SET snapshot_id=$2 WHERE account_id=$1',
              [r.accountId, id],
            );
            const pending = f
              .command(r, o.id, o.revision, 'accept')
              .then((x) => x);
            await f.waitForLock('pg_advisory_xact_lock_shared');
            await writer.query('COMMIT');
            const result = await pending;
            assert.equal(result.body.code, 'ERRAND_ACTION_RESTRICTED');
          } finally {
            await writer.query('ROLLBACK');
            writer.release();
          }
          await seedErrandFeature(f.pool, r.accountId, [], {
            coverage: 'missing',
          });
          denied(
            await f.command(r, o.id, o.revision, 'accept'),
            'SAFETY_UNAVAILABLE',
          );
        },
      );
      await t.test(
        'reward keysets are exact in both directions, ties are stable, scope changes invalidate opaque continuations',
        async () => {
          const p = await f.actor(),
            other = await f.actor(),
            region = f.scope.foreign.regionId;
          const rewards = [
            '1',
            '1.000000000000000000000000000001',
            '1.000000000000000000000000000002',
            '2',
            '2',
            '499.999999999999999999999999999999',
            '500',
          ];
          const orders = [];
          for (const reward of rewards)
            orders.push(await f.publish(p, f.body(region, { reward })));
          for (const direction of ['asc', 'desc']) {
            const seen: string[] = [],
              seenRewards: string[] = [];
            let cursor: string | undefined;
            do {
              const result = await f.list(p, {
                regionId: region,
                sort: 'reward',
                direction,
                limit: 2,
                ...(cursor ? { cursor } : {}),
              });
              assert.equal(result.status, 200, JSON.stringify(result.body));
              seen.push(...result.body.items.map((r: { id: string }) => r.id));
              seenRewards.push(
                ...result.body.items.map((r: { reward: string }) => r.reward),
              );
              cursor = result.body.nextCursor ?? undefined;
            } while (cursor);
            assert.equal(new Set(seen).size, orders.length);
            assert.deepEqual(
              seenRewards,
              direction === 'asc' ? rewards : [...rewards].reverse(),
            );
          }
          const first = await f.list(p, { regionId: region, limit: 1 }),
            cursor = first.body.nextCursor;
          assert.equal(typeof cursor, 'string');
          assert.match(cursor, /^[A-Za-z0-9_-]{43}$/);
          for (const patch of [
            { regionId: f.scope.home.regionId },
            { limit: 2 },
            { filter: 'pending' },
            { sort: 'reward' },
            { direction: 'asc' },
          ])
            denied(
              await f.list(p, { regionId: region, limit: 1, cursor, ...patch }),
              'BAD_REQUEST',
            );
          denied(
            await f.list(other, { regionId: region, limit: 1, cursor }),
            'BAD_REQUEST',
          );
          await appendIdentitySelection(
            f.pool,
            p.accountId,
            p.facts,
            f.scope,
            f.scope.related.campusId,
          );
          denied(
            await f.list(p, { regionId: region, limit: 1, cursor }),
            'BAD_REQUEST',
          );
          const stored = await f.pool.query(
            'SELECT position FROM whaleu_community.discovery_cursors WHERE cursor=$1',
            [cursor],
          );
          const text = JSON.stringify(stored.rows[0]);
          for (const secret of [
            'privateText',
            'publisherContacts',
            'fixture_publisher',
            'Collect a synthetic parcel',
          ])
            assert.ok(!text.includes(secret));
        },
      );
      await t.test(
        'revoked sparse review visibility does not truncate own history or return unreviewed summaries',
        async () => {
          const p = await f.actor(),
            orders = [];
          for (let i = 0; i < 5; i++) orders.push(await f.publish(p));
          await revokeErrandReview(f.pool, orders[2]!.approval.decisionId);
          await revokeErrandReview(f.pool, orders[3]!.approval.decisionId);
          const ids: string[] = [];
          let cursor: string | undefined;
          do {
            const page = await f.own(p, 'published', {
              limit: 1,
              ...(cursor ? { cursor } : {}),
            });
            assert.equal(page.status, 200);
            ids.push(...page.body.items.map((r: { id: string }) => r.id));
            cursor = page.body.nextCursor ?? undefined;
          } while (cursor);
          assert.equal(ids.length, 3);
          assert.equal(new Set(ids).size, 3);
          assert.ok(!ids.includes(orders[2]!.id));
        },
      );
      await t.test(
        'database rejects untruthful receipts, deleted private snapshots, changed scopes, review rewrites and illegal edges',
        async () => {
          const p = await f.actor(),
            o = await f.publish(p);
          for (const [sql, args] of [
            [
              'DELETE FROM whaleu_errands.private_details WHERE order_id=$1',
              [o.id],
            ],
            [
              "UPDATE whaleu_errands.orders SET state='completed',revision=$2 WHERE id=$1",
              [o.id, randomUUID()],
            ],
            [
              'UPDATE whaleu_errands.orders SET source_region_id=$2,revision=$3 WHERE id=$1',
              [o.id, f.scope.related.regionId, randomUUID()],
            ],
            [
              'UPDATE whaleu_community.errand_approval_bindings SET scope=$2 WHERE order_id=$1',
              [o.id, '{}'],
            ],
            [
              'DELETE FROM whaleu_safety.errand_feature_heads WHERE account_id=$1',
              [p.accountId],
            ],
          ] as const)
            await assert.rejects(
              withCommunityScopeWriter(f.pool, (tx) =>
                tx.query(sql, [...args]),
              ),
            );
          await assert.rejects(
            withCommunityScopeWriter(f.pool, async (tx) => {
              const requestId = randomUUID(),
                revision = randomUUID();
              await tx.query(
                'INSERT INTO whaleu_errands.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4)',
                [p.accountId, requestId, 'complete', 'a'.repeat(64)],
              );
              await tx.query(
                'INSERT INTO whaleu_errands.transitions(id,order_id,actor_id,request_id,operation,prior_state,next_state,revision) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
                [
                  randomUUID(),
                  o.id,
                  p.accountId,
                  requestId,
                  'complete',
                  'accepted',
                  'completed',
                  revision,
                ],
              );
              await tx.query(
                'UPDATE whaleu_errands.requests SET receipt=$3 WHERE account_id=$1 AND request_id=$2',
                [
                  p.accountId,
                  requestId,
                  JSON.stringify({
                    requestId,
                    operation: 'complete',
                    outcome: 'applied',
                    orderId: o.id,
                    revision,
                    occurredAt: new Date().toISOString(),
                  }),
                ],
              );
            }),
          );
          const key = randomUUID();
          await assert.rejects(
            withCommunityScopeWriter(f.pool, (tx) =>
              tx.query(
                'INSERT INTO whaleu_errands.requests(account_id,request_id,operation,intent_hash,receipt) VALUES($1,$2,$3,$4,$5)',
                [
                  p.accountId,
                  key,
                  'accept',
                  'a'.repeat(64),
                  JSON.stringify({
                    requestId: key,
                    operation: 'accept',
                    outcome: 'applied',
                    orderId: o.id,
                    revision: o.revision,
                    occurredAt: new Date().toISOString(),
                  }),
                ],
              ),
            ),
          );
          await assert.rejects(
            withCommunityScopeWriter(f.pool, (tx) =>
              tx.query(
                'INSERT INTO whaleu_errands.requests(account_id,request_id,operation,intent_hash) VALUES($1,$2,$3,$4)',
                [p.accountId, randomUUID(), 'accept', 'a'.repeat(64)],
              ),
            ),
          );
        },
      );
    } finally {
      await f.close();
    }
  },
);
