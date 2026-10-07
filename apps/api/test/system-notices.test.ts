import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { loadConfig } from '../src/config/config.js';
import { DatabaseModule } from '../src/database/database.js';
import type { DatabaseService } from '../src/database/database.js';
import { ApplicationError } from '../src/http/application-error.js';
import { configureHttp } from '../src/http/http.js';
import { IdentityModule } from '../src/identity/identity.module.js';
import type { IdentityService } from '../src/identity/identity.service.js';
import { mintToken } from '../src/identity/tokens.js';
import { AppLogger } from '../src/observability/logger.js';
import {
  emptySystemNoticeSchema,
  postJuryRemovalNoticeSchema,
  systemNoticesQuerySchema,
} from '../src/notifications/system-notices/contracts.js';
import { SystemNoticesController } from '../src/notifications/system-notices/controller.js';
import {
  encodeSystemNoticesCursor,
  systemNoticesCursor,
} from '../src/notifications/system-notices/cursor.js';
import { SystemNoticesRepository } from '../src/notifications/system-notices/repository.js';
import type { StoredSystemNotice } from '../src/notifications/system-notices/repository.js';
import { SystemNoticesService } from '../src/notifications/system-notices/service.js';
import { SystemNoticesModule } from '../src/notifications/system-notices/system-notices.module.js';

const occurredAt = new Date('2026-10-07T12:00:00.123Z');
const errorCode = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
function notice(
  owner: string,
  patch: Partial<StoredSystemNotice> = {},
): StoredSystemNotice {
  return {
    id: randomUUID(),
    decision_id: randomUUID(),
    recipient_account_id: owner,
    kind: 'post_jury_removed',
    keep_votes: 5,
    remove_votes: 6,
    created_at: occurredAt,
    read_at: null,
    ...patch,
  };
}
function fixture() {
  const owner = randomUUID(),
    tx = {} as PoolClient;
  const rows = [notice(owner), notice(owner), notice(owner)];
  const calls: string[] = [];
  let transactions = 0,
    sessions = 0;
  let failure: Error | undefined;
  let failFinal = false;
  const database = {
    transaction: async <T>(run: (tx: PoolClient) => Promise<T>) => {
      transactions++;
      return run(tx);
    },
  };
  const identity = {
    session: async (_token: string, given: PoolClient) => {
      assert.equal(given, tx);
      calls.push('session');
      sessions++;
      if (failFinal && sessions % 2 === 0)
        throw new ApplicationError('ACCESS_TOKEN_EXPIRED');
      return { accountId: owner };
    },
  };
  const repository = {
    owner: async (account: string, given: PoolClient, write = false) => {
      assert.equal(account, owner);
      assert.equal(given, tx);
      calls.push(write ? 'owner:write' : 'owner:read');
    },
    rate: async (account: string, given: PoolClient) => {
      assert.equal(account, owner);
      assert.equal(given, tx);
      calls.push('rate');
      if (failure) throw failure;
    },
    page: async (
      account: string,
      _limit: number,
      _seek: unknown,
      given: PoolClient,
    ) => {
      assert.equal(account, owner);
      assert.equal(given, tx);
      calls.push('page');
      return rows;
    },
    count: async (account: string, given: PoolClient) => {
      assert.equal(account, owner);
      assert.equal(given, tx);
      calls.push('count');
      return rows.filter((row) => row.read_at === null).length;
    },
    markRead: async (account: string, id: string, given: PoolClient) => {
      assert.equal(account, owner);
      assert.equal(given, tx);
      calls.push('read');
      const row = rows.find((row) => row.id === id);
      if (!row) throw new ApplicationError('NOTICE_NOT_FOUND');
      row.read_at ??= new Date('2026-10-07T12:01:00.001Z');
      return row;
    },
    append: async (_input: unknown, given: PoolClient) => {
      assert.equal(given, tx);
      calls.push('append');
      if (failure) throw failure;
    },
  };
  const service = new SystemNoticesService(
    database as DatabaseService,
    identity as unknown as IdentityService,
    repository as unknown as SystemNoticesRepository,
  );
  return {
    owner,
    tx,
    rows,
    calls,
    service,
    transactions: () => transactions,
    fail: (error: Error) => {
      failure = error;
    },
    failFinal: () => {
      failFinal = true;
    },
  };
}

