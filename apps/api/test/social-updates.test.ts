import { SocialUpdatesDispatcher } from '../src/notifications/social/dispatcher.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type { DatabaseService } from '../src/database/database.js';
import type { IdentityService } from '../src/identity/identity.service.js';
import type { CommunitySocialSourceFacade } from '../src/community/social-source/facade.js';
import type { CommunitySocialProjectionFacade } from '../src/community/social-source/projection.js';
import type { SocialSource } from '../src/community/social-source/contracts.js';
import { CommunitySocialSourceCapture } from '../src/community/social-source/capture.js';
import type { SocialUpdatesIngress } from '../src/notifications/social/ingress.js';
import type { DiscoveryContinuationFacade } from '../src/community/discovery-continuation.module.js';
import { loadConfig } from '../src/config/config.js';
import {
  clearTransactionDeadlines,
  startTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import {
  socialUpdatesQuerySchema,
  socialNoticeSchema,
  socialUpdatesPageSchema,
  socialNoticeReadSchema,
} from '../src/notifications/social/contracts.js';
import {
  SocialUpdatesRepository,
  socialDedupeKey,
} from '../src/notifications/social/repository.js';
import type { StoredSocialNotice } from '../src/notifications/social/repository.js';
import {
  socialCursorScope,
  SocialUpdatesCursors,
} from '../src/notifications/social/cursor.js';
import { SocialUpdatesReadService } from '../src/notifications/social/read.service.js';
import {
  SocialUpdatesWorker,
  socialWorkerSchema,
  assertLocalSocialWorker,
} from '../src/notifications/social/worker.js';
import { unpunishedAccountPolicyObservation } from './support/unpunished-account-policy-observation.js';
import { ApplicationError } from '../src/http/application-error.js';
const config = loadConfig({
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://test:test@127.0.0.1:5432/whaleu_test',
  PG_SSL_MODE: 'disable',
  LOG_LEVEL: 'silent',
});
const source: SocialSource = {
  id: randomUUID(),
  kind: 'like',
  actorAccountId: randomUUID(),
  recipientAccountId: randomUUID(),
  resourceKind: 'post',
  resourceId: randomUUID(),
  postId: randomUUID(),
  rootCommentId: null,
  replyId: null,
  targetReplyId: null,
  occurredAt: '2026-10-20T00:00:00.000001Z',
  sourceEpochId: randomUUID(),
};
const notice: StoredSocialNotice = {
  id: randomUUID(),
  source_id: source.id,
  recipient_account_id: source.recipientAccountId,
  kind: 'like',
  ordinal: '1',
  created_at: '2026-10-20T00:00:01.000001Z',
  read_at: null,
};
const target = {
  type: 'community' as const,
  postId: source.postId!,
  commentId: null,
  replyId: null,
};
test('strict social contracts enforce category, bounds, privacy, target and exact unread pairing', () => {
  assert.deepEqual(socialUpdatesQuerySchema.parse({ category: 'likes' }), {
    category: 'likes',
    limit: 20,
  });
  for (const input of [
    {},
    { category: 'mentions' },
    { category: 'likes', limit: 21 },
    { category: 'likes', accountId: randomUUID() },
  ])
    assert.equal(socialUpdatesQuerySchema.safeParse(input).success, false);
  const base = {
    noticeId: notice.id,
    createdAt: notice.created_at,
    readAt: null,
  };
  assert.equal(
    socialNoticeSchema.safeParse({
      ...base,
      status: 'unavailable',
      actor: { profileId: randomUUID() },
    }).success,
    false,
  );
  assert.equal(
    socialNoticeSchema.safeParse({
      ...base,
      status: 'available',
      kind: 'like',
      target,
      actor: { profileId: randomUUID() },
    }).success,
    false,
  );
  assert.equal(
    socialNoticeSchema.safeParse({
      ...base,
      status: 'available',
      kind: 'save',
      target: { ...target, commentId: randomUUID() },
    }).success,
    false,
  );
  assert.equal(
    socialNoticeSchema.safeParse({
      ...base,
      status: 'available',
      kind: 'follow',
      target: { type: 'profile', profileId: randomUUID() },
      actor: { profileId: randomUUID(), displayName: 'Name' },
    }).success,
    false,
  );
  for (const count of [
    { unreadCount: 0, unreadCountStatus: 'unavailable' },
    { unreadCount: null, unreadCountStatus: 'available' },
    { unreadCount: 2147483648, unreadCountStatus: 'available' },
  ]) {
    assert.equal(
      socialUpdatesPageSchema.safeParse({
        items: [],
        nextCursor: null,
        ...count,
      }).success,
      false,
    );
    assert.equal(
      socialNoticeReadSchema.safeParse({
        noticeId: notice.id,
        readAt: notice.created_at,
        ...count,
      }).success,
      false,
    );
  }
  assert.equal(
    socialUpdatesPageSchema.safeParse({
      items: [],
      nextCursor: null,
      unreadCount: 0,
      unreadCountStatus: 'available',
      actorAccountId: randomUUID(),
    }).success,
    false,
  );
});
test('lifetime dedupe ignores new source/epoch/time but separates actor, owner, kind and resource', () => {
  const key = socialDedupeKey(source);
  assert.equal(
    key,
    socialDedupeKey({
      ...source,
      id: randomUUID(),
      sourceEpochId: randomUUID(),
      occurredAt: '2026-10-21T00:00:00.000001Z',
    }),
  );
  for (const changed of [
    { actorAccountId: randomUUID() },
    { recipientAccountId: randomUUID() },
    { kind: 'save' as const },
    { resourceId: randomUUID() },
  ])
    assert.notEqual(key, socialDedupeKey({ ...source, ...changed }));
});
test('opaque social cursor scope binds account, session, rotated token, category and page size', () => {
  const scope = socialCursorScope('account', 'session', 'token', 'likes', 20);
  for (const next of [
    socialCursorScope('other', 'session', 'token', 'likes', 20),
    socialCursorScope('account', 'other', 'token', 'likes', 20),
    socialCursorScope('account', 'session', 'rotated', 'likes', 20),
    socialCursorScope('account', 'session', 'token', 'saves', 20),
    socialCursorScope('account', 'session', 'token', 'likes', 10),
  ])
    assert.notEqual(scope, next);
  assert.ok(!scope.includes('account'));
});
test('asynchronous cursor decoding failures normalize to restart without masking application errors', async () => {
  const facade = {
    get: async (
      _cursor: string,
      _scope: string,
      _tx: PoolClient,
      decode: (value: unknown) => unknown,
    ) => {
      await Promise.resolve();
      return decode({ v: 2, kind: 'social-updates', head: '1' });
    },
  } as unknown as DiscoveryContinuationFacade;
  const cursors = new SocialUpdatesCursors(facade);
  await assert.rejects(
    cursors.get('opaque', 'scope', {} as PoolClient),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'DISCOVERY_RESTART_REQUIRED',
  );
  const original = new ApplicationError('COMMUNITY_UNAVAILABLE');
  facade.get = async () => {
    throw original;
  };
  await assert.rejects(
    cursors.get('opaque', 'scope', {} as PoolClient),
    (error: unknown) => error === original,
  );
});
function readFixture(kind: 'like' | 'follow' = 'like') {
  const currentSource: SocialSource =
    kind === 'follow'
      ? { ...source, kind, resourceKind: 'profile', postId: null }
      : source;
  const events: string[] = [],
    row = { ...notice, kind };
  let pending = false,
    overflow = false,
    available = true,
    failed = false,
    retired = false,
    erasing = false,
    sourceGate = true;
  const tx = {
    query: async (sql: string, p: unknown[] = []) => {
      events.push(sql);
      const policy = unpunishedAccountPolicyObservation(sql, p);
      if (policy) return policy;
      if (
        sql ===
        'SELECT id,lifecycle FROM whaleu_identity.accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE NOWAIT'
      ) {
        assert.deepEqual(p, [
          [source.actorAccountId, source.recipientAccountId].sort(),
        ]);
        return {
          rows: [source.actorAccountId, source.recipientAccountId]
            .sort()
            .map((id) => ({
              id,
              lifecycle:
                retired && id === source.actorAccountId
                  ? 'completed'
                  : 'active',
            })),
          rowCount: 2,
        };
      }
      if (
        sql ===
        'SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) AS locked'
      ) {
        assert.deepEqual(p, [`social-in-app:${source.id}`]);
        return { rows: [{ locked: sourceGate }], rowCount: 1 };
      }
      if (
        sql ===
        'SELECT whaleu_account_deletion.follow_source_retired($1) AS retired,whaleu_account_deletion.follow_source_erasing($1) AS erasing'
      ) {
        assert.deepEqual(p, [source.id]);
        return { rows: [{ retired, erasing }], rowCount: 1 };
      }
      if (sql.includes("current_setting('statement_timeout')"))
        return {
          rows: [{ statement_timeout: '0', lock_timeout: '0' }],
          rowCount: 1,
        };
      if (
        [
          "SELECT pg_advisory_xact_lock_shared(hashtextextended('whaleu:named-block-policy:v1',0))",
          'LOCK TABLE whaleu_notifications.social_work,whaleu_notifications.social_notices IN SHARE MODE NOWAIT',
          'LOCK TABLE whaleu_notifications.social_work,whaleu_notifications.social_notices IN SHARE ROW EXCLUSIVE MODE NOWAIT',
          'SAVEPOINT social_unread_count',
          'ROLLBACK TO SAVEPOINT social_unread_count',
          'RELEASE SAVEPOINT social_unread_count',
          "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
        ].includes(sql)
      )
        return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected read SQL: ${sql}`);
    },
  } as unknown as PoolClient;
  const database = {
    transaction: async <T>(fn: (tx: PoolClient) => Promise<T>) => {
      startTransactionDeadlines(tx);
      try {
        return await fn(tx);
      } finally {
        clearTransactionDeadlines(tx);
      }
    },
  } as DatabaseService;
  const identity = {
    session: async () => ({
      accountId: source.recipientAccountId,
      sessionId: randomUUID(),
    }),
  } as unknown as IdentityService;
  const records = {
    head: async () => '1',
    page: async () => [{ ...row }],
    owner: async (_a: string, _t: PoolClient, w: boolean) => {
      events.push(w ? 'owner-write' : 'owner-read');
    },
    own: async (a: string, id: string, category: string) => {
      if (
        a !== row.recipient_account_id ||
        id !== row.id ||
        category !== (kind === 'like' ? 'likes' : 'followers')
      )
        throw new ApplicationError('NOTICE_NOT_FOUND');
      return { ...row };
    },
    unread: async (
      _a: string,
      _c: string,
      _l: number,
      _t: PoolClient,
      exclude: string | null,
    ) =>
      overflow
        ? Array.from({ length: 33 }, (_, i) => ({ ...row, id: String(i) }))
        : row.read_at || exclude === row.id
          ? []
          : [{ ...row }],
    pending: async () => pending,
    markRead: async () => {
      events.push('mark-read');
      row.read_at ??= '2026-10-20T01:00:00.123456Z';
      return { ...row };
    },
  } as unknown as SocialUpdatesRepository;
  const sources = {
    source: async (id: string, client: PoolClient) => {
      assert.equal(id, source.id);
      assert.equal(client, tx);
      return currentSource;
    },
  } as unknown as CommunitySocialSourceFacade;
  const projection = {
    project: async () => {
      events.push('project');
      if (failed) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      return available ? { kind: 'like', target } : null;
    },
  } as unknown as CommunitySocialProjectionFacade;
  const cursors = {
    create: async () => {
      events.push('cursor');
      return 'opaque';
    },
  } as unknown as SocialUpdatesCursors;
  return {
    service: new SocialUpdatesReadService(
      database,
      identity,
      records,
      sources,
      projection,
      cursors,
    ),
    events,
    row,
    records,
    cursors,
    set: (options: {
      pending?: boolean;
      overflow?: boolean;
      available?: boolean;
      failed?: boolean;
      retired?: boolean;
      erasing?: boolean;
      sourceGate?: boolean;
    }) => {
      pending = options.pending ?? pending;
      overflow = options.overflow ?? overflow;
      available = options.available ?? available;
      failed = options.failed ?? failed;
      retired = options.retired ?? retired;
      erasing = options.erasing ?? erasing;
      sourceGate = options.sourceGate ?? sourceGate;
    },
  };
}
test('list and target do not read; exact count reprojects and locks domains before notification owner', async () => {
  const f = readFixture();
  const result = await f.service.list('token', {
    category: 'likes',
    limit: 20,
  });
  assert.equal(result.items[0]?.status, 'available');
  assert.equal(result.unreadCount, 1);
  assert.equal(f.row.read_at, null);
  assert.equal(
    (await f.service.target('token', notice.id, 'likes')).status,
    'available',
  );
  assert.equal(f.row.read_at, null);
  assert.ok(f.events.indexOf('project') < f.events.indexOf('owner-read'));
  assert.ok(!f.events.includes('mark-read'));
});
test('pending source, bounded overflow and transient count authority return explicit unknown, not zero', async () => {
  for (const option of [
    { pending: true },
    { overflow: true },
    { failed: true },
  ]) {
    const f = readFixture();
    f.set(option);
    assert.deepEqual(await f.service.unreadCount('token', 'likes'), {
      unreadCount: null,
      unreadCountStatus: 'unavailable',
    });
    assert.ok(f.events.includes('ROLLBACK TO SAVEPOINT social_unread_count'));
  }
});
test('unavailable notices remain owned and readable cleanup is idempotent with original timestamp', async () => {
  const f = readFixture();
  f.set({ available: false });
  const page = await f.service.list('token', { category: 'likes', limit: 20 });
  assert.deepEqual(Object.keys(page.items[0]!).sort(), [
    'createdAt',
    'noticeId',
    'readAt',
    'status',
  ]);
  assert.equal(page.unreadCount, 0);
  const first = await f.service.markRead('token', notice.id, 'likes'),
    second = await f.service.markRead('token', notice.id, 'likes');
  assert.equal(first.readAt, '2026-10-20T01:00:00.123456Z');
  assert.equal(second.readAt, first.readAt);
  assert.equal(second.unreadCount, 0);
  await assert.rejects(
    f.service.target('token', notice.id, 'followers'),
    (e: unknown) =>
      e instanceof ApplicationError && e.code === 'NOTICE_NOT_FOUND',
  );
  await assert.rejects(f.service.markRead('token', randomUUID(), 'likes'));
});

test('a retired follow sender preserves recipient first read without projection or read reset', async () => {
  const f = readFixture('follow');
  f.set({ retired: true, available: false });
  const first = await f.service.markRead('token', notice.id, 'followers');
  const second = await f.service.markRead('token', notice.id, 'followers');
  assert.equal(first.readAt, '2026-10-20T01:00:00.123456Z');
  assert.equal(second.readAt, first.readAt);
  assert.ok(!f.events.includes('project'));
  const account = f.events.findIndex((sql) =>
    sql.includes('FROM whaleu_identity.accounts'),
  );
  const gate = f.events.findIndex((sql) =>
    sql.startsWith('SELECT pg_try_advisory'),
  );
  assert.ok(
    account >= 0 && account < gate && gate < f.events.indexOf('owner-write'),
  );
});
test('fresh interaction capture refuses missing immutable source and does not enqueue self or unsupported events', async () => {
  let eventType = 'post_liked',
    facts: unknown = null,
    enrolled = 0;
  const tx = {
    query: async (sql: string) =>
      sql.startsWith('SELECT event_type')
        ? { rows: [{ event_type: eventType }] }
        : sql.startsWith('SELECT id,actor')
          ? { rows: facts ? [facts] : [] }
          : { rows: [], rowCount: 1 },
  } as unknown as PoolClient;
  const capture = new CommunitySocialSourceCapture(config, {
    enqueue: async () => {
      enrolled++;
    },
  } as unknown as SocialUpdatesIngress);
  await assert.rejects(capture.interaction(randomUUID(), tx));
  assert.equal(enrolled, 0);
  facts = {
    id: randomUUID(),
    actor_account_id: source.actorAccountId,
    resource_author_id: source.actorAccountId,
  };
  await capture.interaction(randomUUID(), tx);
  assert.equal(enrolled, 0);
  facts = {
    id: randomUUID(),
    actor_account_id: source.actorAccountId,
    resource_author_id: source.recipientAccountId,
  };
  await capture.interaction(randomUUID(), tx);
  assert.equal(enrolled, 1);
  eventType = 'reply_created';
  await capture.interaction(randomUUID(), tx);
  assert.equal(enrolled, 1);
});
test('local worker defaults to manual-only and rejects production/remote targets, duplicate selection and empty apply', () => {
  assert.equal(config.COMMUNITY_UPDATES_PROCESSING, 'manual_only');
  assert.throws(() =>
    assertLocalSocialWorker({ ...config, NODE_ENV: 'production' }),
  );
  assert.throws(() =>
    assertLocalSocialWorker({
      ...config,
      DATABASE_URL: 'postgresql://a:b@remote.example/whaleu_test',
    }),
  );
  assert.equal(socialWorkerSchema.safeParse({ mode: 'apply' }).success, false);
  assert.equal(
    socialWorkerSchema.safeParse({ sourceIds: [source.id, source.id] }).success,
    false,
  );
});
test('worker settles source-owned metadata even with no current projection, and replay is immutable', async () => {
  let settled = false,
    calls = 0;
  const tx = {
    host: '127.0.0.1',
    connection: { stream: { remoteAddress: '127.0.0.1' } },
    query: async (sql: string, params: unknown[] = []) => {
      if (sql === 'SELECT current_database() AS name') {
        assert.deepEqual(params, []);
        return { rows: [{ name: 'whaleu_test' }], rowCount: 1 };
      }
      if (
        sql ===
        "SELECT pg_advisory_xact_lock_shared(hashtextextended('whaleu:named-block-policy:v1',0))"
      ) {
        assert.deepEqual(params, []);
        return { rows: [], rowCount: 1 };
      }
      if (
        sql ===
        'SELECT id,lifecycle FROM whaleu_identity.accounts WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE NOWAIT'
      ) {
        assert.deepEqual(params, [
          [source.actorAccountId, source.recipientAccountId].sort(),
        ]);
        return {
          rows: [source.actorAccountId, source.recipientAccountId]
            .sort()
            .map((id) => ({ id, lifecycle: 'active' })),
          rowCount: 2,
        };
      }
      if (
        sql ===
        'SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS locked'
      ) {
        assert.deepEqual(params, [`social-in-app:${source.id}`]);
        return { rows: [{ locked: true }], rowCount: 1 };
      }
      if (
        sql ===
        'SELECT whaleu_account_deletion.follow_source_retired($1) AS retired,whaleu_account_deletion.follow_source_erasing($1) AS erasing'
      ) {
        assert.deepEqual(params, [source.id]);
        return { rows: [{ retired: false, erasing: false }], rowCount: 1 };
      }
      throw new Error(`Unexpected worker SQL: ${sql}`);
    },
  } as unknown as PoolClient;
  const database = {
    transaction: async <T>(fn: (tx: PoolClient) => Promise<T>) => {
      startTransactionDeadlines(tx);
      try {
        return await fn(tx);
      } finally {
        clearTransactionDeadlines(tx);
      }
    },
  } as DatabaseService;
  const records = {
    receipt: async (id: string, client: PoolClient) => {
      assert.equal(id, source.id);
      assert.equal(client, tx);
      return settled ? { outcome: 'materialized' } : null;
    },
    workState: async (id: string, client: PoolClient) => {
      assert.equal(id, source.id);
      assert.equal(client, tx);
      return settled ? 'completed' : 'pending';
    },
    owner: async (account: string, client: PoolClient, write: boolean) => {
      assert.equal(account, source.recipientAccountId);
      assert.equal(client, tx);
      assert.equal(write, true);
    },
    settle: async (current: SocialSource, client: PoolClient) => {
      assert.deepEqual(current, source);
      assert.equal(client, tx);
      settled = true;
      calls++;
      return 'materialized';
    },
    retry: async () => {
      assert.fail('Successful worker must not take retry path');
    },
  } as unknown as SocialUpdatesRepository;
  const worker = new SocialUpdatesWorker(
    database,
    config,
    {
      locate: async (id: string, client: PoolClient) => {
        assert.equal(id, source.id);
        assert.equal(client, tx);
        return {
          actorAccountId: source.actorAccountId,
          recipientAccountId: source.recipientAccountId,
        };
      },
      source: async (id: string, client: PoolClient) => {
        assert.equal(id, source.id);
        assert.equal(client, tx);
        return source;
      },
    } as unknown as CommunitySocialSourceFacade,
    records,
  );
  assert.equal(
    (await worker.run({ mode: 'apply', sourceIds: [source.id] })).materialized,
    1,
  );
  assert.equal(
    (await worker.run({ mode: 'apply', sourceIds: [source.id] }))
      .alreadyProcessed,
    1,
  );
  assert.equal(calls, 1);
});

test('source repository pagination uses a bounded exact chronology seek rather than an OR-filter cursor', async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const records = new SocialUpdatesRepository();
  await records.page(source.recipientAccountId, 'likes', 20, null, tx);
  await records.page(
    source.recipientAccountId,
    'likes',
    20,
    { beforeAt: notice.created_at, beforeOrdinal: '999' },
    tx,
  );
  assert.ok(!calls[0]!.sql.includes('(created_at,ordinal)<'));
  assert.ok(
    calls[1]!.sql.includes(
      'AND (created_at,ordinal)<($3::timestamptz,$4::bigint)',
    ),
  );
  assert.ok(!calls[1]!.sql.includes(' OR '));
  assert.deepEqual(calls[1]!.params, [
    source.recipientAccountId,
    'like',
    notice.created_at,
    '999',
    21,
  ]);
});

test('automatic cycle uses the real bounded pending queue and manual mode does not adopt it', async () => {
  const tx = {
    host: '127.0.0.1',
    connection: { stream: { remoteAddress: '127.0.0.1' } },
    query: async () => ({ rows: [{ name: 'whaleu_test' }] }),
  } as unknown as PoolClient;
  const database = {
    transaction: async <T>(fn: (tx: PoolClient) => Promise<T>) => fn(tx),
  } as DatabaseService;
  const limits: number[] = [],
    applied: unknown[] = [];
  const records = {
    work: async (limit: number) => {
      limits.push(limit);
      return [{ source_id: source.id }];
    },
  } as unknown as SocialUpdatesRepository;
  const worker = {
    run: async (input: unknown) => {
      applied.push(input);
    },
  } as unknown as SocialUpdatesWorker;
  const manual = new SocialUpdatesDispatcher(config, database, records, worker);
  await manual.cycle();
  assert.deepEqual(applied, []);
  const automatic = new SocialUpdatesDispatcher(
    {
      ...config,
      COMMUNITY_UPDATES_PROCESSING: 'automatic',
      COMMUNITY_UPDATES_BATCH_SIZE: 100,
    },
    database,
    records,
    worker,
  );
  await automatic.cycle();
  assert.deepEqual(limits, [50]);
  assert.deepEqual(applied, [{ mode: 'apply', sourceIds: [source.id] }]);
  await automatic.beforeApplicationShutdown();
});

test('shutdown during dispatcher startup does not resurrect a late timer', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let scans = 0;
  const tx = {
    host: '127.0.0.1',
    connection: { stream: { remoteAddress: '127.0.0.1' } },
    query: async () => ({ rows: [{ name: 'whaleu_test' }] }),
  } as unknown as PoolClient;
  const database = {
    transaction: async <T>(fn: (tx: PoolClient) => Promise<T>) => {
      await gate;
      return fn(tx);
    },
  } as DatabaseService;
  const records = {
    work: async () => {
      scans++;
      return [];
    },
  } as unknown as SocialUpdatesRepository;
  const dispatcher = new SocialUpdatesDispatcher(
    {
      ...config,
      COMMUNITY_UPDATES_PROCESSING: 'automatic',
      COMMUNITY_UPDATES_INTERVAL_MS: 1,
    },
    database,
    records,
    {} as SocialUpdatesWorker,
  );
  const startup = dispatcher.onApplicationBootstrap(),
    shutdown = dispatcher.beforeApplicationShutdown();
  release();
  await Promise.all([startup, shutdown]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(scans, 0);
});

test('delayed backfill stays outside old snapshots and empty pages advance by the last raw coordinate', async () => {
  const f = readFixture();
  const rows = [
    {
      ...notice,
      id: randomUUID(),
      ordinal: '3',
      created_at: '2026-10-20T04:00:00.000001Z',
    },
    {
      ...notice,
      id: randomUUID(),
      ordinal: '2',
      created_at: '2026-10-20T03:00:00.000001Z',
    },
    {
      ...notice,
      id: randomUUID(),
      ordinal: '4',
      created_at: '2026-10-20T02:00:00.000001Z',
    },
    {
      ...notice,
      id: randomUUID(),
      ordinal: '1',
      created_at: '2026-10-20T01:00:00.000001Z',
    },
  ];
  const positions = new Map<
    string,
    { head: string; beforeAt: string; beforeOrdinal: string }
  >();
  f.records.head = async () => '3';
  f.records.page = async (_account, _category, limit, before) => {
    const start = before
      ? rows.findIndex((row) => row.ordinal === before.beforeOrdinal) + 1
      : 0;
    return rows.slice(start, start + limit + 1);
  };
  f.records.own = async (_account, id) => rows.find((row) => row.id === id)!;
  f.cursors.create = async (_account, _scope, before) => {
    const key = `cursor${before.beforeOrdinal}`;
    positions.set(key, before);
    return key;
  };
  f.cursors.get = async (cursor) => ({
    v: 2,
    kind: 'social-updates',
    ...positions.get(cursor)!,
  });
  const first = await f.service.list('token', { category: 'likes', limit: 1 });
  assert.equal(first.items[0]?.noticeId, rows[0]!.id);
  const second = await f.service.list('token', {
    category: 'likes',
    limit: 1,
    cursor: first.nextCursor!,
  });
  assert.equal(second.items[0]?.noticeId, rows[1]!.id);
  const empty = await f.service.list('token', {
    category: 'likes',
    limit: 1,
    cursor: second.nextCursor!,
  });
  assert.deepEqual(empty.items, []);
  assert.ok(empty.nextCursor);
  assert.deepEqual(positions.get(empty.nextCursor), {
    head: '3',
    beforeAt: rows[2]!.created_at,
    beforeOrdinal: '4',
  });
  const last = await f.service.list('token', {
    category: 'likes',
    limit: 1,
    cursor: empty.nextCursor,
  });
  assert.equal(last.items[0]?.noticeId, rows[3]!.id);
  assert.equal(last.nextCursor, null);
});

test('materialization binds immutable source time rather than inventing dispatch time', async () => {
  const calls: { sql: string; params: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, params: unknown[]) => {
      calls.push({ sql, params });
      return { rows: [], rowCount: 1 };
    },
  } as unknown as PoolClient;
  assert.equal(
    await new SocialUpdatesRepository().settle(source, tx),
    'materialized',
  );
  const insert = calls.find((call) =>
    call.sql.startsWith('INSERT INTO whaleu_notifications.social_notices'),
  )!;
  assert.ok(insert.sql.includes('dedupe_key,created_at'));
  assert.equal(insert.params.at(-1), source.occurredAt);
});

test('source erasure or busy source gate cannot acknowledge or reset recipient notice', async () => {
  for (const option of [{ erasing: true }, { sourceGate: false }]) {
    const f = readFixture('follow');
    f.set(option);
    await assert.rejects(
      f.service.markRead('token', notice.id, 'followers'),
      (error: unknown) =>
        error instanceof ApplicationError &&
        error.code === 'COMMUNITY_UNAVAILABLE',
    );
    assert.equal(f.row.read_at, null);
    assert.ok(!f.events.includes('mark-read'));
    assert.ok(!f.events.includes('owner-write'));
  }
});
