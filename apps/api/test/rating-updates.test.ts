import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import { ApplicationError } from '../src/http/application-error.js';
import {
  ratingNoticeSchema,
  ratingNoticeTargetSchema,
  ratingNoticeReadSchema,
  ratingUpdatesEmptySchema,
  ratingUpdatesPageSchema,
  ratingUpdatesQuerySchema,
} from '../src/notifications/ratings/contracts.js';
import type { RatingNoticeEvent } from '../src/notifications/ratings/contracts.js';
import {
  RatingUpdatesCursors,
  ratingUpdatesCursorScope,
} from '../src/notifications/ratings/cursor.js';
import { RatingUpdatesReadService } from '../src/notifications/ratings/read.service.js';
import { RatingUpdatesRepository } from '../src/notifications/ratings/repository.js';
import type { StoredRatingNotice } from '../src/notifications/ratings/repository.js';
import {
  assertLocalRatingUpdatesConnection,
  assertLocalRatingUpdatesWorker,
  parseRatingUpdatesCommand,
  ratingUpdatesWorkerSchema,
  RatingUpdatesWorker,
} from '../src/notifications/ratings/worker.js';

const instant = '2026-10-09T01:00:00.123456Z';
const later = '2026-10-09T01:00:01.654321Z';
const author = () => ({
  mode: 'named' as const,
  profileId: randomUUID(),
  displayName: 'Synthetic author',
});
function notice() {
  return {
    noticeId: randomUUID(),
    createdAt: instant,
    readAt: null,
    status: 'available' as const,
    domain: 'ratings' as const,
    kind: 'reply' as const,
    reason: 'direct_reply' as const,
    target: {
      regionId: null,
      targetId: randomUUID(),
      rootId: randomUUID(),
      replyId: randomUUID(),
    },
    preview: { text: 'Synthetic reply', author: author() },
  };
}
function config(extra: Record<string, string> = {}) {
  return loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://local:local@127.0.0.1/whaleu_test',
    PG_SSL_MODE: 'disable',
    LOG_LEVEL: 'silent',
    RATINGS_UPDATES_PROCESSING: 'manual',
    ...extra,
  });
}
function localClient(
  name = 'whaleu_test',
  peer = '127.0.0.1',
  host = '127.0.0.1',
) {
  return {
    host,
    connection: { stream: { remoteAddress: peer } },
    query: async () => ({ rows: [{ name }] }),
  } as unknown as PoolClient;
}
test('Rating notices use strict safe unions, exact microseconds and rating-only ancestry', () => {
  const value = notice();
  assert.deepEqual(ratingNoticeSchema.parse(value), value);
  const unavailable = {
    noticeId: value.noticeId,
    createdAt: instant,
    readAt: later,
    status: 'unavailable',
  };
  assert.deepEqual(ratingNoticeSchema.parse(unavailable), unavailable);
  for (const invalid of [
    { ...unavailable, target: value.target },
    { ...unavailable, preview: value.preview },
    { ...value, recipientAccountId: randomUUID() },
    { ...value, domain: 'community' },
    { ...value, kind: 'root' },
    { ...value, reason: 'saved' },
    { ...value, target: { ...value.target, postId: randomUUID() } },
    { ...value, preview: { ...value.preview, replyTo: 'private old reply' } },
    { ...value, createdAt: '2026-10-09T01:00:00.1234567Z' },
    { ...value, createdAt: '2026-10-09T01:00:00+01:00' },
  ])
    assert.equal(ratingNoticeSchema.safeParse(invalid).success, false);
  const anonymous = {
    mode: 'anonymous',
    targetId: value.target.targetId,
    personaId: randomUUID(),
    displayName: 'Synthetic persona',
  };
  assert.equal(
    ratingNoticeSchema.safeParse({
      ...value,
      preview: { text: 'Valid', author: anonymous },
    }).success,
    true,
  );
  assert.equal(
    ratingNoticeSchema.safeParse({
      ...value,
      preview: {
        text: 'Valid',
        author: { ...anonymous, targetId: randomUUID() },
      },
    }).success,
    false,
  );
  assert.equal(
    ratingNoticeSchema.safeParse({
      ...value,
      preview: {
        text: 'Valid',
        author: { ...anonymous, accountId: randomUUID() },
      },
    }).success,
    false,
  );
});
test('Rating preview enforces canonical Unicode without silently normalizing output', () => {
  const value = notice();
  for (const text of ['😀'.repeat(500), 'one\ntwo\tthree'])
    assert.equal(
      ratingNoticeSchema.safeParse({
        ...value,
        preview: { ...value.preview, text },
      }).success,
      true,
    );
  for (const text of [
    '',
    ' padded ',
    'one\r\ntwo',
    '\ud800',
    'bad\u0000',
    '😀'.repeat(501),
  ])
    assert.equal(
      ratingNoticeSchema.safeParse({
        ...value,
        preview: { ...value.preview, text },
      }).success,
      false,
    );
});
test('Rating owner routes reject recipient input, unknown query, broad read and over-twenty pages', () => {
  assert.deepEqual(ratingUpdatesQuerySchema.parse({}), { limit: 20 });
  assert.deepEqual(ratingUpdatesQuerySchema.parse({ limit: '20' }), {
    limit: 20,
  });
  for (const query of [
    { limit: 21 },
    { limit: '01' },
    { limit: '0' },
    { limit: '50' },
    { limit: ['1', '2'] },
    { accountId: randomUUID() },
    { regionId: randomUUID() },
    { cursor: 'x'.repeat(42) },
    { cursor: 'x'.repeat(43) + '=' },
  ])
    assert.equal(ratingUpdatesQuerySchema.safeParse(query).success, false);
  for (const body of [
    undefined,
    { read: true },
    { all: true },
    { noticeId: randomUUID() },
  ])
    assert.equal(ratingUpdatesEmptySchema.safeParse(body).success, false);
  const value = notice();
  assert.equal(
    ratingUpdatesPageSchema.safeParse({
      items: Array.from({ length: 21 }, () => notice()),
      nextCursor: null,
      unreadCount: 21,
    }).success,
    false,
  );
  assert.equal(
    ratingUpdatesPageSchema.safeParse({
      items: [value, value],
      nextCursor: null,
      unreadCount: 1,
    }).success,
    false,
  );
  assert.equal(
    ratingNoticeTargetSchema.safeParse({
      noticeId: value.noticeId,
      status: 'unavailable',
      target: value.target,
    }).success,
    false,
  );
  assert.equal(
    ratingNoticeReadSchema.safeParse({
      noticeId: value.noticeId,
      readAt: later,
      unreadCount: 0,
      target: value.target,
    }).success,
    false,
  );
});
test('Opaque rating cursor scope binds owner, session, token generation, limit and ordering', async () => {
  const a = randomUUID(),
    session = randomUUID(),
    tx = localClient(),
    token = 'synthetic-access';
  const scope = ratingUpdatesCursorScope(a, session, token, 20);
  for (const other of [
    ratingUpdatesCursorScope(randomUUID(), session, token, 20),
    ratingUpdatesCursorScope(a, randomUUID(), token, 20),
    ratingUpdatesCursorScope(a, session, 'rotated-access', 20),
    ratingUpdatesCursorScope(a, session, token, 10),
  ])
    assert.notEqual(scope, other);
  assert.equal(scope.includes(a), false);
  let position: unknown;
  const cursors = new RatingUpdatesCursors({
    create: async (_scope: string, _account: string, value: unknown) => {
      position = value;
      return 'A'.repeat(43);
    },
    get: async (
      _cursor: string,
      _scope: string,
      _tx: PoolClient,
      validate: (value: unknown) => unknown,
    ) => validate(position),
  } as never);
  assert.equal(
    await cursors.create(a, scope, '9007199254740993', tx),
    'A'.repeat(43),
  );
  assert.equal(
    await cursors.get('A'.repeat(43), scope, tx),
    '9007199254740993',
  );
  position = { v: 1, kind: 'rating-updates', order: 'newest', before: '0' };
  await assert.rejects(
    () => cursors.get('A'.repeat(43), scope, tx),
    ApplicationError,
  );
  await assert.rejects(async () =>
    cursors.create(a, scope, '9223372036854775808', tx),
  );
});
test('Rating worker CLI is default-empty dry-run and only explicit unique maximum-fifty events', () => {
  assert.deepEqual(parseRatingUpdatesCommand([]), {
    mode: 'dry-run',
    eventIds: [],
  });
  const id = randomUUID();
  assert.deepEqual(parseRatingUpdatesCommand(['apply', `--event-id=${id}`]), {
    mode: 'apply',
    eventIds: [id],
  });
  for (const args of [
    ['apply'],
    ['--all'],
    ['--allow-production'],
    ['apply', `--event-id=${id}`, `--event-id=${id.toUpperCase()}`],
    Array.from({ length: 51 }, () => `--event-id=${randomUUID()}`),
  ])
    assert.throws(() => parseRatingUpdatesCommand(args));
  assert.equal(
    ratingUpdatesWorkerSchema.safeParse({ mode: 'apply' }).success,
    false,
  );
  assert.equal(
    ratingUpdatesWorkerSchema.safeParse({ eventIds: [id], automatic: true })
      .success,
    false,
  );
});
test('Rating worker verifies configured and actual disposable loopback database', async () => {
  assert.doesNotThrow(() => assertLocalRatingUpdatesWorker(config()));
  for (const extra of [
    { NODE_ENV: 'production' },
    { DATABASE_URL: 'postgresql://local:local@example.invalid/whaleu_test' },
    { DATABASE_URL: 'postgresql://local:local@127.0.0.1/live' },
  ])
    assert.throws(() =>
      assertLocalRatingUpdatesWorker({ ...config(), ...extra } as never),
    );
  await assertLocalRatingUpdatesConnection(localClient());
  for (const tx of [
    localClient('live'),
    localClient('whaleu_test', '10.0.0.3'),
    localClient('whaleu_test', '127.0.0.1', 'remote.invalid'),
  ])
    await assert.rejects(() => assertLocalRatingUpdatesConnection(tx));
});