test('system notice contracts reject unknown keys, repeated queries and unbounded pagination', () => {
  assert.deepEqual(systemNoticesQuerySchema.parse({}), { limit: 20 });
  assert.deepEqual(systemNoticesQuerySchema.parse({ limit: '50' }), {
    limit: 50,
  });
  for (const query of [
    { limit: '0' },
    { limit: '51' },
    { limit: '01' },
    { limit: '1.5' },
    { limit: 20 },
    { limit: ['10', '20'] },
    { cursor: ['a', 'b'] },
    { cursor: '' },
    { cursor: 'a=' },
    { cursor: 'a'.repeat(1025) },
    { ownerAccountId: randomUUID() },
    { accountId: randomUUID() },
    { kind: 'post_jury_removed' },
  ])
    assert.equal(systemNoticesQuerySchema.safeParse(query).success, false);
  assert.deepEqual(emptySystemNoticeSchema.parse({}), {});
  for (const body of [
    undefined,
    null,
    [],
    { read: true },
    { readAt: occurredAt.toISOString() },
    { noticeIds: [randomUUID()] },
    { all: true },
    { target: randomUUID() },
  ])
    assert.equal(emptySystemNoticeSchema.safeParse(body).success, false);
});

test('append input accepts only source-valid removal tallies and real finite Dates', () => {
  const valid = {
    decisionId: randomUUID(),
    ownerAccountId: randomUUID(),
    keepVotes: 5,
    removeVotes: 6,
    occurredAt,
  };
  assert.equal(postJuryRemovalNoticeSchema.safeParse(valid).success, true);
  for (const patch of [
    { keepVotes: 6 },
    { keepVotes: -1 },
    { keepVotes: 0.5 },
    { removeVotes: 0 },
    { removeVotes: 7 },
    { keepVotes: 5, removeVotes: 5 },
    { occurredAt: new Date('invalid') },
    { occurredAt: occurredAt.toISOString() },
    { actorAccountId: randomUUID() },
  ])
    assert.equal(
      postJuryRemovalNoticeSchema.safeParse({ ...valid, ...patch }).success,
      false,
    );
});

test('system notice cursors are owner, purpose and limit bound without a raw owner ID', () => {
  const owner = randomUUID(),
    id = randomUUID(),
    at = occurredAt.toISOString();
  const cursor = encodeSystemNoticesCursor(at, id, owner, 20);
  assert.deepEqual(systemNoticesCursor(cursor, owner, 20), { at, id });
  assert.equal(systemNoticesCursor(undefined, owner, 20), null);
  assert.equal(
    Buffer.from(cursor, 'base64url').toString().includes(owner),
    false,
  );
  for (const args of [
    [cursor, randomUUID(), 20],
    [cursor, owner, 10],
    [cursor + '=', owner, 20],
    ['', owner, 20],
    ['a'.repeat(1025), owner, 20],
  ] as const)
    assert.throws(
      () => systemNoticesCursor(args[0], args[1], args[2]),
      BadRequestException,
    );
  const decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString());
  for (const patch of [
    { scope: 'updates:' + 'a'.repeat(64) },
    { at: '2026-10-07T12:00:00Z' },
    { at: '2026-10-07T12:00:00.123+00:00' },
    { actor: owner },
    { v: 2 },
  ])
    assert.throws(
      () =>
        systemNoticesCursor(
          Buffer.from(JSON.stringify({ ...decoded, ...patch })).toString(
            'base64url',
          ),
          owner,
          20,
        ),
      BadRequestException,
    );
});

test('leaf module imports only Identity and Database and exports its atomic append service', () => {
  assert.deepEqual(Reflect.getMetadata('imports', SystemNoticesModule), [
    DatabaseModule,
    IdentityModule,
  ]);
  assert.deepEqual(Reflect.getMetadata('exports', SystemNoticesModule), [
    SystemNoticesService,
  ]);
});

test('owner notices expose only immutable summary data, page by limit and retain an exact unread count', async () => {
  const f = fixture();
  const result = await f.service.list('session', { limit: 2 });
  assert.equal(result.items.length, 2);
  assert.equal(result.unreadCount, 3);
  assert.deepEqual(result.items[0], {
    noticeId: f.rows[0]!.id,
    kind: 'post_jury_removed',
    createdAt: occurredAt.toISOString(),
    readAt: null,
    keepVotes: 5,
    removeVotes: 6,
  });
  assert.deepEqual(systemNoticesCursor(result.nextCursor!, f.owner, 2), {
    at: occurredAt.toISOString(),
    id: f.rows[1]!.id,
  });
  const serialized = JSON.stringify(result);
  for (const value of [f.owner, ...f.rows.map((row) => row.decision_id)])
    assert.equal(serialized.includes(value), false);
  assert.deepEqual(f.calls, [
    'session',
    'owner:read',
    'rate',
    'page',
    'count',
    'session',
  ]);
  const short = fixture();
  assert.equal(
    (await short.service.list('session', { limit: 20 })).nextCursor,
    null,
  );
});

