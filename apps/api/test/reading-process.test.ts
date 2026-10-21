import 'reflect-metadata';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import type { RuntimeConfig } from '../src/config/config.js';
import {
  assertReadingWorkerRole,
  readingProcessOptions,
  runReadingProcess,
} from '../src/community/reading-formatting/worker-process.js';
import type {
  ReadingProcessHealth,
  ReadingProcessOptions,
} from '../src/community/reading-formatting/worker-process.js';

const local = { DATABASE_URL: 'postgresql://localhost/reading_process_test' };
const config = (
  mode: RuntimeConfig['COMMUNITY_READING_FORMATTING_PROCESSING'],
  extra: NodeJS.ProcessEnv = {},
) =>
  loadConfig({
    ...local,
    COMMUNITY_READING_FORMATTING_PROCESSING: mode,
    ...extra,
  });
const once: ReadingProcessOptions = {
  mode: 'once',
  ticks: 3,
  intervalMs: 1000,
};
const tickResult = (wrapped = false) => ({
  examined: 2,
  claimed: 2,
  completed: 2,
  deferred: 0,
  skipped: 0,
  wrapped,
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function healthRecorder() {
  const reports: ReadingProcessHealth[] = [];
  return {
    reports,
    report(health: ReadingProcessHealth) {
      assert.equal(Object.isFrozen(health), true);
      assert.deepEqual(Object.keys(health).sort(), [
        'cycles',
        'state',
        'ticks',
      ]);
      reports.push(health);
    },
  };
}

test('reading process is disabled by default and cannot run in disabled mode', () => {
  const defaults = loadConfig(local);
  assert.equal(defaults.COMMUNITY_READING_FORMATTING_PROCESSING, 'disabled');
  assert.equal(defaults.COMMUNITY_READING_FORMATTING_TICKS_PER_CYCLE, 1);
  assert.equal(defaults.COMMUNITY_READING_FORMATTING_INTERVAL_MS, 5000);
  for (const mode of ['once', 'serve']) {
    assert.throws(() => readingProcessOptions(defaults, [mode]), /disabled/i);
  }
});

test('manual_only permits explicit once but never serve', () => {
  const manual = config('manual_only');
  assert.deepEqual(readingProcessOptions(manual, ['once']), {
    mode: 'once',
    ticks: 1,
    intervalMs: 5000,
  });
  assert.throws(() => readingProcessOptions(manual, ['serve']), /automatic/i);
});

test('automatic permits either explicit mode and preserves immutable configured bounds', () => {
  const automatic = config('automatic', {
    COMMUNITY_READING_FORMATTING_TICKS_PER_CYCLE: '32',
    COMMUNITY_READING_FORMATTING_INTERVAL_MS: '60000',
  });
  for (const mode of ['once', 'serve'] as const) {
    const options = readingProcessOptions(automatic, [mode]);
    assert.deepEqual(options, { mode, ticks: 32, intervalMs: 60000 });
    assert.equal(Object.isFrozen(options), true);
  }
});

test('enabled processing still requires exactly one recognized explicit command', () => {
  const invalid = [
    [],
    [''],
    ['ONCE'],
    ['once '],
    ['--once'],
    ['automatic'],
    ['once', 'serve'],
    ['serve', '--ticks=1'],
  ];
  for (const mode of ['manual_only', 'automatic'] as const) {
    for (const args of invalid) {
      assert.throws(
        () => readingProcessOptions(config(mode), args),
        /explicit once or serve/i,
      );
    }
  }
});

test('reading process configuration rejects invalid modes and unbounded numeric values', () => {
  for (const mode of ['manual', 'enabled', 'AUTO', '']) {
    assert.throws(
      () =>
        loadConfig({ ...local, COMMUNITY_READING_FORMATTING_PROCESSING: mode }),
      /COMMUNITY_READING_FORMATTING_PROCESSING/,
    );
  }
  for (const value of ['', '0', '-1', '33', '1.5', 'NaN', 'Infinity']) {
    assert.throws(
      () =>
        config('automatic', {
          COMMUNITY_READING_FORMATTING_TICKS_PER_CYCLE: value,
        }),
      /COMMUNITY_READING_FORMATTING_TICKS_PER_CYCLE/,
    );
  }
  for (const value of [
    '',
    '0',
    '-1',
    '999',
    '60001',
    '1000.5',
    'NaN',
    'Infinity',
  ]) {
    assert.throws(
      () =>
        config('automatic', {
          COMMUNITY_READING_FORMATTING_INTERVAL_MS: value,
        }),
      /COMMUNITY_READING_FORMATTING_INTERVAL_MS/,
    );
  }
  for (const [ticks, intervalMs] of [
    [1, 1000],
    [32, 60000],
  ]) {
    assert.deepEqual(
      readingProcessOptions(
        config('automatic', {
          COMMUNITY_READING_FORMATTING_TICKS_PER_CYCLE: String(ticks),
          COMMUNITY_READING_FORMATTING_INTERVAL_MS: String(intervalMs),
        }),
        ['once'],
      ),
      { mode: 'once', ticks, intervalMs },
    );
  }
});

test('runner rejects invalid direct options before readiness, work, waits, or reports', async () => {
  const invalid = [
    ...[undefined, null, '', 'automatic', 'ONCE'].map((mode) => ({
      ...once,
      mode,
    })),
    ...[undefined, null, '1', 0, -1, 33, 1.5, NaN, Infinity].map((ticks) => ({
      ...once,
      ticks,
    })),
    ...[undefined, null, '1000', 0, 999, 60001, 1000.5, NaN, Infinity].map(
      (intervalMs) => ({ ...once, intervalMs }),
    ),
  ];
  for (const options of invalid) {
    const calls: string[] = [];
    await assert.rejects(
      runReadingProcess(
        options as ReadingProcessOptions,
        {
          ready: async () => {
            calls.push('ready');
          },
          worker: {
            tick: async () => {
              calls.push('tick');
              return tickResult();
            },
          },
          wait: async () => {
            calls.push('wait');
          },
          report: () => {
            calls.push('report');
          },
        },
        new AbortController().signal,
      ),
      { name: 'TypeError', message: /bounded reading process options/ },
    );
    assert.deepEqual(calls, []);
  }
});

test('once accepts both bound endpoints and never waits', async () => {
  for (const [ticks, intervalMs] of [
    [1, 1000],
    [32, 60000],
  ]) {
    let readyCalls = 0;
    let tickCalls = 0;
    const health = await runReadingProcess(
      { mode: 'once', ticks: ticks!, intervalMs: intervalMs! },
      {
        ready: async () => {
          readyCalls++;
        },
        worker: {
          tick: async () => {
            tickCalls++;
            return tickResult();
          },
        },
        wait: async () => {
          assert.fail('once must not wait');
        },
      },
      new AbortController().signal,
    );
    assert.deepEqual(health, { state: 'stopped', cycles: 1, ticks });
    assert.equal(tickCalls, ticks);
    assert.equal(readyCalls, ticks! + 1);
  }
});

test('once checks readiness before each serial tick and reports only immutable process aggregates', async () => {
  const events: string[] = [];
  const recorder = healthRecorder();
  let readyCalls = 0;
  let active = 0;
  const health = await runReadingProcess(
    once,
    {
      ready: async () => {
        assert.equal(active, 0);
        events.push(`ready:${++readyCalls}`);
      },
      worker: {
        tick: async () => {
          assert.equal(++active, 1);
          events.push('tick:start');
          await nextTurn();
          events.push('tick:end');
          active--;
          return tickResult();
        },
      },
      wait: async () => {
        assert.fail('once must not wait');
      },
      report: recorder.report,
    },
    new AbortController().signal,
  );
  assert.deepEqual(events, [
    'ready:1',
    'ready:2',
    'tick:start',
    'tick:end',
    'ready:3',
    'tick:start',
    'tick:end',
    'ready:4',
    'tick:start',
    'tick:end',
  ]);
  assert.deepEqual(recorder.reports, [
    { state: 'starting', cycles: 0, ticks: 0 },
    { state: 'running', cycles: 0, ticks: 0 },
    { state: 'stopping', cycles: 1, ticks: 3 },
    { state: 'stopped', cycles: 1, ticks: 3 },
  ]);
  assert.equal(health, recorder.reports.at(-1));
  assert.equal(active, 0);
});

test('serve caps each serial cycle, ends wrapped cycles early, and waits only between cycles', async () => {
  const controller = new AbortController();
  const recorder = healthRecorder();
  let ticks = 0;
  let readyCalls = 0;
  let waits = 0;
  let active = 0;
  const health = await runReadingProcess(
    { ...once, mode: 'serve' },
    {
      ready: async () => {
        assert.equal(active, 0);
        readyCalls++;
      },
      worker: {
        tick: async () => {
          assert.equal(++active, 1);
          assert.equal(readyCalls, ticks + 2);
          ticks++;
          await nextTurn();
          active--;
          return tickResult(ticks === 5);
        },
      },
      wait: async (milliseconds, signal) => {
        assert.equal(milliseconds, once.intervalMs);
        assert.equal(signal, controller.signal);
        assert.equal(active, 0);
        waits++;
        assert.equal(ticks, waits === 1 ? 3 : 5);
        if (waits === 2) controller.abort();
      },
      report: recorder.report,
    },
    controller.signal,
  );
  assert.equal(waits, 2);
  assert.equal(readyCalls, 6);
  assert.deepEqual(health, { state: 'stopped', cycles: 2, ticks: 5 });
  assert.deepEqual(recorder.reports, [
    { state: 'starting', cycles: 0, ticks: 0 },
    { state: 'running', cycles: 0, ticks: 0 },
    { state: 'sleeping', cycles: 1, ticks: 3 },
    { state: 'running', cycles: 1, ticks: 3 },
    { state: 'sleeping', cycles: 2, ticks: 5 },
    { state: 'stopping', cycles: 2, ticks: 5 },
    { state: 'stopped', cycles: 2, ticks: 5 },
  ]);
});

test('an empty wrapped tick ends once immediately but still counts the finished tick', async () => {
  let tickCalls = 0;
  let readyCalls = 0;
  const health = await runReadingProcess(
    once,
    {
      ready: async () => {
        readyCalls++;
      },
      worker: {
        tick: async () => {
          tickCalls++;
          return tickResult(true);
        },
      },
    },
    new AbortController().signal,
  );
  assert.deepEqual(health, { state: 'stopped', cycles: 1, ticks: 1 });
  assert.equal(tickCalls, 1);
  assert.equal(readyCalls, 2);
});

test('a pre-aborted process stops without readiness or worker access', async () => {
  const controller = new AbortController();
  controller.abort();
  const recorder = healthRecorder();
  const health = await runReadingProcess(
    once,
    {
      ready: async () => {
        assert.fail('pre-aborted readiness');
      },
      worker: {
        tick: async () => {
          assert.fail('pre-aborted tick');
        },
      },
      wait: async () => {
        assert.fail('pre-aborted wait');
      },
      report: recorder.report,
    },
    controller.signal,
  );
  assert.deepEqual(health, { state: 'stopped', cycles: 0, ticks: 0 });
  assert.deepEqual(
    recorder.reports.map(({ state }) => state),
    ['starting', 'stopping', 'stopped'],
  );
});

test('abort during startup readiness drains readiness and never starts a cycle', async () => {
  const controller = new AbortController();
  const started = deferred();
  const release = deferred();
  const recorder = healthRecorder();
  const running = runReadingProcess(
    once,
    {
      ready: async () => {
        started.resolve();
        await release.promise;
      },
      worker: {
        tick: async () => {
          assert.fail('aborted startup tick');
        },
      },
      report: recorder.report,
    },
    controller.signal,
  );
  await started.promise;
  controller.abort();
  await nextTurn();
  assert.deepEqual(
    recorder.reports.map(({ state }) => state),
    ['starting'],
  );
  release.resolve();
  assert.deepEqual(await running, { state: 'stopped', cycles: 0, ticks: 0 });
});

test('abort during per-tick readiness prevents the first worker tick', async () => {
  const controller = new AbortController();
  const started = deferred();
  const release = deferred();
  let readyCalls = 0;
  const running = runReadingProcess(
    once,
    {
      ready: async () => {
        if (++readyCalls === 2) {
          started.resolve();
          await release.promise;
        }
      },
      worker: {
        tick: async () => {
          assert.fail('tick after readiness abort');
        },
      },
    },
    controller.signal,
  );
  await started.promise;
  controller.abort();
  release.resolve();
  assert.deepEqual(await running, { state: 'stopped', cycles: 1, ticks: 0 });
  assert.equal(readyCalls, 2);
});

test('abort during an in-flight tick drains it before reporting stopped and never starts another', async () => {
  const controller = new AbortController();
  const started = deferred();
  const release = deferred();
  const recorder = healthRecorder();
  let ticks = 0;
  let readyCalls = 0;
  let settled = false;
  const running = runReadingProcess(
    { ...once, mode: 'serve' },
    {
      ready: async () => {
        readyCalls++;
      },
      worker: {
        tick: async () => {
          ticks++;
          started.resolve();
          await release.promise;
          return tickResult();
        },
      },
      wait: async () => {
        assert.fail('wait after in-flight abort');
      },
      report: recorder.report,
    },
    controller.signal,
  );
  void running.then(() => {
    settled = true;
  });
  await started.promise;
  controller.abort();
  await nextTurn();
  assert.equal(settled, false);
  assert.deepEqual(
    recorder.reports.map(({ state }) => state),
    ['starting', 'running'],
  );
  release.resolve();
  assert.deepEqual(await running, { state: 'stopped', cycles: 1, ticks: 1 });
  assert.equal(ticks, 1);
  assert.equal(readyCalls, 2);
});

test('abort between ticks during readiness preserves completed counts without another tick', async () => {
  const controller = new AbortController();
  let ticks = 0;
  let readyCalls = 0;
  const health = await runReadingProcess(
    once,
    {
      ready: async () => {
        if (++readyCalls === 3) controller.abort();
      },
      worker: {
        tick: async () => {
          ticks++;
          return tickResult();
        },
      },
    },
    controller.signal,
  );
  assert.deepEqual(health, { state: 'stopped', cycles: 1, ticks: 1 });
  assert.equal(ticks, 1);
  assert.equal(readyCalls, 3);
});

test('abort during an injected sleep prevents the next serve cycle', async () => {
  const controller = new AbortController();
  const sleeping = deferred();
  let ticks = 0;
  const running = runReadingProcess(
    { ...once, mode: 'serve', ticks: 1 },
    {
      ready: async () => {},
      worker: {
        tick: async () => {
          ticks++;
          return tickResult();
        },
      },
      wait: async (milliseconds, signal) => {
        assert.equal(milliseconds, once.intervalMs);
        assert.equal(signal, controller.signal);
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
          sleeping.resolve();
        });
      },
    },
    controller.signal,
  );
  await sleeping.promise;
  controller.abort();
  assert.deepEqual(await running, { state: 'stopped', cycles: 1, ticks: 1 });
  assert.equal(ticks, 1);
});

