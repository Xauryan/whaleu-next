import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuthorizationService } from '../src/authorization/authorization.service.js';
import type { ActiveGrant } from '../src/authorization/contracts.js';
import type { AuthorizationRepository } from '../src/authorization/authorization.repository.js';
import type { DatabaseService } from '../src/database/database.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
  checkTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';
import type { IdentityService } from '../src/identity/identity.service.js';
import { FeedbackNoticeAuthority } from '../src/notifications/feedback/authority.js';
import {
  feedbackNoticesQuerySchema,
  feedbackPublicationNoticeSchema,
} from '../src/notifications/feedback/contracts.js';
import type { FeedbackNoticeTargetSource } from '../src/notifications/feedback/contracts.js';
import {
  encodeFeedbackNoticesCursor,
  feedbackNoticesCursor,
} from '../src/notifications/feedback/cursor.js';
import { FeedbackNotificationsFacade } from '../src/notifications/feedback/facade.js';
import { FeedbackNoticesRepository } from '../src/notifications/feedback/repository.js';
import type { StoredFeedbackNotice } from '../src/notifications/feedback/repository.js';
import { FeedbackNoticesService } from '../src/notifications/feedback/service.js';

const occurredAt = new Date('2026-10-11T12:00:00.123Z');
const errorCode = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
const grant = (
  role: ActiveGrant['role'],
  patch: Partial<ActiveGrant> = {},
): ActiveGrant => ({
  id: randomUUID(),
  role,
  operatingRegionId: role === 'school_admin' ? randomUUID() : null,
  validUntil: null,
  ...patch,
});

test('feedback candidate discovery is super-admin-only, active, ordered and bounded with a fail-closed sentinel', async () => {
  const owner = randomUUID();
  let candidates = [owner];
  let sql = '';
  const tx = {
    query: async (statement: string) => {
      sql = statement;
      return { rows: candidates.map((account_id) => ({ account_id })) };
    },
  } as unknown as PoolClient;
  const service = new AuthorizationService(
    {} as DatabaseService,
    {} as IdentityService,
    {} as AuthorizationRepository,
  );
  assert.deepEqual(await service.feedbackRecipientAccountIds(tx), [owner]);
  assert.match(sql, /role='super_admin' AND operating_region_id IS NULL/);
  assert.match(sql, /revoked_at IS NULL AND valid_from<=clock_timestamp\(\)/);
  assert.match(sql, /expires_at>clock_timestamp\(\)/);
  assert.match(sql, /ORDER BY account_id LIMIT 1025/);
  candidates = Array.from({ length: 1025 }, () => randomUUID());
  await assert.rejects(
    service.feedbackRecipientAccountIds(tx),
    errorCode('AUTHORIZATION_UNAVAILABLE'),
  );
});

test('feedback authority never treats developer or school_admin as super_admin and retains expiry through final commit checks', async () => {
  let grants: ActiveGrant[] = [];
  const tx = {
    query: async () => ({ rows: [{ now: new Date(2000) }] }),
  } as unknown as PoolClient;
  const authority = new FeedbackNoticeAuthority({
    grants: async () => grants,
  } as unknown as AuthorizationService);
  for (const roles of [
    [],
    [grant('developer')],
    [grant('school_admin')],
    [grant('developer'), grant('school_admin')],
    [grant('super_admin', { operatingRegionId: randomUUID() })],
  ]) {
    grants = roles;
    await assert.rejects(
      authority.require(randomUUID(), tx),
      errorCode('AUTHORIZATION_REQUIRED'),
    );
  }
  grants = [grant('developer'), grant('super_admin', { validUntil: 1000 })];
  startTransactionDeadlines(tx);
  try {
    await authority.require(randomUUID(), tx);
    await assert.rejects(
      checkTransactionDeadlines(tx),
      errorCode('AUTHORIZATION_UNAVAILABLE'),
    );
  } finally {
    clearTransactionDeadlines(tx);
  }
});

