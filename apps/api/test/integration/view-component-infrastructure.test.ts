import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { Test } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
import { AppModule } from '../../src/app.module.js';
import { APP_CONFIG } from '../../src/config/config.js';
import type { RuntimeConfig } from '../../src/config/config.js';
import { DatabaseService } from '../../src/database/database.js';
import { PostgresThrottlerStorage } from '../../src/request-throttling/postgres-storage.js';
import { ViewRetentionRunner } from '../../src/community/view-component/retention-runner.js';
import { ViewComponentCleanup } from '../../src/community/view-component/cleanup.js';
import {
  reportIntent,
  syntheticEpoch,
  viewFixture,
} from '../support/view-component-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { hold, release } from '../support/title-maintenance-fixture.js';
import { observeViewQueries } from '../support/view-component-fixture.js';

const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

test(
  'view infrastructure: distributed committed attempts and official no-traffic retention lifecycle on PostgreSQL',
  { timeout: 120000 },
  async (t) => {
    const f = await viewFixture();
    let httpApp: import('@nestjs/common').INestApplication | undefined;
    try {
      const database = f.app.get(DatabaseService),
        one = f.app.get(PostgresThrottlerStorage),
        two = new PostgresThrottlerStorage(database);
      await t.test(
        'independent adapter instances share one exact concurrent budget and nonextending block',
        async () => {
          const key = randomUUID(),
            name = 'synthetic-view-storage';
          const results = await Promise.all(
            Array.from({ length: 12 }, (_, i) =>
              (i % 2 ? one : two).increment(key, 60000, 10, 60000, name),
            ),
          );
          assert.equal(
            results.filter((result) => !result.isBlocked).length,
            10,
          );
          assert.deepEqual(
            results
              .filter((result) => !result.isBlocked)
              .map((result) => result.totalHits)
              .sort((a, b) => a - b),
            [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
          );
          assert.equal(results.filter((result) => result.isBlocked).length, 2);
          const storageKey = digest([name, key]);
          const before = (
            await f.pool.query(
              'SELECT * FROM whaleu_runtime.request_throttle_counters WHERE storage_key=$1',
              [storageKey],
            )
          ).rows[0]!;
          assert.equal(before.total_hits, 11);
          assert.equal(
            (await two.increment(key, 60000, 10, 60000, name)).isBlocked,
            true,
          );
          const after = (
            await f.pool.query(
              'SELECT * FROM whaleu_runtime.request_throttle_counters WHERE storage_key=$1',
              [storageKey],
            )
          ).rows[0]!;
          assert.deepEqual(
            after,
            before,
            'Blocked attempts do not extend their retention/window',
          );
          assert.equal(Object.values(after).includes(key), false);
        },
      );
      await t.test(
        'failed HTTP business transaction still spends shared attempt; following over-budget request cannot execute',
        async () => {
          const actor = await f.actor(),
            epoch = await f.epoch(actor),
            post = await f.publish(await f.actor());
          const key = digest([
            'view-request-v1',
            'report',
            'default',
            actor.accountId,
          ]);
          const storageKey = digest(['default', key]);
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "INSERT INTO whaleu_runtime.request_throttle_counters(storage_key,total_hits,expires_at) VALUES($1,119,clock_timestamp()+interval '1 minute')",
              [storageKey],
            ),
          );
          await f.pool.query(
            "CREATE FUNCTION whaleu_maintenance_test.fail_view_attempt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failed business attempt'; END $$; CREATE TRIGGER fail_view_attempt BEFORE INSERT ON whaleu_post_hotness.view_report_receipts FOR EACH ROW EXECUTE FUNCTION whaleu_maintenance_test.fail_view_attempt()",
          );
          const input = reportIntent(epoch.epochId, [post.id]);
          try {
            await f.report(actor, input).expect(503);
          } finally {
            await f.pool.query(
              'DROP TRIGGER fail_view_attempt ON whaleu_post_hotness.view_report_receipts; DROP FUNCTION whaleu_maintenance_test.fail_view_attempt()',
            );
          }
          assert.equal(
            (
              await f.pool.query(
                'SELECT total_hits FROM whaleu_runtime.request_throttle_counters WHERE storage_key=$1',
                [storageKey],
              )
            ).rows[0]!.total_hits,
            120,
          );
          assert.equal((await f.receipts(epoch.epochId)).length, 0);
          assert.equal(await f.count(post.id), '0');
          assert.deepEqual(await f.counters(epoch.epochId), {
            batch_count: 0,
            event_count: 0,
          });
          const blocked = await f.report(actor, input).expect(429);
          assert.equal(blocked.body.error.code, 'RATE_LIMITED');
          assert.ok(blocked.headers['retry-after']);
          assert.equal((await f.receipts(epoch.epochId)).length, 0);
          assert.equal(await f.count(post.id), '0');
        },
      );
      await t.test(
        'shared limiter cleanup uses real SKIP LOCKED, expiration recheck and 256-row bound',
        async () => {
          const keys = Array.from({ length: 300 }, () =>
            digest(['expired', randomUUID()]),
          );
          await withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "INSERT INTO whaleu_runtime.request_throttle_counters(storage_key,total_hits,expires_at) SELECT unnest($1::text[]),1,clock_timestamp()-interval '1 second'",
              [keys],
            ),
          );
          const held = await hold(
            f.pool,
            'SELECT storage_key FROM whaleu_runtime.request_throttle_counters WHERE storage_key=$1 FOR UPDATE',
            [keys[0]],
          );
          try {
            assert.equal(await one.cleanup(), 256);
            assert.equal(await two.cleanup(), 43);
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_runtime.request_throttle_counters WHERE storage_key=$1',
                  [keys[0]],
                )
              ).rowCount,
              1,
            );
          } finally {
            await release(held);
          }
          assert.equal(await one.cleanup(), 1);
        },
      );
      await t.test(
        'manual application starts no jobs; explicit HTTP bootstrap and real 60-second timer clean without traffic',
        async () => {
          assert.throws(() => f.app.get(ViewRetentionRunner));
          const actor = await f.actor();
          const startup = await syntheticEpoch(f.pool, actor.accountId, {
            expiresInMs: -1000,
          });
          const config = f.app.get<RuntimeConfig>(APP_CONFIG);
          const module = await Test.createTestingModule({
            imports: [AppModule.register(config, { httpRuntime: true })],
          }).compile();
          httpApp = module.createNestApplication({ logger: false });
          await httpApp.init();
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_post_hotness.view_reporting_epochs WHERE id=$1',
                [startup.epochId],
              )
            ).rowCount,
            0,
            'Startup sweep runs before any HTTP request',
          );
          const timers = httpApp.get(SchedulerRegistry).getIntervals();
          assert.deepEqual(timers, ['view-reporting-retention']);
          const scheduled = await syntheticEpoch(f.pool, actor.accountId, {
            expiresInMs: -1000,
          });
          // No sweep() call or HTTP request: exercise the official registered timer.
          const deadline = Date.now() + 65000;
          let removed = false;
          while (Date.now() < deadline) {
            await sleep(500);
            removed =
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_post_hotness.view_reporting_epochs WHERE id=$1',
                  [scheduled.epochId],
                )
              ).rowCount === 0;
            if (removed) break;
          }
          assert.equal(
            removed,
            true,
            'The real 60-second schedule must clean even when users make no requests',
          );
        },
      );
      await t.test(
        'shutdown awaits in-flight real cleanup, then closes its pool and prevents later sweeps',
        async () => {
          assert.ok(httpApp);
          const actor = await f.actor();
          const epoch = await syntheticEpoch(f.pool, actor.accountId, {
            expiresInMs: -1000,
          });
          const observer = observeViewQueries(httpApp);
          let allow!: () => void, entered!: () => void;
          const gate = new Promise<void>((resolve) => {
            allow = resolve;
          });
          const started = new Promise<void>((resolve) => {
            entered = resolve;
          });
          let paused = false;
          observer.setHook(async (event) => {
            if (
              !paused &&
              event.sql.includes(
                'SELECT id FROM whaleu_post_hotness.view_reporting_epochs',
              ) &&
              event.sql.includes('SKIP LOCKED')
            ) {
              paused = true;
              entered();
              await gate;
            }
          });
          const runner = httpApp.get(ViewRetentionRunner),
            sweep = runner.sweep();
          let closed = false;
          await Promise.race([
            started,
            sleep(3000).then(() =>
              assert.fail('Cleanup did not reach real transaction barrier'),
            ),
          ]);
          const closing = httpApp.close().then(() => {
            closed = true;
          });
          try {
            await sleep(50);
            assert.equal(
              closed,
              false,
              'Database pool cannot close before the cleanup resolves',
            );
            allow();
            await Promise.all([sweep, closing]);
            assert.equal(
              (
                await f.pool.query(
                  'SELECT 1 FROM whaleu_post_hotness.view_reporting_epochs WHERE id=$1',
                  [epoch.epochId],
                )
              ).rowCount,
              0,
            );
            await runner.sweep();
            assert.equal(closed, true);
          } finally {
            allow();
            observer.restore();
            await Promise.all([sweep, closing]);
            httpApp = undefined;
          }
        },
      );
      assert.ok(f.app.get(ViewComponentCleanup));
    } finally {
      await httpApp?.close();
      await f.close();
    }
  },
);
