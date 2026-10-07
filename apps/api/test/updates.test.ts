import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import type { RuntimeConfig } from '../src/config/config.js';
import type { DatabaseService } from '../src/database/database.js';
import { CommunityUpdatesFacade } from '../src/community/updates.facade.js';
import type { NotificationsRepository } from '../src/notifications/repository.js';
import type { UpdatesWorker } from '../src/notifications/worker.js';
import { UpdatesDispatcher } from '../src/notifications/dispatcher.js';
import {
  updatesQuerySchema,
  emptyUpdatesSchema,
} from '../src/notifications/contracts.js';
import {
  updatesCursor,
  encodeUpdatesCursor,
} from '../src/notifications/cursor.js';
import {
  parseUpdatesCommand,
  assertLocalUpdatesWorker,
} from '../src/notifications/worker-options.js';
const config = (extra: Record<string, string> = {}) =>
  loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://local:local@127.0.0.1/whaleu_test',
    PG_SSL_MODE: 'disable',
    LOG_LEVEL: 'silent',
    ...extra,
  });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function dispatcherFixture(
  mode: RuntimeConfig['COMMUNITY_UPDATES_PROCESSING'] = 'automatic',
) {
  const cursorGate = deferred(),
    workerGate = deferred();
  let cursorReads = 0,
    discoveries = 0,
    workerRuns = 0,
    finished = 0;
  let blockCursor = false,
    blockWorker = false,
    queued = true;
  const db = {
    transaction: async <T>(run: (tx: PoolClient) => Promise<T>) =>
      run({} as PoolClient),
  };
  const repository = {
    discoveryCursor: async () => {
      cursorReads++;
      if (blockCursor) await cursorGate.promise;
      return '0';
    },
    enqueueAutomatic: async () => undefined,
    pendingAutomatic: async () => (queued ? [{ event_id: randomUUID() }] : []),
    finishAutomatic: async () => {
      queued = false;
      finished++;
    },
    retryable: async () => undefined,
  };
  const community = {
    enrolledAfter: async () => {
      discoveries++;
      return [];
    },
  };
  const worker = {
    run: async () => {
      workerRuns++;
      if (blockWorker) await workerGate.promise;
      return { retryable: 0 };
    },
  };
  const dispatcher = new UpdatesDispatcher(
    config({
      COMMUNITY_UPDATES_PROCESSING: mode,
      COMMUNITY_UPDATES_INTERVAL_MS: '10',
    }),
    db as DatabaseService,
    community as unknown as CommunityUpdatesFacade,
    repository as unknown as NotificationsRepository,
    worker as unknown as UpdatesWorker,
  );
  return {
    dispatcher,
    cursorGate,
    workerGate,
    blockCursor: () => {
      blockCursor = true;
    },
    blockWorker: () => {
      blockWorker = true;
    },
    counters: () => ({ cursorReads, discoveries, workerRuns, finished }),
  };
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timed out');
    await delay(5);
  }
}
test('Updates queries reject caller actors, broad read actions and malformed pagination', () => {
  assert.deepEqual(updatesQuerySchema.parse({}), { limit: 20 });
  assert.equal(updatesQuerySchema.parse({ limit: '50' }).limit, 50);
  for (const query of [
    { limit: '51' },
    { limit: '0' },
    { limit: '01' },
    { accountId: randomUUID() },
    { cursor: 'bad=' },
    { all: true },
  ])
    assert.equal(updatesQuerySchema.safeParse(query).success, false);
  for (const body of [
    { all: true },
    { noticeIds: [randomUUID()] },
    { accountId: randomUUID() },
    { read: false },
  ])
    assert.equal(emptyUpdatesSchema.safeParse(body).success, false);
});
test('Updates cursor is owner/limit/purpose bound and never carries raw owner identity', () => {
  const owner = randomUUID(),
    other = randomUUID(),
    id = randomUUID(),
    at = '2026-10-07T00:00:00.000Z';
  const cursor = encodeUpdatesCursor(at, id, owner, 20);
  assert.deepEqual(updatesCursor(cursor, owner, 20), { at, id });
  assert.equal(
    Buffer.from(cursor, 'base64url').toString().includes(owner),
    false,
  );
  assert.throws(() => updatesCursor(cursor, other, 20));
  assert.throws(() => updatesCursor(cursor, owner, 10));
  assert.throws(() => updatesCursor(cursor + '=', owner, 20));
  const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  parsed.scope = 'saved';
  assert.throws(() =>
    updatesCursor(
      Buffer.from(JSON.stringify(parsed)).toString('base64url'),
      owner,
      20,
    ),
  );
});
test('Internal command is default-empty dry-run, bounded explicit selection, no production escape hatch', () => {
  assert.deepEqual(parseUpdatesCommand([]), { mode: 'dry-run', eventIds: [] });
  const id = randomUUID();
  assert.deepEqual(parseUpdatesCommand(['apply', `--event-id=${id}`]), {
    mode: 'apply',
    eventIds: [id],
  });
  for (const args of [
    ['apply'],
    ['--all'],
    ['--allow-production'],
    ['apply', `--event-id=${id}`, `--event-id=${id}`],
    Array.from({ length: 51 }, () => `--event-id=${randomUUID()}`),
  ])
    assert.throws(() => parseUpdatesCommand(args));
  assert.doesNotThrow(() => assertLocalUpdatesWorker(config()));
  assert.throws(() =>
    assertLocalUpdatesWorker({ ...config(), NODE_ENV: 'production' }),
  );
  assert.throws(() =>
    assertLocalUpdatesWorker({
      ...config(),
      DATABASE_URL: 'postgresql://local:local@example.invalid/db',
    }),
  );
});
test('Processing defaults manual-only, unknown settings fail closed', () => {
  assert.equal(config().COMMUNITY_UPDATES_PROCESSING, 'manual_only');
  assert.throws(() => config({ COMMUNITY_UPDATES_PROCESSING: 'enabled' }));
  assert.throws(() => config({ COMMUNITY_UPDATES_BATCH_SIZE: '51' }));
});
test('Default-off/disabled dispatcher never discovers or processes events', async () => {
  for (const mode of ['manual_only', 'disabled'] as const) {
    const fixture = dispatcherFixture(mode);
    await fixture.dispatcher.onApplicationBootstrap();
    await fixture.dispatcher.start();
    await delay(25);
    await fixture.dispatcher.stop();
    assert.deepEqual(fixture.counters(), {
      cursorReads: 0,
      discoveries: 0,
      workerRuns: 0,
      finished: 0,
    });
  }
});
test('Dispatcher shares concurrent initialization and stop cancels deferred startup', async () => {
  const fixture = dispatcherFixture();
  fixture.blockCursor();
  const first = fixture.dispatcher.start(),
    second = fixture.dispatcher.start();
  assert.equal(fixture.counters().cursorReads, 1);
  let stopped = false;
  const stop = fixture.dispatcher.stop().then(() => {
    stopped = true;
  });
  await delay(10);
  assert.equal(stopped, false);
  fixture.cursorGate.resolve();
  await Promise.all([first, second, stop]);
  await delay(30);
  assert.deepEqual(fixture.counters(), {
    cursorReads: 1,
    discoveries: 0,
    workerRuns: 0,
    finished: 0,
  });
});
test('Dispatcher stop waits for in-flight processing then never schedules another tick', async () => {
  const fixture = dispatcherFixture();
  fixture.blockWorker();
  await fixture.dispatcher.start();
  await until(() => fixture.counters().workerRuns === 1);
  let stopped = false;
  const stop = fixture.dispatcher.stop().then(() => {
    stopped = true;
  });
  await delay(15);
  assert.equal(stopped, false);
  fixture.workerGate.resolve();
  await stop;
  const counts = fixture.counters();
  assert.equal(counts.finished, 1);
  await delay(30);
  assert.deepEqual(fixture.counters(), counts);
});
test('Explicit enabled dispatcher start/stop/restart does not duplicate timer chains', async () => {
  const fixture = dispatcherFixture();
  await Promise.all([fixture.dispatcher.start(), fixture.dispatcher.start()]);
  await until(() => fixture.counters().finished === 1);
  await fixture.dispatcher.stop();
  assert.equal(fixture.counters().workerRuns, 1);
  await fixture.dispatcher.start();
  await delay(25);
  await fixture.dispatcher.stop();
  assert.equal(fixture.counters().workerRuns, 1);
});

