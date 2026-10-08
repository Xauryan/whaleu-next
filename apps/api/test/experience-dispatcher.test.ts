import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { setImmediate as immediate } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import type { DatabaseService } from '../src/database/database.js';
import { ExperienceDispatcher } from '../src/experience/dispatcher.js';
import { ExperienceWorker } from '../src/experience/worker.js';

const config = (extra: Record<string, string> = {}) =>
  loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://fixture@127.0.0.1/whaleu_test',
    PG_SSL_MODE: 'disable',
    LOG_LEVEL: 'silent',
    EXPERIENCE_PROCESSING: 'automatic',
    EXPERIENCE_INTERVAL_MS: '10',
    ...extra,
  });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function running(dispatcher: ExperienceDispatcher) {
  // Observe the actual scheduled cycle without bypassing start/stop or timers.
  return (dispatcher as unknown as { inflight: Promise<void> | null }).inflight;
}
async function tick(t: TestContext, dispatcher: ExperienceDispatcher) {
  t.mock.timers.tick(10);
  const task = running(dispatcher);
  assert.ok(task, 'One scheduled cycle starts');
  await task;
}
function fixture(
  t: TestContext,
  queues: string[][],
  batch = 20,
  attempt?: (id: string) => Promise<boolean>,
) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const runs: string[] = [],
    discoveries: string[][] = [],
    retries: string[] = [];
  const worker = {
    due: async (attempted: readonly string[] = []) => {
      discoveries.push([...attempted]);
      return queues
        .flatMap((q) => (q.length ? [q[0]!] : []))
        .filter((id) => !attempted.includes(id))
        .slice(0, batch - attempted.length);
    },
    run: async ({ unitIds }: { unitIds: string[] }) => {
      const id = unitIds[0]!;
      runs.push(id);
      if (!attempt || (await attempt(id))) {
        const queue = queues.find((q) => q[0] === id);
        queue?.shift();
      }
    },
    retry: async (id: string) => {
      retries.push(id);
    },
  };
  const dispatcher = new ExperienceDispatcher(
    config({ EXPERIENCE_BATCH_SIZE: String(batch) }),
    worker as unknown as ExperienceWorker,
  );
  t.after(() => dispatcher.stop());
  return { dispatcher, worker, runs, discoveries, retries };
}

test('experience dispatcher stays manual-only by default and rejects nonlocal automatic use', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  assert.equal(
    loadConfig({ DATABASE_URL: config().DATABASE_URL }).EXPERIENCE_PROCESSING,
    'manual_only',
  );
  for (const mode of ['manual_only', 'disabled'] as const) {
    const worker = {
      due: async () => assert.fail('No discovery without local opt-in'),
    };
    const dispatcher = new ExperienceDispatcher(
      config({ EXPERIENCE_PROCESSING: mode }),
      worker as unknown as ExperienceWorker,
    );
    await dispatcher.onApplicationBootstrap();
    await dispatcher.start();
    t.mock.timers.tick(1000);
    assert.equal(running(dispatcher), null);
    await dispatcher.beforeApplicationShutdown();
  }
  for (const extra of [
    { NODE_ENV: 'production' },
    { DATABASE_URL: 'postgresql://fixture@remote.invalid/whaleu_test' },
    { DATABASE_URL: 'postgresql://fixture@127.0.0.1/other' },
  ] as const) {
    const dispatcher = new ExperienceDispatcher(
      { ...config(), ...extra },
      {} as ExperienceWorker,
    );
    await assert.rejects(dispatcher.start(), /disposable local database/);
  }
});

test('one hot owner uses the full cycle budget instead of only one unit per interval', async (t) => {
  const units = Array.from({ length: 23 }, () => randomUUID());
  const f = fixture(t, [[...units]]);
  await Promise.all([f.dispatcher.start(), f.dispatcher.start()]);
  await tick(t, f.dispatcher);
  assert.deepEqual(f.runs, units.slice(0, 20));
  assert.equal(f.discoveries.length, 20);
  assert.deepEqual(f.discoveries.at(-1), units.slice(0, 19));
  await tick(t, f.dispatcher);
  assert.deepEqual(f.runs, units);
  assert.equal(f.discoveries.length, 24, 'Three attempts and one empty read');
});

test('frontier rounds give independent owners a turn before revisiting the hot owner', async (t) => {
  const f = fixture(
    t,
    [
      ['a1', 'a2', 'a3'],
      ['b1', 'b2'],
    ],
    3,
  );
  await f.dispatcher.start();
  await tick(t, f.dispatcher);
  assert.deepEqual(f.runs, ['a1', 'b1', 'a2']);
  assert.deepEqual(f.discoveries, [[], ['a1', 'b1']]);
  await tick(t, f.dispatcher);
  assert.deepEqual(f.runs, ['a1', 'b1', 'a2', 'a3', 'b2']);
});