test(
  'the default sleep responds to abort without waiting for its configured interval',
  { timeout: 2000 },
  async () => {
    const controller = new AbortController();
    const sleeping = deferred();
    let ticks = 0;
    const running = runReadingProcess(
      { ...once, mode: 'serve', ticks: 1, intervalMs: 60000 },
      {
        ready: async () => {},
        worker: {
          tick: async () => {
            ticks++;
            return tickResult();
          },
        },
        report: ({ state }) => {
          if (state === 'sleeping') sleeping.resolve();
        },
      },
      controller.signal,
    );
    await sleeping.promise;
    controller.abort();
    assert.deepEqual(await running, { state: 'stopped', cycles: 1, ticks: 1 });
    assert.equal(ticks, 1);
  },
);

test('the default sleep also accepts an abort immediately before it is entered', async () => {
  const controller = new AbortController();
  const health = await runReadingProcess(
    { ...once, mode: 'serve', ticks: 1 },
    {
      ready: async () => {},
      worker: { tick: async () => tickResult() },
      report: ({ state }) => {
        if (state === 'sleeping') controller.abort();
      },
    },
    controller.signal,
  );
  assert.deepEqual(health, { state: 'stopped', cycles: 1, ticks: 1 });
});

test('startup readiness failures propagate unchanged and report failed without work', async () => {
  const error = new Error('readiness unavailable');
  const recorder = healthRecorder();
  await assert.rejects(
    runReadingProcess(
      once,
      {
        ready: async () => {
          throw error;
        },
        worker: {
          tick: async () => {
            assert.fail('tick after startup failure');
          },
        },
        report: recorder.report,
      },
      new AbortController().signal,
    ),
    (value) => value === error,
  );
  assert.deepEqual(recorder.reports, [
    { state: 'starting', cycles: 0, ticks: 0 },
    { state: 'failed', cycles: 0, ticks: 0 },
  ]);
});