test('feedback fan-out uses fresh grants and active accounts, deduplicates candidates and stays in the source transaction', async () => {
  const admin = randomUUID(),
    developer = randomUUID(),
    regional = randomUUID(),
    inactive = randomUUID(),
    revoked = randomUUID();
  const tx = {} as PoolClient;
  const candidates = [regional, inactive, admin, developer, admin, revoked];
  const grants = new Map<string, ActiveGrant[]>([
    [admin, [grant('developer'), grant('super_admin')]],
    [developer, [grant('developer')]],
    [regional, [grant('school_admin')]],
    [revoked, []],
  ]);
  const events: string[] = [],
    delivered: string[] = [];
  const authorization = {
    feedbackRecipientAccountIds: async (given: PoolClient) => {
      assert.equal(given, tx);
      return candidates;
    },
    grants: async (id: string, given: PoolClient) => {
      assert.equal(given, tx);
      events.push(`grant:${id}`);
      return grants.get(id) ?? [];
    },
  } as unknown as AuthorizationService;
  const identity = {
    activeAccount: async (id: string, given: PoolClient) => {
      assert.equal(given, tx);
      events.push(`account:${id}`);
      return id !== inactive;
    },
  } as unknown as IdentityService;
  const records = {
    owner: async (id: string, given: PoolClient, write: boolean) => {
      assert.equal(given, tx);
      assert.equal(write, true);
      events.push(`owner:${id}`);
    },
    append: async (
      input: unknown,
      id: string,
      grantId: string,
      given: PoolClient,
    ) => {
      assert.equal(given, tx);
      assert.equal(grantId, grants.get(admin)![1]!.id);
      assert.deepEqual(input, publication);
      delivered.push(id);
    },
  } as unknown as FeedbackNoticesRepository;
  const facade = new FeedbackNotificationsFacade(
    authorization,
    identity,
    new FeedbackNoticeAuthority(authorization),
    records,
  );
  const publication = { postId: randomUUID(), occurredAt };
  await facade.recordPublication(publication, tx);
  assert.deepEqual(delivered, [admin]);
  assert.equal(events.filter((x) => x === `account:${admin}`).length, 1);
  assert.equal(events.includes(`grant:${inactive}`), false);
  assert.equal(events.at(-1), `owner:${admin}`);
  await assert.rejects(
    facade.recordPublication({ ...publication, postId: 'invalid' }, tx),
    errorCode('SYSTEM_NOTICES_UNAVAILABLE'),
  );
});

