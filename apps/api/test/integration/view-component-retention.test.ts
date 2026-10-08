import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ViewComponentCleanup } from '../../src/community/view-component/cleanup.js';
import { DatabaseService } from '../../src/database/database.js';
import {
  assertReceipt,
  reportIntent,
  syntheticEpoch,
  syntheticReceipt,
  viewFixture,
} from '../support/view-component-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { hold, release } from '../support/title-maintenance-fixture.js';
import { observeViewQueries } from '../support/view-component-fixture.js';

async function until(pool: import('pg').Pool, at: Date) {
  await pool.query(
    'SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM ($1::timestamptz-clock_timestamp())))+0.02)',
    [at],
  );
}

test(
  'view retention: capacity, immutable epochs, expiry fences and bounded concurrent cleanup on real PostgreSQL',
  { timeout: 180000 },
  async (t) => {
    const f = await viewFixture();
    const cleanup = f.app.get(ViewComponentCleanup);
    try {
      const author = await f.actor();
      await t.test(
        'concurrent hourly issuance recovers one descriptor without extending it; previous collection window still accepts',
        async () => {
          const actor = await f.actor();
          const first = await Promise.all(
            Array.from({ length: 6 }, () => f.issue(actor).expect(200)),
          );
          assert.equal(new Set(first.map((r) => r.body.epochId)).size, 1);
          const same = await f.epoch(actor);
          for (const key of [
            'epochId',
            'issuedAt',
            'collectionUntil',
            'expiresAt',
          ] as const)
            assert.equal(same[key], first[0]!.body[key]);
          const owner = await f.actor();
          const old = await syntheticEpoch(f.pool, owner.accountId, {
            expiresInMs: 23 * 3600000 - 100,
          });
          const current = await f.epoch(owner);
          assert.notEqual(current.epochId, old.epochId);
          const post = await f.publish(author),
            input = reportIntent(old.epochId, [post.id]);
          assertReceipt(
            (await f.report(owner, input).expect(200)).body,
            input,
            1,
          );
          const absent = reportIntent(randomUUID(), [post.id]);
          assert.equal(
            (await f.report(owner, absent).expect(410)).body.error.code,
            'VIEW_REPORTING_EPOCH_CLOSED',
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_post_hotness.view_reporting_epochs WHERE id=$1',
                [absent.epochId],
              )
            ).rowCount,
            0,
          );
          await f
            .issue(owner, { version: 1, epochId: old.epochId })
            .expect(400);
        },
      );
      await t.test(
        '25 live epochs is a cross-request bound; expired epochs are never resurrected',
        async () => {
          const actor = await f.actor();
          for (let i = 0; i < 25; i++)
            await syntheticEpoch(f.pool, actor.accountId);
          const blocked = await f.issue(actor).expect(429);
          assert.equal(blocked.body.error.code, 'RATE_LIMITED');
          assert.ok(blocked.headers['retry-after']);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_post_hotness.view_reporting_epochs WHERE account_id=$1',
                [actor.accountId],
              )
            ).rowCount,
            25,
          );
          const expired = await syntheticEpoch(f.pool, actor.accountId, {
            expiresInMs: -10,
          });
          const closed = reportIntent(expired.epochId, [randomUUID()]);
          await f.report(actor, closed).expect(410);
          await cleanup.run();
          await f.report(actor, closed).expect(410);
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_post_hotness.view_reporting_epochs WHERE id=$1',
                [expired.epochId],
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'receipt and event capacity includes zeroes; rollback consumes none and replay bypasses exhausted business capacity',
        async () => {
          const actor = await f.actor(),
            epoch = await syntheticEpoch(f.pool, actor.accountId, {
              batchCount: 2047,
              eventCount: 2047,
            });
          const zero = reportIntent(epoch.epochId, [randomUUID()]);
          assertReceipt(
            (await f.report(actor, zero).expect(200)).body,
            zero,
            0,
          );
          assert.deepEqual(await f.counters(epoch.epochId), {
            batch_count: 2048,
            event_count: 2048,
          });
          assertReceipt(
            (await f.report(actor, zero).expect(200)).body,
            zero,
            0,
          );
          await f
            .report(actor, reportIntent(epoch.epochId, [randomUUID()]))
            .expect(429);
          assert.deepEqual(await f.counters(epoch.epochId), {
            batch_count: 2048,
            event_count: 2048,
          });
          const reader = await f.actor(),
            limited = await syntheticEpoch(f.pool, reader.accountId, {
              batchCount: 400,
              eventCount: 19999,
            });
          const overflow = reportIntent(limited.epochId, [
            randomUUID(),
            randomUUID(),
          ]);
          await f.report(reader, overflow).expect(429);
          assert.deepEqual(await f.counters(limited.epochId), {
            batch_count: 400,
            event_count: 19999,
          });
          assert.equal((await f.receipts(limited.epochId)).length, 0);
          const last = reportIntent(limited.epochId, [randomUUID()]);
          assertReceipt(
            (await f.report(reader, last).expect(200)).body,
            last,
            0,
          );
          assertReceipt(
            (await f.report(reader, last).expect(200)).body,
            last,
            0,
          );
          await f
            .report(reader, reportIntent(limited.epochId, [randomUUID()]))
            .expect(429);
        },
      );
      await t.test(
        'cooldown just before and at/past its actual database boundary neither extends nor suppresses list views',
        async () => {
          const actor = await f.actor(),
            epoch = await f.epoch(actor),
            post = await f.publish(author);
          const boundary = await withCommunityScopeWriter(
            f.pool,
            async (tx) =>
              (
                await tx.query<{ next_allowed_at: Date }>(
                  "INSERT INTO whaleu_post_hotness.view_detail_cooldowns(account_id,post_id,next_allowed_at) VALUES($1,$2,date_trunc('milliseconds',clock_timestamp())+interval '600 milliseconds') RETURNING next_allowed_at",
                  [actor.accountId, post.id],
                )
              ).rows[0]!.next_allowed_at,
          );
          const detail = reportIntent(epoch.epochId, [post.id], 'detail_visit');
          assertReceipt(
            (await f.report(actor, detail).expect(200)).body,
            detail,
            0,
          );
          const list = reportIntent(epoch.epochId, [post.id]);
          assertReceipt(
            (await f.report(actor, list).expect(200)).body,
            list,
            1,
          );
          assert.deepEqual(
            (
              await f.pool.query(
                'SELECT next_allowed_at FROM whaleu_post_hotness.view_detail_cooldowns WHERE account_id=$1 AND post_id=$2',
                [actor.accountId, post.id],
              )
            ).rows[0]!.next_allowed_at,
            boundary,
          );
          await until(f.pool, boundary);
          const next = reportIntent(epoch.epochId, [post.id], 'detail_visit');
          assertReceipt(
            (await f.report(actor, next).expect(200)).body,
            next,
            1,
          );
          assert.equal(await f.count(post.id), '2');
          assertReceipt(
            (await f.report(actor, detail).expect(200)).body,
            detail,
            0,
          );
        },
      );
      await t.test(
        'expiry before/after epoch lock and conservative admission guard never create receipt or effects',
        async () => {
          const actor = await f.actor(),
            post = await f.publish(author);
          const near = await syntheticEpoch(f.pool, actor.accountId, {
            expiresInMs: 700,
          });
          const input = reportIntent(near.epochId, [post.id]);
          const guard = await f.report(actor, input).expect(503);
          assert.equal(guard.body.error.code, 'VIEW_REPORTING_UNAVAILABLE');
          let held = await hold(
            f.pool,
            'SELECT id FROM whaleu_post_hotness.view_reporting_epochs WHERE id=$1 FOR UPDATE',
            [near.epochId],
          );
          const waiting = f.report(actor, input).then((r) => r);
          try {
            await f.waitForLock('view_reporting_epochs');
            await until(f.pool, near.expiresAt);
            await release(held);
            held = undefined!;
            assert.equal((await waiting).status, 410);
          } finally {
            await release(held);
            await waiting;
          }
          assert.equal((await f.receipts(near.epochId)).length, 0);
          assert.equal(await f.count(post.id), '0');
          await f.report(actor, input).expect(410);
        },
      );
      await t.test(
        'live replay expires after a real deferred-constraint wait; cleanup skips its held epoch until transaction resolves',
        async () => {
          const actor = await f.actor(),
            post = await f.publish(author);
          const epoch = await syntheticEpoch(f.pool, actor.accountId, {
            expiresInMs: 800,
          });
          const input = reportIntent(epoch.epochId, [post.id]);
          await withCommunityScopeWriter(f.pool, (tx) =>
            syntheticReceipt(tx, epoch.epochId, input, 0),
          );
          // Add only a synthetic deferred wait. Every production query, timestamp,
          // visibility policy and final transaction deadline remains unmodified.
          await f.pool.query(
            'CREATE TABLE whaleu_maintenance_test.view_deferred_pause(id integer); CREATE FUNCTION whaleu_maintenance_test.view_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(72525,91); RETURN NEW; END $$; CREATE CONSTRAINT TRIGGER view_pause AFTER INSERT ON whaleu_maintenance_test.view_deferred_pause DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_maintenance_test.view_pause()',
          );
          let held = await hold(
            f.pool,
            'SELECT pg_advisory_xact_lock(72525,91)',
          );
          const observer = observeViewQueries(f.app);
          let fired = false;
          observer.setHook(async (event, tx) => {
            if (
              !fired &&
              event.sql.includes(
                'SELECT kind,payload_fingerprint,accepted_count FROM whaleu_post_hotness.view_report_receipts',
              )
            ) {
              fired = true;
              await tx.query(
                'INSERT INTO whaleu_maintenance_test.view_deferred_pause VALUES(1)',
              );
            }
          });
          const waiting = f.report(actor, input).then((r) => r);
          try {
            await Promise.race([
              f.waitForLock('SET CONSTRAINTS'),
              waiting.then((result) =>
                assert.fail(
                  `Replay completed before deferred barrier: fired=${fired}, status=${result.status}, body=${JSON.stringify(result.body)}`,
                ),
              ),
            ]);
            await until(f.pool, epoch.expiresAt);
            await cleanup.run();
            assert.equal(
              (await f.receipts(epoch.epochId)).length,
              1,
              'A locked expired epoch retains its original evidence until resolution',
            );
            await release(held);
            held = undefined!;
            const result = await waiting;
            assert.equal(result.status, 410, JSON.stringify(result.body));
            assert.equal(result.body.error.code, 'VIEW_REPORTING_EPOCH_CLOSED');
            assert.equal(fired, true);
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_maintenance_test.view_deferred_pause',
                )
              ).rowCount,
              0,
              'Final deadline failure rolls back the deferred transaction',
            );
            assert.equal(await f.count(post.id), '0');
          } finally {
            observer.restore();
            await release(held);
            await waiting;
            await f.pool.query(
              'DROP TABLE whaleu_maintenance_test.view_deferred_pause; DROP FUNCTION whaleu_maintenance_test.view_pause()',
            );
          }
          await cleanup.run();
          assert.equal((await f.receipts(epoch.epochId)).length, 0);
          await f.report(actor, input).expect(410);
        },
      );
      await t.test(
        'cleanup locks/skips live or busy state, bounds child+parent deletions and preserves every aggregate',
        async () => {
          const actor = await f.actor(),
            live = await f.epoch(actor),
            post = await f.publish(author);
          const input = reportIntent(live.epochId, [post.id, post.id]);
          await f.report(actor, input).expect(200);
          const old = await syntheticEpoch(f.pool, actor.accountId, {
            expiresInMs: 500,
          });
          await withCommunityScopeWriter(f.pool, async (tx) => {
            await tx.query(
              "INSERT INTO whaleu_post_hotness.view_report_receipts(epoch_id,batch_id,kind,payload_fingerprint,accepted_count) SELECT $1,gen_random_uuid(),'list_exposure',repeat('a',64),0 FROM generate_series(1,510)",
              [old.epochId],
            );
            await tx.query(
              "INSERT INTO whaleu_post_hotness.view_detail_cooldowns(account_id,post_id,next_allowed_at) VALUES($1,$2,clock_timestamp()-interval '1 second')",
              [actor.accountId, post.id],
            );
          });
          await until(f.pool, old.expiresAt);
          const held = await hold(
            f.pool,
            'SELECT id FROM whaleu_post_hotness.view_reporting_epochs WHERE id=$1 FOR UPDATE',
            [old.epochId],
          );
          const cooldown = await hold(
            f.pool,
            'SELECT post_id FROM whaleu_post_hotness.view_detail_cooldowns WHERE account_id=$1 AND post_id=$2 FOR UPDATE',
            [actor.accountId, post.id],
          );
          try {
            await cleanup.run();
            assert.equal((await f.receipts(old.epochId)).length, 510);
            assert.equal((await f.receipts(live.epochId)).length, 1);
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_post_hotness.view_detail_cooldowns WHERE account_id=$1 AND post_id=$2',
                  [actor.accountId, post.id],
                )
              ).rowCount,
              1,
            );
          } finally {
            await release(held);
            await release(cooldown);
          }
          const database = f.app.get(DatabaseService),
            original = database.transaction.bind(database),
            sizes: number[] = [];
          database.transaction = async (operation, options) =>
            original(async (tx) => {
              const result = await operation(tx);
              if (
                result &&
                typeof result === 'object' &&
                'epochs' in result &&
                'receipts' in result &&
                'detailWindows' in result
              )
                sizes.push(
                  Number(result.epochs) +
                    Number(result.receipts) +
                    Number(result.detailWindows),
                );
              return result;
            }, options);
          let summary;
          try {
            summary = await cleanup.run();
          } finally {
            database.transaction = original;
          }
          assert.ok(sizes.length >= 2);
          assert.ok(
            sizes.every((size) => size <= 256),
            JSON.stringify(sizes),
          );
          assert.equal(summary.receipts, 510);
          assert.equal(summary.epochs, 1);
          assert.equal(summary.detailWindows, 1);
          assert.equal((await f.receipts(old.epochId)).length, 0);
          assert.equal((await f.receipts(live.epochId)).length, 1);
          assert.equal(await f.count(post.id), '2');
          assertReceipt(
            (await f.report(actor, input).expect(200)).body,
            input,
            2,
          );
        },
      );
      await t.test(
        'overdue retention fails closed for first-seen work, permits original live replay and recovers after cleanup',
        async () => {
          const actor = await f.actor(),
            epoch = await f.epoch(actor),
            post = await f.publish(author);
          const prior = reportIntent(epoch.epochId, [post.id]);
          await f.report(actor, prior).expect(200);
          await syntheticEpoch(f.pool, actor.accountId, {
            expiresInMs: -121000,
          });
          const fresh = reportIntent(epoch.epochId, [post.id]);
          await f.report(actor, fresh).expect(503);
          assertReceipt(
            (await f.report(actor, prior).expect(200)).body,
            prior,
            1,
          );
          assert.equal((await f.receipts(epoch.epochId)).length, 1);
          await cleanup.run();
          assertReceipt(
            (await f.report(actor, fresh).expect(200)).body,
            fresh,
            1,
          );
          assert.equal(await f.count(post.id), '2');
        },
      );
    } finally {
      await f.close();
    }
  },
);