test('Restart during an in-flight stop waits for old work and cannot revive an old timer chain', async () => {
  const fixture = dispatcherFixture();
  fixture.blockWorker();
  await fixture.dispatcher.start();
  await until(() => fixture.counters().workerRuns === 1);
  let stopped = false,
    restarted = false;
  const stop = fixture.dispatcher.stop().then(() => {
    stopped = true;
  });
  const restart = fixture.dispatcher.start().then(() => {
    restarted = true;
    assert.equal(stopped, true);
  });
  await delay(15);
  assert.equal(stopped, false);
  assert.equal(restarted, false);
  fixture.workerGate.resolve();
  await Promise.all([stop, restart]);
  await delay(25);
  await fixture.dispatcher.stop();
  const counts = fixture.counters();
  assert.equal(counts.workerRuns, 1);
  assert.equal(counts.finished, 1);
  await delay(30);
  assert.deepEqual(fixture.counters(), counts);
});

test('Typed authority denial is terminal suppression while unavailable stays retryable without adding new credential gates', async () => {
  const accountId = randomUUID(),
    target = { postId: randomUUID(), commentId: randomUUID(), replyId: null };
  const recipient = { accountId, reason: 'direct' as const, saveEpochId: null };
  for (const decision of [
    { kind: 'deny', reason: 'STUDENT_VERIFICATION_REQUIRED' },
    { kind: 'deny', reason: 'AUTHORIZATION_REQUIRED' },
    { kind: 'unavailable' },
  ]) {
    const access = {
      accessiblePost: async () => ({
        post: { id: target.postId },
        space: { id: randomUUID() },
      }),
      authorization: { resolve: async () => decision },
    };
    const facade = new CommunityUpdatesFacade(
      {} as never,
      access as never,
      {} as never,
      {} as never,
      { activeAccount: async () => true } as never,
    );
    assert.deepEqual(
      await facade.eligible(target, recipient, {} as PoolClient),
      decision.kind === 'deny'
        ? { outcome: 'suppressed', code: 'target_inaccessible' }
        : { outcome: 'unavailable', code: 'authority_unavailable' },
    );
  }
});