function workerFixture(
  options: {
    unavailable?: boolean;
    suppressed?: boolean;
    failSecond?: boolean;
    ignored?: boolean;
    missing?: boolean;
  } = {},
) {
  const event: RatingNoticeEvent = {
    id: randomUUID(),
    sequence: '9007199254740993',
    occurredAt: instant,
    target: notice().target,
    recipients: [
      {
        accountId: '22222222-2222-4222-8222-222222222222',
        reason: 'direct_reply',
      },
      {
        accountId: '11111111-1111-4111-8111-111111111111',
        reason: 'direct_root',
      },
    ],
  };
  const order: string[] = [],
    durable: string[] = [];
  const tx = localClient();
  const database = {
    transaction: async <T>(operation: (client: PoolClient) => Promise<T>) => {
      const snapshot = [...durable];
      try {
        return await operation(tx);
      } catch (error) {
        durable.splice(0, durable.length, ...snapshot);
        throw error;
      }
    },
  };
  const records = {
    eventReceipt: async () =>
      durable.includes('complete')
        ? { outcome: 'processed', code: null }
        : null,
    owner: async (id: string) => {
      order.push(`owner:${id}`);
      durable.push(`owner:${id}`);
    },
    materialize: async (_event: unknown, recipient: { accountId: string }) => {
      order.push(`materialize:${recipient.accountId}`);
      durable.push(`notice:${recipient.accountId}`);
      if (
        options.failSecond &&
        recipient.accountId === event.recipients[0]!.accountId
      )
        throw new Error('Synthetic interrupted event');
    },
    settleRecipient: async (
      _event: string,
      recipient: { accountId: string },
    ) => {
      durable.push(`suppressed:${recipient.accountId}`);
    },
    settleEvent: async () => {
      order.push('complete');
      durable.push('complete');
    },
    retryable: async () => {
      order.push('retry');
      durable.push('retry');
    },
  };
  const source = {
    event: async () =>
      options.missing
        ? { status: 'missing' }
        : options.ignored
          ? { status: 'ignored', code: 'no_direct_updates' }
          : { status: 'ready', event },
  };
  const projection = {
    eligible: async (_target: unknown, recipient: { accountId: string }) => {
      order.push(`projection:${recipient.accountId}`);
      if (
        options.unavailable &&
        recipient.accountId === event.recipients[0]!.accountId
      )
        return { outcome: 'unavailable', code: 'authority_unavailable' };
      if (options.suppressed)
        return { outcome: 'suppressed', code: 'target_inaccessible' };
      return {
        outcome: 'eligible',
        preview: { text: 'Synthetic preview', author: author() },
      };
    },
  };
  const make = (settings = config()) =>
    new RatingUpdatesWorker(
      database as never,
      settings,
      source as never,
      projection as never,
      records as never,
    );
  return { event, order, durable, make };
}
test('Rating dry-run performs zero durable writes including owners and retries', async () => {
  for (const options of [
    {},
    { unavailable: true },
    { suppressed: true },
    { ignored: true },
    { missing: true },
  ]) {
    const f = workerFixture(options);
    const result = await f.make().run({ eventIds: [f.event.id] });
    assert.equal(result.mode, 'dry-run');
    assert.deepEqual(f.durable, []);
    assert.equal(
      f.order.some((entry) => entry.startsWith('owner:')),
      false,
    );
  }
});
test('Rating worker resolves ALL authorities before sorted owners and atomic complete; rerun is idempotent', async () => {
  const f = workerFixture();
  const result = await f.make().run({ mode: 'apply', eventIds: [f.event.id] });
  assert.equal(result.processed, 1);
  assert.equal(result.materialized, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(f.order, [
    `projection:${f.event.recipients[1]!.accountId}`,
    `projection:${f.event.recipients[0]!.accountId}`,
    `owner:${f.event.recipients[1]!.accountId}`,
    `owner:${f.event.recipients[0]!.accountId}`,
    `materialize:${f.event.recipients[1]!.accountId}`,
    `materialize:${f.event.recipients[0]!.accountId}`,
    'complete',
  ]);
  const before = [...f.durable];
  assert.equal(
    (await f.make().run({ mode: 'apply', eventIds: [f.event.id] }))
      .alreadyProcessed,
    1,
  );
  assert.deepEqual(f.durable, before);
});
test('Unknown current authority leaves the whole rating event retryable, never partially materialized', async () => {
  const f = workerFixture({ unavailable: true });
  const result = await f.make().run({ mode: 'apply', eventIds: [f.event.id] });
  assert.equal(result.retryable, 1);
  assert.equal(result.processed, 0);
  assert.equal(result.materialized, 0);
  assert.deepEqual(f.durable, ['retry']);
  assert.deepEqual(result.retryableEventIds, [f.event.id]);
});
test('Interrupted second recipient rolls back first notice, owners and completion', async () => {
  const f = workerFixture({ failSecond: true });
  const result = await f.make().run({ mode: 'apply', eventIds: [f.event.id] });
  assert.equal(result.failed, 1);
  assert.equal(result.materialized, 0);
  assert.equal(result.processed, 0);
  assert.deepEqual(f.durable, ['retry']);
});
test('Known denials are terminal suppression and missing/ignored events do not invent notices', async () => {
  const f = workerFixture({ suppressed: true });
  const result = await f.make().run({ mode: 'apply', eventIds: [f.event.id] });
  assert.equal(result.suppressed, 2);
  assert.equal(result.materialized, 0);
  assert.equal(result.processed, 1);
  assert.equal(
    f.durable.filter((entry) => entry.startsWith('notice:')).length,
    0,
  );
  for (const key of ['ignored', 'missing'] as const) {
    const other = workerFixture({ [key]: true });
    const out = await other
      .make()
      .run({ mode: 'apply', eventIds: [other.event.id] });
    assert.equal(out[key], 1);
    assert.equal(out.materialized, 0);
    assert.deepEqual(other.durable, key === 'ignored' ? ['complete'] : []);
  }
});
test('Rating worker direct invocation respects disabled config and empty apply guard', async () => {
  const f = workerFixture();
  await assert.rejects(() =>
    f
      .make(config({ RATINGS_UPDATES_PROCESSING: 'disabled' }))
      .run({ mode: 'apply', eventIds: [f.event.id] }),
  );
  await assert.rejects(() => f.make().run({ mode: 'apply' }));
  assert.deepEqual(f.durable, []);
});

function readFixture() {
  const value = notice(),
    accountId = randomUUID();
  const row: StoredRatingNotice = {
    id: value.noticeId,
    event_id: randomUUID(),
    recipient_account_id: accountId,
    kind: 'reply',
    reason: 'direct_reply',
    region_id: null,
    target_id: value.target.targetId,
    root_id: value.target.rootId,
    reply_id: value.target.replyId,
    ordinal: '9007199254740993',
    created_at: instant,
    read_at: null,
  };
  const order: string[] = [];
  let unavailable = false;
  const tx = localClient();
  const records = {
    page: async () => {
      order.push('candidates');
      return [row];
    },
    own: async () => {
      order.push('candidate');
      return row;
    },
    states: async () => {
      order.push('states');
      return new Map([[row.id, later]]);
    },
    owner: async (_account: string, _tx: PoolClient, write: boolean) => {
      order.push(write ? 'owner-update' : 'owner-share');
    },
    count: async () => {
      order.push('count');
      return 0;
    },
    markRead: async () => {
      order.push('mark-read');
      return { ...row, read_at: later };
    },
  };
  const service = new RatingUpdatesReadService(
    {
      transaction: async (
        operation: (client: PoolClient) => Promise<unknown>,
      ) => operation(tx),
    } as never,
    {
      session: async () => {
        order.push('session');
        return { accountId, sessionId: randomUUID() };
      },
    } as never,
    records as never,
    {
      eligible: async () => {
        order.push('projection');
        return unavailable
          ? { outcome: 'suppressed', code: 'target_inaccessible' }
          : { outcome: 'eligible', preview: value.preview };
      },
    } as never,
    {} as never,
  );
  return {
    service,
    row,
    order,
    unavailable: () => {
      unavailable = true;
    },
  };
}
test('Rating list projects before owner SHARE and rereads current read state, preserving SQL microseconds', async () => {
  const f = readFixture();
  const page = await f.service.list('synthetic', { limit: 20 });
  assert.equal(page.items[0]!.createdAt, instant);
  assert.equal(page.items[0]!.readAt, later);
  assert.deepEqual(f.order, [
    'session',
    'candidates',
    'projection',
    'session',
    'owner-share',
    'states',
    'count',
  ]);
  assert.equal(page.unreadCount, 0);
});
test('Rating target returns strictly unavailable after current denial without modifying read state', async () => {
  const f = readFixture();
  f.unavailable();
  assert.deepEqual(await f.service.target('synthetic', f.row.id), {
    noticeId: f.row.id,
    status: 'unavailable',
  });
  assert.deepEqual(f.order, [
    'session',
    'candidate',
    'projection',
    'session',
    'owner-share',
    'states',
  ]);
});
test('Rating count and markRead never enter parent projection after owner or reveal a target', async () => {
  const f = readFixture();
  f.unavailable();
  assert.deepEqual(await f.service.markRead('synthetic', f.row.id), {
    noticeId: f.row.id,
    readAt: later,
    unreadCount: 0,
  });
  assert.deepEqual(f.order, ['session', 'owner-update', 'mark-read', 'count']);
  f.order.length = 0;
  assert.deepEqual(await f.service.unreadCount('synthetic'), {
    unreadCount: 0,
  });
  assert.deepEqual(f.order, ['session', 'owner-share', 'count']);
});
test('Rating repository keeps notice order as bigint and readAt as exact SQL strings; missing owner notice is generic', async () => {
  const repository = new RatingUpdatesRepository(),
    calls: { sql: string; values: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as PoolClient;
  await repository.page(randomUUID(), 20, '9007199254740993', tx);
  assert.match(calls[0]!.sql, /ORDER BY n\.ordinal DESC LIMIT \$3/);
  assert.match(calls[0]!.sql, /HH24:MI:SS.US/);
  assert.equal(calls[0]!.values[1], '9007199254740993');
  assert.equal(calls[0]!.values[2], 21);
  await assert.rejects(
    () => repository.own(randomUUID(), randomUUID(), tx),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === 'NOTICE_NOT_FOUND',
  );
});