function fixture() {
  const owner = randomUUID(),
    calls: string[] = [];
  const tx = { query: async () => ({ rows: [] }) } as unknown as PoolClient;
  let active = true,
    accessible = true,
    sessions = 0,
    expireFinal = false;
  const rows: StoredFeedbackNotice[] = [0, 1, 2].map(() => ({
    id: randomUUID(),
    post_id: randomUUID(),
    recipient_account_id: owner,
    recipient_grant_id: randomUUID(),
    kind: 'feedback_created',
    created_at: occurredAt,
    read_at: null,
  }));
  const own = (id: string) => {
    const row = rows.find((row) => row.id === id);
    if (!row) throw new ApplicationError('NOTICE_NOT_FOUND');
    return row;
  };
  const repository = {
    owner: async (account: string, given: PoolClient, write = false) => {
      assert.equal(account, owner);
      assert.equal(given, tx);
      calls.push(write ? 'owner:write' : 'owner:read');
    },
    rate: async () => {
      calls.push('rate');
    },
    page: async (account: string) => {
      assert.equal(account, owner);
      calls.push('page');
      return rows;
    },
    count: async (account: string) => {
      assert.equal(account, owner);
      return rows.filter((row) => row.read_at === null).length;
    },
    own: async (account: string, id: string) => {
      assert.equal(account, owner);
      calls.push('own');
      return own(id);
    },
    markRead: async (account: string, id: string) => {
      assert.equal(account, owner);
      calls.push('read');
      const row = own(id);
      row.read_at ??= occurredAt;
      return row;
    },
  } as unknown as FeedbackNoticesRepository;
  const identity = {
    session: async () => {
      calls.push('session');
      sessions++;
      if (expireFinal && sessions % 2 === 0)
        throw new ApplicationError('ACCESS_TOKEN_EXPIRED');
      return { accountId: owner };
    },
  } as unknown as IdentityService;
  const authority = {
    require: async () => {
      calls.push('authority');
      if (!active) throw new ApplicationError('AUTHORIZATION_REQUIRED');
    },
  } as unknown as FeedbackNoticeAuthority;
  const targets = {
    accessible: async (account: string, id: string, given: PoolClient) => {
      assert.equal(account, owner);
      assert.ok(rows.some((row) => row.post_id === id));
      assert.equal(given, tx);
      calls.push('target');
      return accessible;
    },
  } as FeedbackNoticeTargetSource;
  const database = {
    transaction: async <T>(run: (tx: PoolClient) => Promise<T>) => {
      startTransactionDeadlines(tx);
      try {
        return await run(tx);
      } finally {
        clearTransactionDeadlines(tx);
      }
    },
  } as DatabaseService;
  return {
    owner,
    rows,
    calls,
    service: new FeedbackNoticesService(
      database,
      identity,
      authority,
      repository,
      targets,
    ),
    revoke: () => {
      active = false;
    },
    hide: () => {
      accessible = false;
    },
    expire: () => {
      expireFinal = true;
    },
  };
}

test('feedback listing is private metadata only, retains owner-bound pagination and never auto-reads', async () => {
  const f = fixture(),
    page = await f.service.list('token', { limit: 2 });
  assert.equal(page.items.length, 2);
  assert.equal(page.unreadCount, 3);
  assert.deepEqual(Object.keys(page.items[0]!).sort(), [
    'createdAt',
    'kind',
    'noticeId',
    'readAt',
  ]);
  assert.deepEqual(feedbackNoticesCursor(page.nextCursor!, f.owner, 2), {
    at: occurredAt.toISOString(),
    id: f.rows[1]!.id,
  });
  for (const secret of [
    f.owner,
    ...f.rows.flatMap((row) => [row.post_id, row.recipient_grant_id]),
  ])
    assert.equal(JSON.stringify(page).includes(secret), false);
  assert.equal(f.calls.includes('target'), false);
  assert.equal(f.calls.includes('read'), false);
  assert.deepEqual(f.calls.slice(-2), ['session', 'authority']);
});

test('all feedback endpoints require current super_admin and cannot retrieve another owners notice', async () => {
  for (const method of ['list', 'count', 'target', 'read'] as const) {
    const f = fixture();
    f.revoke();
    await assert.rejects(
      method === 'list'
        ? f.service.list('token', { limit: 20 })
        : method === 'count'
          ? f.service.unreadCount('token')
          : method === 'target'
            ? f.service.target('token', f.rows[0]!.id)
            : f.service.markRead('token', f.rows[0]!.id),
      errorCode('AUTHORIZATION_REQUIRED'),
    );
    assert.deepEqual(f.calls, ['session', 'authority']);
  }
  const f = fixture();
  await assert.rejects(
    f.service.target('token', randomUUID()),
    errorCode('NOTICE_NOT_FOUND'),
  );
  assert.equal(f.calls.includes('target'), false);
});

test('feedback navigation/read recheck exact target, hide locators after denial and lock source before owner', async () => {
  const f = fixture(),
    row = f.rows[0]!;
  assert.deepEqual(await f.service.target('token', row.id), {
    noticeId: row.id,
    status: 'available',
    postId: row.post_id,
  });
  assert.ok(f.calls.indexOf('target') < f.calls.indexOf('owner:read'));
  f.hide();
  assert.deepEqual(await f.service.target('token', row.id), {
    noticeId: row.id,
    status: 'unavailable',
  });
  await assert.rejects(
    f.service.markRead('token', row.id),
    errorCode('NOTICE_NOT_FOUND'),
  );
  assert.equal(row.read_at, null);
});