test('only owned exact notices can be marked read and retries preserve first readAt and counts', async () => {
  const f = fixture();
  const first = await f.service.markRead('session', f.rows[0]!.id);
  const replay = await f.service.markRead('session', f.rows[0]!.id);
  assert.deepEqual(first, replay);
  assert.deepEqual(first, {
    noticeId: f.rows[0]!.id,
    readAt: '2026-10-07T12:01:00.001Z',
    unreadCount: 2,
  });
  assert.deepEqual(await f.service.unreadCount('session'), { unreadCount: 2 });
  await assert.rejects(
    f.service.markRead('session', randomUUID()),
    errorCode('NOTICE_NOT_FOUND'),
  );
  assert.deepEqual(f.calls.slice(0, 6), [
    'session',
    'owner:write',
    'rate',
    'read',
    'count',
    'session',
  ]);
});

test('all owner endpoints reauthenticate after their work and preserve expiry failures', async () => {
  for (const method of ['list', 'count', 'read'] as const) {
    const f = fixture();
    f.failFinal();
    await assert.rejects(
      method === 'list'
        ? f.service.list('session', { limit: 20 })
        : method === 'count'
          ? f.service.unreadCount('session')
          : f.service.markRead('session', f.rows[0]!.id),
      errorCode('ACCESS_TOKEN_EXPIRED'),
    );
    assert.equal(f.calls.at(-1), 'session');
  }
});

test('unknown storage errors become safe unavailability while rate and owner denials remain typed', async () => {
  const f = fixture();
  f.fail(new Error('password secret raw database query'));
  await assert.rejects(
    f.service.list('session', { limit: 20 }),
    errorCode('SYSTEM_NOTICES_UNAVAILABLE'),
  );
  f.fail(new ApplicationError('RATE_LIMITED'));
  await assert.rejects(
    f.service.unreadCount('session'),
    errorCode('RATE_LIMITED'),
  );
});

test('append participates in the provided settlement transaction without opening an independent one', async () => {
  const f = fixture();
  const input = {
    decisionId: randomUUID(),
    ownerAccountId: f.owner,
    keepVotes: 5,
    removeVotes: 6,
    occurredAt,
  };
  await f.service.appendPostJuryRemoval(input, f.tx);
  assert.equal(f.transactions(), 0);
  assert.deepEqual(f.calls, ['owner:write', 'append']);
  await assert.rejects(
    f.service.appendPostJuryRemoval({ ...input, keepVotes: 6 }, f.tx),
    errorCode('SYSTEM_NOTICES_UNAVAILABLE'),
  );
  f.fail(new Error('raw storage error'));
  await assert.rejects(
    f.service.appendPostJuryRemoval(input, f.tx),
    errorCode('SYSTEM_NOTICES_UNAVAILABLE'),
  );
  assert.equal(f.transactions(), 0);
});

test('repository uses bounded owner-keyed rates, owner-scoped SQL and atomic first-read timestamps', async () => {
  const repository = new SystemNoticesRepository();
  const owner = randomUUID(),
    row = notice(owner, { read_at: occurredAt });
  const statements: { sql: string; values: unknown[] | undefined }[] = [];
  let hits = 120,
    found = true;
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      if (sql.includes('RETURNING hits')) return { rows: [{ hits }] };
      if (sql.startsWith('UPDATE whaleu_notifications.system_notices'))
        return { rows: found ? [row] : [] };
      if (sql.includes('AS count')) return { rows: [{ count: 2147483647 }] };
      return { rows: [row] };
    },
  } as unknown as PoolClient;
  await repository.rate(owner, tx);
  assert.match(statements.at(-1)!.sql, /ON CONFLICT\(account_id\).*DO UPDATE/s);
  assert.match(statements.at(-1)!.sql, /LEAST\(.*hits\+1,1000000\)/s);
  hits = 121;
  await assert.rejects(repository.rate(owner, tx), errorCode('RATE_LIMITED'));
  const seek = { at: occurredAt.toISOString(), id: row.id };
  await repository.page(owner, 50, seek, tx);
  assert.deepEqual(statements.at(-1)!.values, [owner, seek.at, row.id, 51]);
  assert.match(statements.at(-1)!.sql, /WHERE recipient_account_id=\$1/);
  assert.match(statements.at(-1)!.sql, /ORDER BY created_at DESC,id DESC/);
  await repository.markRead(owner, row.id, tx);
  assert.deepEqual(statements.at(-1)!.values, [row.id, owner]);
  assert.match(statements.at(-1)!.sql, /COALESCE\(read_at,/);
  assert.match(
    statements.at(-1)!.sql,
    /WHERE id=\$1 AND recipient_account_id=\$2/,
  );
  found = false;
  await assert.rejects(
    repository.markRead(owner, randomUUID(), tx),
    errorCode('NOTICE_NOT_FOUND'),
  );
  assert.equal(await repository.count(owner, tx), 2147483647);
  assert.match(
    statements.at(-1)!.sql,
    /LEAST\(count\(\*\),2147483647\)::integer/,
  );
});