test('stuck heads and escaped failures cannot spin, overtake or starve independent work', async (t) => {
  const f = fixture(
    t,
    [
      ['stuck', 'blocked'],
      ['throws', 'also-blocked'],
      ['b1', 'b2', 'b3'],
    ],
    6,
    async (id) => {
      if (id === 'throws') throw new Error('Synthetic selection failure');
      return id !== 'stuck';
    },
  );
  f.worker.retry = async (id) => {
    f.retries.push(id);
    throw new Error('Synthetic retry write failure');
  };
  await f.dispatcher.start();
  await tick(t, f.dispatcher);
  assert.deepEqual(f.runs, ['stuck', 'throws', 'b1', 'b2', 'b3']);
  assert.deepEqual(f.retries, ['throws']);
  assert.equal(f.discoveries.length, 4);
  assert.equal(new Set(f.runs).size, f.runs.length);
});

test('total attempt budget remains bounded even if discovery repeats or overreturns IDs', async (t) => {
  const f = fixture(t, [], 3);
  f.worker.due = async () => ['one', 'one', 'two', 'three', 'four'];
  await f.dispatcher.start();
  await tick(t, f.dispatcher);
  assert.deepEqual(f.runs, ['one', 'two', 'three']);
});

test('a failed discovery recovers on the next tick with only one timer chain', async (t) => {
  const f = fixture(t, [['one']], 2);
  const due = f.worker.due;
  let calls = 0;
  f.worker.due = async (attempted) => {
    if (++calls === 1) throw new Error('Synthetic database unavailable');
    return due(attempted);
  };
  await f.dispatcher.start();
  await tick(t, f.dispatcher);
  assert.deepEqual(f.runs, []);
  await tick(t, f.dispatcher);
  assert.deepEqual(f.runs, ['one']);
  assert.equal(calls, 3);
});

test('stop during discovery waits and never starts a unit from the stale frontier', async (t) => {
  const gate = deferred();
  const f = fixture(t, [['one']], 2);
  const due = f.worker.due;
  f.worker.due = async (attempted) => {
    await gate.promise;
    return due(attempted);
  };
  await f.dispatcher.start();
  t.mock.timers.tick(10);
  let stopped = false;
  const stop = f.dispatcher.stop().then(() => {
    stopped = true;
  });
  await immediate();
  assert.equal(stopped, false);
  gate.resolve();
  await stop;
  t.mock.timers.tick(1000);
  assert.deepEqual(f.runs, []);
});

test('stop/restart waits for current unit, abandons its remaining round and cannot overlap cycles', async (t) => {
  const gate = deferred(),
    entered = deferred();
  let active = 0,
    maximum = 0;
  const f = fixture(t, [['a1', 'a2'], ['b1']], 3, async () => {
    active++;
    maximum = Math.max(maximum, active);
    entered.resolve();
    await gate.promise;
    active--;
    return true;
  });
  await Promise.all([f.dispatcher.start(), f.dispatcher.start()]);
  t.mock.timers.tick(10);
  await entered.promise;
  t.mock.timers.tick(1000);
  assert.deepEqual(f.runs, ['a1']);
  let restarted = false;
  const stop = f.dispatcher.stop();
  const restart = Promise.all([
    f.dispatcher.start(),
    f.dispatcher.start(),
  ]).then(() => {
    restarted = true;
  });
  await immediate();
  assert.equal(restarted, false);
  gate.resolve();
  await Promise.all([stop, restart]);
  assert.deepEqual(f.runs, ['a1']);
  await tick(t, f.dispatcher);
  assert.deepEqual(f.runs, ['a1', 'a2', 'b1']);
  assert.equal(maximum, 1);
  await Promise.all([f.dispatcher.stop(), f.dispatcher.stop()]);
  const reads = f.discoveries.length;
  t.mock.timers.tick(1000);
  assert.equal(f.discoveries.length, reads);
});

test('worker frontier validates bounded exclusions and subtracts them from the one cycle budget', async () => {
  const calls: { sql: string; values: unknown[] | undefined }[] = [];
  const tx = {
    host: '127.0.0.1',
    connection: { stream: { remoteAddress: '127.0.0.1' } },
    query: async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values });
      return sql.includes('current_database')
        ? { rows: [{ name: 'whaleu_test' }] }
        : { rows: [{ unit_id: 'next' }] };
    },
  };
  const database = {
    transaction: async <T>(action: (tx: PoolClient) => Promise<T>) =>
      action(tx as unknown as PoolClient),
  };
  const worker = new ExperienceWorker(
    config({ EXPERIENCE_BATCH_SIZE: '3' }),
    database as DatabaseService,
    {} as never,
    {} as never,
    {} as never,
  );
  const attempted = [randomUUID(), randomUUID(), randomUUID()];
  assert.deepEqual(await worker.due(attempted.slice(0, 2)), ['next']);
  assert.deepEqual(calls.at(-1)!.values, [1, attempted.slice(0, 2)]);
  assert.match(calls.at(-1)!.sql, /w\.unit_id<>ALL\(\$2::uuid\[\]\)/);
  assert.match(calls.at(-1)!.sql, /earlier\.state<>'completed'/);
  const count = calls.length;
  assert.deepEqual(await worker.due(attempted), []);
  assert.equal(calls.length, count);
  await assert.rejects(worker.due(['invalid']));
  await assert.rejects(worker.due([attempted[0]!, attempted[0]!]));
  await assert.rejects(
    worker.due(Array.from({ length: 51 }, () => randomUUID())),
  );
});