test('read acknowledgment is monotonic, counted independently and reauthenticated before response', async () => {
  const f = fixture(),
    row = f.rows[0]!;
  const first = await f.service.markRead('token', row.id),
    replay = await f.service.markRead('token', row.id);
  assert.deepEqual(first, replay);
  assert.deepEqual(first, {
    noticeId: row.id,
    readAt: occurredAt.toISOString(),
    unreadCount: 2,
  });
  assert.deepEqual(await f.service.unreadCount('token'), { unreadCount: 2 });
  assert.ok(f.calls.indexOf('target') < f.calls.indexOf('owner:write'));
  const expiring = fixture();
  expiring.expire();
  await assert.rejects(
    expiring.service.target('token', expiring.rows[0]!.id),
    errorCode('ACCESS_TOKEN_EXPIRED'),
  );
});

test('feedback cursor is bound to owner and limit and rejects noncanonical and repeated input', () => {
  const owner = randomUUID(),
    id = randomUUID(),
    encoded = encodeFeedbackNoticesCursor(
      occurredAt.toISOString(),
      id,
      owner,
      20,
    );
  assert.throws(
    () => feedbackNoticesCursor(encoded, randomUUID(), 20),
    BadRequestException,
  );
  assert.throws(
    () => feedbackNoticesCursor(encoded, owner, 19),
    BadRequestException,
  );
  assert.throws(
    () => feedbackNoticesCursor(encoded + '=', owner, 20),
    BadRequestException,
  );
  for (const query of [
    { limit: ['1', '2'] },
    { cursor: ['a', 'b'] },
    { limit: '51' },
    { ownerAccountId: owner },
  ])
    assert.equal(feedbackNoticesQuerySchema.safeParse(query).success, false);
  assert.equal(
    feedbackPublicationNoticeSchema.safeParse({
      postId: id,
      occurredAt,
      authorAccountId: owner,
    }).success,
    false,
  );
});

test('feedback SQL is owner-keyed, bounded, unique per post/recipient and preserves first read timestamp', async () => {
  const repository = new FeedbackNoticesRepository(),
    owner = randomUUID(),
    postId = randomUUID();
  const row: StoredFeedbackNotice = {
    id: randomUUID(),
    post_id: postId,
    recipient_account_id: owner,
    recipient_grant_id: randomUUID(),
    kind: 'feedback_created',
    created_at: occurredAt,
    read_at: occurredAt,
  };
  const statements: { sql: string; values?: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      statements.push({ sql, ...(values ? { values } : {}) });
      return { rows: [row] };
    },
  } as unknown as PoolClient;
  await repository.append(
    { postId, occurredAt },
    owner,
    row.recipient_grant_id,
    tx,
  );
  assert.match(
    statements[0]!.sql,
    /ON CONFLICT\(post_id,recipient_account_id\) DO NOTHING/,
  );
  assert.deepEqual(statements[0]!.values?.slice(1), [
    postId,
    owner,
    row.recipient_grant_id,
    occurredAt,
  ]);
  await repository.page(owner, 50, null, tx);
  assert.deepEqual(statements.at(-1)!.values, [owner, null, null, 51]);
  await repository.markRead(owner, row.id, tx);
  assert.match(statements.at(-1)!.sql, /COALESCE\(read_at,/);
  assert.match(
    statements.at(-1)!.sql,
    /WHERE id=\$1 AND recipient_account_id=\$2/,
  );
  await assert.rejects(
    repository.append(
      { postId, occurredAt: new Date(occurredAt.getTime() + 1) },
      owner,
      row.recipient_grant_id,
      tx,
    ),
    errorCode('SYSTEM_NOTICES_UNAVAILABLE'),
  );
});