test('a readiness revocation between ticks fails closed and retains only completed tick counts', async () => {
  const error = new Error('role revoked');
  const recorder = healthRecorder();
  let readyCalls = 0;
  let ticks = 0;
  await assert.rejects(
    runReadingProcess(
      once,
      {
        ready: async () => {
          if (++readyCalls === 3) throw error;
        },
        worker: {
          tick: async () => {
            ticks++;
            return tickResult();
          },
        },
        report: recorder.report,
      },
      new AbortController().signal,
    ),
    (value) => value === error,
  );
  assert.equal(ticks, 1);
  assert.deepEqual(recorder.reports.at(-1), {
    state: 'failed',
    cycles: 0,
    ticks: 1,
  });
  assert.deepEqual(
    recorder.reports.map(({ state }) => state),
    ['starting', 'running', 'failed'],
  );
});

test('worker failures propagate without counting the failed tick or retrying the cycle', async () => {
  const error = new Error('transaction failed');
  const recorder = healthRecorder();
  let ticks = 0;
  await assert.rejects(
    runReadingProcess(
      { ...once, mode: 'serve' },
      {
        ready: async () => {},
        worker: {
          tick: async () => {
            if (++ticks === 2) throw error;
            return tickResult();
          },
        },
        wait: async () => {
          assert.fail('wait after tick failure');
        },
        report: recorder.report,
      },
      new AbortController().signal,
    ),
    (value) => value === error,
  );
  assert.equal(ticks, 2);
  assert.deepEqual(recorder.reports.at(-1), {
    state: 'failed',
    cycles: 0,
    ticks: 1,
  });
  assert.deepEqual(
    recorder.reports.map(({ state }) => state),
    ['starting', 'running', 'failed'],
  );
});

