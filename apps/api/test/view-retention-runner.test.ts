import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
import { Test } from '@nestjs/testing';
import { ScheduleModule, SchedulerRegistry } from '@nestjs/schedule';
import { AppModule } from '../src/app.module.js';
import { APP_CONFIG, loadConfig } from '../src/config/config.js';
import { manualProcessingConfig } from '../src/config/manual-processing.js';
import { ViewComponentCleanup } from '../src/community/view-component/cleanup.js';
import { ViewRetentionRunner } from '../src/community/view-component/retention-runner.js';
import { DatabaseService } from '../src/database/database.js';
import { AppLogger } from '../src/observability/logger.js';
import { PostgresThrottlerStorage } from '../src/request-throttling/postgres-storage.js';

const config = () =>
  loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://fixture@127.0.0.1/whaleu_test',
    PG_SSL_MODE: 'disable',
    LOG_LEVEL: 'silent',
  });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const logs: unknown[] = [];
  let gated = 0,
    sweeps = 0,
    prunes = 0;
  let run: () => Promise<void> = async () => undefined;
  let prune: () => Promise<number> = async () => 0;
  const cleanup = {
    requireSuccessfulSweep: () => {
      gated++;
    },
    run: async () => {
      sweeps++;
      await run();
      return {
        epochs: 1,
        receipts: 2,
        detailWindows: 3,
        quotas: 0,
        lagging: false,
      };
    },
  };
  const throttles = {
    cleanup: async () => {
      prunes++;
      return prune();
    },
  };
  const logger = {
    structured: {
      info: (data: unknown) => logs.push(data),
      warn: (data: unknown) => logs.push(data),
    },
  };
  return {
    cleanup,
    throttles,
    logger,
    logs,
    get gated() {
      return gated;
    },
    get sweeps() {
      return sweeps;
    },
    get prunes() {
      return prunes;
    },
    set run(operation: () => Promise<void>) {
      run = operation;
    },
    set prune(operation: () => Promise<number>) {
      prune = operation;
    },
    runner: (mode: 'automatic' | 'manual_only' | 'disabled' = 'automatic') =>
      new ViewRetentionRunner(
        { ...config(), VIEW_REPORTING_RETENTION_PROCESSING: mode },
        cleanup as unknown as ViewComponentCleanup,
        throttles as unknown as PostgresThrottlerStorage,
        logger as unknown as AppLogger,
      ),
  };
}

test('official interval runs startup and idle sweeps, shares inflight work, and shuts down before pool', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const f = fixture();
  let poolClosed = false;
  const testing = await Test.createTestingModule({
    imports: [ScheduleModule.forRoot({ cronJobs: false, timeouts: false })],
    providers: [
      ViewRetentionRunner,
      { provide: APP_CONFIG, useValue: config() },
      { provide: ViewComponentCleanup, useValue: f.cleanup },
      { provide: PostgresThrottlerStorage, useValue: f.throttles },
      { provide: AppLogger, useValue: f.logger },
      {
        provide: DatabaseService,
        useValue: {
          onApplicationShutdown: () => {
            poolClosed = true;
          },
        },
      },
    ],
  }).compile();
  const app = testing.createNestApplication();
  await app.init();
  const runner = app.get(ViewRetentionRunner);
  assert.equal(f.gated, 1, 'Constructor closes new admission before startup');
  assert.equal(f.sweeps, 1, 'Startup sweep needs no reporting request');
  assert.deepEqual(app.get(SchedulerRegistry).getIntervals(), [
    'view-reporting-retention',
  ]);
  t.mock.timers.tick(60000);
  await immediate();
  assert.equal(f.sweeps, 2, 'Idle interval invokes business cleanup');
  const gate = deferred();
  f.run = () => gate.promise;
  t.mock.timers.tick(60000);
  await immediate();
  assert.equal(f.sweeps, 3);
  const pending = runner.sweep();
  assert.equal(
    runner.sweep(),
    pending,
    'Concurrent callers share the in-flight promise',
  );
  t.mock.timers.tick(180000);
  await immediate();
  assert.equal(f.sweeps, 3, 'Periodic ticks never overlap an in-flight sweep');
  let closed = false;
  const closing = app.close().then(() => {
    closed = true;
  });
  await immediate();
  assert.equal(closed, false);
  assert.equal(poolClosed, false, 'Pool cannot close during active cleanup');
  gate.resolve();
  await closing;
  assert.equal(poolClosed, true);
  t.mock.timers.tick(180000);
  await runner.scheduledSweep();
  assert.equal(f.sweeps, 3, 'Shutdown permanently rejects stale callbacks');
});

test('failures are safely logged, admission is closed, and a later sweep recovers', async () => {
  const f = fixture(),
    runner = f.runner();
  f.prune = async () => {
    throw new Error('private database credentials');
  };
  await runner.onApplicationBootstrap();
  assert.equal(f.sweeps, 0);
  assert.equal(f.gated, 2);
  assert.deepEqual(f.logs, [{ event: 'view_retention_failed' }]);
  f.prune = async () => 0;
  await runner.scheduledSweep();
  assert.equal(f.sweeps, 1);
  assert.ok(!JSON.stringify(f.logs).includes('private'));
  await runner.beforeApplicationShutdown();
});

test('generic pruning has a finite chunk budget and does not swallow business lag metrics', async () => {
  const f = fixture(),
    runner = f.runner();
  f.prune = async () => 256;
  await runner.sweep();
  assert.equal(f.prunes, 16);
  assert.equal(f.sweeps, 1);
  assert.equal(
    (f.logs[0] as { requestCounters: number }).requestCounters,
    4096,
  );
  await runner.beforeApplicationShutdown();
});

test('disabled and manual-only HTTP modes close admission and never invoke automatic work', async () => {
  for (const mode of ['disabled', 'manual_only'] as const) {
    const f = fixture(),
      runner = f.runner(mode);
    await runner.onApplicationBootstrap();
    await runner.scheduledSweep();
    assert.equal(f.gated, 1);
    assert.equal(f.sweeps, 0);
    assert.equal(f.prunes, 0);
    await runner.beforeApplicationShutdown();
  }
});

test('ordinary and manual application contexts never register retention jobs despite automatic environment', async () => {
  for (const settings of [
    config(),
    manualProcessingConfig(config(), 'likes'),
  ]) {
    const testing = await Test.createTestingModule({
      imports: [AppModule.register(settings)],
    })
      .overrideProvider(DatabaseService)
      .useValue({ ready: async () => true })
      .compile();
    const app = testing.createNestApplication();
    try {
      await app.init();
      assert.throws(() => app.get(ViewRetentionRunner));
      assert.throws(() => app.get(SchedulerRegistry));
    } finally {
      await app.close();
    }
  }
});