test('repository append preserves deduplication and rejects a conflicting replay', async () => {
  const repository = new SystemNoticesRepository(),
    owner = randomUUID(),
    row = notice(owner);
  const statements: { sql: string; values: unknown[] | undefined }[] = [];
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, values });
      return { rows: [row] };
    },
  } as unknown as PoolClient;
  const input = {
    decisionId: row.decision_id,
    ownerAccountId: owner,
    keepVotes: row.keep_votes,
    removeVotes: row.remove_votes,
    occurredAt,
  };
  await repository.append(input, tx);
  await repository.append(input, tx);
  assert.match(
    statements[0]!.sql,
    /ON CONFLICT\(decision_id,recipient_account_id\) DO NOTHING/,
  );
  assert.deepEqual(statements[0]!.values?.slice(1), [
    row.decision_id,
    owner,
    5,
    6,
    occurredAt,
  ]);
  await assert.rejects(
    repository.append({ ...input, keepVotes: 4 }, tx),
    errorCode('SYSTEM_NOTICES_UNAVAILABLE'),
  );
  await assert.rejects(
    repository.append(
      { ...input, occurredAt: new Date(occurredAt.getTime() + 1) },
      tx,
    ),
    errorCode('SYSTEM_NOTICES_UNAVAILABLE'),
  );
});

test('HTTP system notice surface rejects repeated/unknown keys and broad read actions', async () => {
  const calls: unknown[][] = [];
  const service = {
    list: async (...args: unknown[]) => {
      calls.push(['list', ...args]);
      return { items: [], nextCursor: null, unreadCount: 0 };
    },
    unreadCount: async (...args: unknown[]) => {
      calls.push(['count', ...args]);
      return { unreadCount: 0 };
    },
    markRead: async (...args: unknown[]) => {
      calls.push(['read', ...args]);
      return {
        noticeId: args[1],
        readAt: occurredAt.toISOString(),
        unreadCount: 0,
      };
    },
  };
  const logger = new AppLogger(
    loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: 'postgresql://local:local@127.0.0.1/whaleu_test',
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
    }),
  );
  const module = await Test.createTestingModule({
    controllers: [SystemNoticesController],
    providers: [
      { provide: SystemNoticesService, useValue: service },
      { provide: AppLogger, useValue: logger },
    ],
  }).compile();
  const app = module.createNestApplication({ logger: false });
  configureHttp(app);
  await app.init();
  try {
    const base = '/v1/me/system-notices',
      token = mintToken('access'),
      auth = `Bearer ${token}`,
      id = randomUUID();
    const first = await request(app.getHttpServer())
      .get(base)
      .set('authorization', auth)
      .expect(200);
    assert.deepEqual(first.body, {
      items: [],
      nextCursor: null,
      unreadCount: 0,
    });
    assert.deepEqual(calls.pop(), ['list', token, { limit: 20 }]);
    await request(app.getHttpServer())
      .get(base + '/unread-count')
      .set('authorization', auth)
      .expect(200);
    assert.deepEqual(calls.pop(), ['count', token]);
    await request(app.getHttpServer())
      .put(base + `/${id}/read`)
      .set('authorization', auth)
      .send({})
      .expect(200);
    assert.deepEqual(calls.pop(), ['read', token, id]);
    await request(app.getHttpServer()).get(base).expect(401);
    for (const suffix of [
      '?limit=1&limit=2',
      '?cursor=a&cursor=b',
      '?limit=51',
      '?ownerAccountId=' + randomUUID(),
      '/unread-count?limit=20',
    ])
      await request(app.getHttpServer())
        .get(base + suffix)
        .set('authorization', auth)
        .expect(400);
    for (const body of [
      { read: false },
      { all: true },
      { actorAccountId: randomUUID() },
      { noticeIds: [id] },
    ])
      await request(app.getHttpServer())
        .put(base + `/${id}/read`)
        .set('authorization', auth)
        .send(body)
        .expect(400);
    await request(app.getHttpServer())
      .put(base + `/${id}/read?all=true`)
      .set('authorization', auth)
      .send({})
      .expect(400);
    await request(app.getHttpServer())
      .put(base + '/not-a-uuid/read')
      .set('authorization', auth)
      .send({})
      .expect(400);
    await request(app.getHttpServer())
      .put(base + '/read-all')
      .set('authorization', auth)
      .send({})
      .expect(404);
    await request(app.getHttpServer())
      .get(base + `/${id}/target`)
      .set('authorization', auth)
      .expect(404);
    assert.deepEqual(calls, []);
  } finally {
    await app.close();
  }
});