test('sleep failures propagate with the completed cycle and tick aggregates', async () => {
  const error = new Error('wait failed');
  const recorder = healthRecorder();
  let ticks = 0;
  await assert.rejects(
    runReadingProcess(
      { ...once, mode: 'serve' },
      {
        ready: async () => {},
        worker: {
          tick: async () => {
            ticks++;
            return tickResult();
          },
        },
        wait: async () => {
          throw error;
        },
        report: recorder.report,
      },
      new AbortController().signal,
    ),
    (value) => value === error,
  );
  assert.equal(ticks, 3);
  assert.deepEqual(recorder.reports.at(-1), {
    state: 'failed',
    cycles: 1,
    ticks: 3,
  });
  assert.deepEqual(
    recorder.reports.map(({ state }) => state),
    ['starting', 'running', 'sleeping', 'failed'],
  );
});

test('role admission accepts only an explicit boolean true result', async () => {
  for (const rows of [
    [],
    [{}],
    [{ admitted: false }],
    [{ admitted: null }],
    [{ admitted: 1 }],
    [{ admitted: 'true' }],
  ]) {
    let queries = 0;
    const tx = {
      query: async () => {
        queries++;
        return { rows };
      },
    } as unknown as PoolClient;
    await assert.rejects(
      assertReadingWorkerRole(tx),
      /least-privilege managed-runtime role/,
    );
    assert.equal(queries, 1);
  }
  let queries = 0;
  const tx = {
    query: async () => {
      queries++;
      return { rows: [{ admitted: true }] };
    },
  } as unknown as PoolClient;
  await assertReadingWorkerRole(tx);
  assert.equal(queries, 1);
});

test('role admission propagates database failures instead of treating them as admission', async () => {
  const error = new Error('role query unavailable');
  const tx = {
    query: async () => {
      throw error;
    },
  } as unknown as PoolClient;
  await assert.rejects(assertReadingWorkerRole(tx), (value) => value === error);
});
