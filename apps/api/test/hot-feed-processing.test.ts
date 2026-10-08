import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import type { DatabaseService } from '../src/database/database.js';
import type { HotScoreRepository } from '../src/community/hot-score/repository.js';
import { HotScoreStorage } from '../src/community/hot-score/storage.js';
import { HotScoreMaterializer } from '../src/community/hot-score/materializer.js';
import type { HotScoreEvaluator } from '../src/community/hot-score/evaluator.js';
import { HotFeedProcessing } from '../src/community/hot-score/processing.js';
import { HotFeedRunner } from '../src/community/hot-score/runner.js';
import type { SubscriptionComponentRuntime } from '../src/community/subscription-component/runtime.js';
import type { LikeComponentRuntime } from '../src/community/like-component/runtime.js';
import type { CommentComponentRuntime } from '../src/community/comment-component/runtime.js';
import type { AppLogger } from '../src/observability/logger.js';
import { hotSnapshot, hotCertificate } from './support/hot-certificate.js';
const config = (mode: 'automatic' | 'manual_only' | 'disabled' = 'automatic') =>
  loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://fixture@127.0.0.1/whaleu_test',
    PG_SSL_MODE: 'disable',
    HOT_FEED_PROCESSING: mode,
    SUBSCRIPTION_COMPONENT_PROCESSING: mode,
    LIKE_COMPONENT_PROCESSING: mode,
    COMMENT_COMPONENT_PROCESSING: mode,
  });
function db(events: string[] = []) {
  const tx = {
    query: async (sql: string) => {
      events.push(sql);
      return { rows: [] };
    },
  } as unknown as PoolClient;
  return {
    transaction: async <T>(fn: (tx: PoolClient) => Promise<T>) => fn(tx),
  } as unknown as DatabaseService;
}
test('materializer parent/states/final snapshot precede arithmetic and atomic replace; unchanged certificate is not rewritten', async () => {
  const events: string[] = [],
    snapshot = hotSnapshot();
  let existing: ReturnType<typeof hotCertificate> | null = null;
  const records = {
    lockPost: async () => {
      events.push('parent');
      return true;
    },
    coverage: async () => {
      events.push('coverage');
      return true;
    },
    lockStates: async () => {
      events.push('states');
    },
    snapshot: async () => {
      events.push('snapshot');
      return snapshot;
    },
  } as unknown as HotScoreRepository;
  const storage = {
    certificate: async () => existing,
    replace: async () => {
      events.push('replace');
    },
  } as unknown as HotScoreStorage;
  const evaluator = {
    evaluate: async () => {
      events.push('evaluate');
      return '0.0000';
    },
  } as unknown as HotScoreEvaluator;
  const materializer = new HotScoreMaterializer(
    db(events),
    records,
    storage,
    evaluator,
  );
  assert.equal(await materializer.refresh(snapshot.postId), 'refreshed');
  assert.deepEqual(events.slice(3), [
    'parent',
    'coverage',
    'states',
    'snapshot',
    'evaluate',
    'replace',
  ]);
  existing = hotCertificate(snapshot);
  events.length = 0;
  assert.equal(await materializer.refresh(snapshot.postId), 'current');
  assert.equal(events.includes('evaluate'), false);
  assert.equal(events.includes('replace'), false);
  snapshot.states.like!.capturedHead = '1';
  assert.equal(await materializer.refresh(snapshot.postId), 'blockedFreshness');
  assert.equal(events.includes('evaluate'), false);
});
function processingHarness(count = 20) {
  const ids: string[] = Array.from({ length: count }, () => randomUUID());
  const age = new Map(ids.map((id) => [id, 0]));
  let clock = 0;
  const calls: { id: string; owner: number }[] = [],
    scheduled: string[] = [];
  let poison: string | null = null;
  const database = db();
  const storage = {
    due: async () =>
      [...ids].sort((a, b) => age.get(a)! - age.get(b)!).slice(0, 20),
    schedule: async (id: string) => {
      scheduled.push(id);
      age.set(id, ++clock);
    },
  } as unknown as HotScoreStorage;
  const owners = [0, 1, 2].map((owner) => ({
    processNext: async (id: string) => {
      calls.push({ id, owner });
      if (id === poison) throw new Error('private');
      return 'applied' as const;
    },
  }));
  const processor = new HotFeedProcessing(
    config(),
    database,
    {} as HotScoreRepository,
    storage,
    {
      refresh: async () => 'blockedFreshness',
    } as unknown as HotScoreMaterializer,
    owners[0] as unknown as SubscriptionComponentRuntime,
    owners[1] as unknown as LikeComponentRuntime,
    owners[2] as unknown as CommentComponentRuntime,
  );
  return {
    processor,
    ids,
    calls,
    scheduled,
    set poison(id: string | null) {
      poison = id;
    },
  };
}
test('saturated 20-post frontier preserves all-owner fairness under 50 transaction budget', async () => {
  const f = processingHarness();
  const first = await f.processor.cycle();
  assert.equal(first.attempted, 16);
  assert.equal(first.componentTransactions, 48);
  assert.equal(f.scheduled.length, 16);
  assert.deepEqual(
    new Set(f.calls.map((x) => x.id)),
    new Set(f.ids.slice(0, 16)),
  );
  f.calls.length = 0;
  await f.processor.cycle();
  assert.deepEqual(
    f.calls.slice(0, 12).map((x) => x.id),
    f.ids.slice(16).flatMap((id) => [id, id, id]),
  );
});
test('one stuck parent cannot prevent other components/posts; failed backoff update never waits for parent', async () => {
  const f = processingHarness(2);
  f.poison = f.ids[0]!;
  const result = await f.processor.cycle();
  assert.equal(result.failed, 1);
  assert.equal(result.blocked, 1);
  assert.equal(f.calls.length, 6);
  assert.deepEqual(f.scheduled, f.ids);
  const queries: string[] = [];
  await new HotScoreStorage().schedule(f.ids[0]!, 'failed', {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
  } as unknown as PoolClient);
  assert.equal(queries.length, 1);
  assert.match(queries[0]!, /UPDATE whaleu_post_hotness.processing/);
  assert.doesNotMatch(queries[0]!, /FOR UPDATE|whaleu_community.posts/);
  assert.match(queries[0]!, /least\(300/);
});
test('runner is no-op disabled/manual, single-flight and drains before shutdown', async () => {
  let cycles = 0,
    release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const logs: unknown[] = [];
  const processing = {
    cycle: async () => {
      cycles++;
      await waiting;
      return {
        attempted: 1,
        componentTransactions: 3,
        current: 1,
        blocked: 0,
        failed: 0,
      };
    },
  } as unknown as HotFeedProcessing;
  const logger = {
    structured: {
      info: (value: unknown) => logs.push(value),
      warn: (value: unknown) => logs.push(value),
    },
  } as unknown as AppLogger;
  for (const mode of ['disabled', 'manual_only'] as const) {
    const runner = new HotFeedRunner(config(mode), processing, logger);
    await runner.onApplicationBootstrap();
    await runner.tick();
  }
  assert.equal(cycles, 0);
  const runner = new HotFeedRunner(config(), processing, logger);
  const first = runner.tick();
  const second = runner.tick();
  assert.equal(cycles, 1);
  let closed = false;
  const shutdown = runner.beforeApplicationShutdown().then(() => {
    closed = true;
  });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await Promise.all([first, second, shutdown]);
  await runner.tick();
  assert.equal(cycles, 1);
  assert.equal(logs.length, 1);
});

test('manual bootstrap ignores partial/unknown coverage and repeated selection advances persisted fairness', async () => {
  const ids: string[] = Array.from({ length: 20 }, () => randomUUID()),
    partial = randomUUID();
  const enrolled: string[] = [],
    effects: string[] = [],
    ages = new Map(ids.map((id) => [id, 0]));
  let now = 0;
  const tx = {
    host: '127.0.0.1',
    connection: { stream: { remoteAddress: '127.0.0.1' } },
    query: async (sql: string) => ({
      rows:
        sql === 'SELECT current_database() AS name'
          ? [{ name: 'whaleu_test' }]
          : [],
    }),
  } as unknown as PoolClient;
  const database = {
    transaction: async <T>(fn: (tx: PoolClient) => Promise<T>) => fn(tx),
  } as unknown as DatabaseService;
  const records = {
    lockPost: async () => true,
    coverage: async (id: string) => id !== partial,
    lockStates: async () => {},
    snapshot: async (id: string) => hotSnapshot(id),
  } as unknown as HotScoreRepository;
  const storage = {
    enroll: async (id: string) => {
      enrolled.push(id);
    },
    orderSelected: async (selected: readonly string[]) =>
      [...selected].sort((a, b) => ages.get(a)! - ages.get(b)!),
    schedule: async (id: string) => {
      ages.set(id, ++now);
    },
  } as unknown as HotScoreStorage;
  const owner = {
    processNext: async (id: string) => {
      effects.push(id);
      return 'idle' as const;
    },
  };
  const processor = new HotFeedProcessing(
    config('manual_only'),
    database,
    records,
    storage,
    { refresh: async () => 'current' } as unknown as HotScoreMaterializer,
    owner as unknown as SubscriptionComponentRuntime,
    owner as unknown as LikeComponentRuntime,
    owner as unknown as CommentComponentRuntime,
  );
  const partialResult = await processor.processSelected([partial]);
  assert.equal(partialResult.blocked, 1);
  assert.equal(partialResult.attempted, 0);
  assert.equal(effects.length, 0);
  assert.equal(enrolled.length, 0);
  assert.equal((await processor.processSelected(ids)).attempted, 16);
  effects.length = 0;
  await processor.processSelected(ids);
  assert.deepEqual(
    effects.slice(0, 12),
    ids.slice(16).flatMap((id) => [id, id, id]),
  );
});

test('HTTP runner module is admitted only by explicit automatic mode and generic application never mounts timers', async () => {
  const { AppModule } = await import('../src/app.module.js');
  const { HotFeedRunnerModule } =
    await import('../src/community/hot-score/runner.js');
  for (const mode of ['disabled', 'manual_only', 'automatic'] as const) {
    const ordinary = AppModule.register(config(mode));
    assert.equal(ordinary.imports!.includes(HotFeedRunnerModule), false);
    const http = AppModule.register(config(mode), { httpRuntime: true });
    assert.equal(
      http.imports!.includes(HotFeedRunnerModule),
      mode === 'automatic',
    );
  }
});
