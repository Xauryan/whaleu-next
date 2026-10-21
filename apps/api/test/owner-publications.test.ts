import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  publicationPageQuerySchema,
  publicationPageSchema,
} from '../src/community/publications/contracts.js';
import { publicationCursorScope } from '../src/community/publications/cursor.js';
import { PublicationHistoryRepository } from '../src/community/publications/repository.js';
import { PublicationHistoryService } from '../src/community/publications/service.js';
import type {
  CommunityRepository,
  StoredPost,
} from '../src/community/community.repository.js';
import type { CommunityAccessService } from '../src/community/community-access.service.js';
import type { CommunitySerializer } from '../src/community/community-serialization.js';
import type { IdentityService } from '../src/identity/identity.service.js';
import type { DiscoveryCursorRepository } from '../src/community/discovery-cursors.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';
const query = {
  kind: 'topic' as const,
  identity: 'anonymous' as const,
  limit: 20,
};
test('owner history filters are required, bounded and reject impersonation; cursors bind every selector', () => {
  assert.equal(publicationPageQuerySchema.safeParse({}).success, false);
  for (const patch of [
    { accountId: randomUUID() },
    { kind: 'all' },
    { identity: 'all' },
    { limit: '0' },
    { limit: '51' },
    { limit: '01' },
  ])
    assert.equal(
      publicationPageQuerySchema.safeParse({
        kind: 'topic',
        identity: 'anonymous',
        ...patch,
      }).success,
      false,
    );
  const actor = randomUUID(),
    session = randomUUID(),
    scope = publicationCursorScope(actor, session, 20, 'topic', 'anonymous');
  for (const other of [
    publicationCursorScope(randomUUID(), session, 20, 'topic', 'anonymous'),
    publicationCursorScope(actor, randomUUID(), 20, 'topic', 'anonymous'),
    publicationCursorScope(actor, session, 10, 'topic', 'anonymous'),
    publicationCursorScope(actor, session, 20, 'reply', 'anonymous'),
    publicationCursorScope(actor, session, 20, 'topic', 'named'),
  ])
    assert.notEqual(scope, other);
});
test('repository seeks only current actor/mode and merges reply branches with bounded keysets', async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const repository = new PublicationHistoryRepository(),
    actor = randomUUID();
  await repository.candidates(actor, query, null, 101, tx);
  assert.match(calls[0]!.sql, /account_id=\$1 AND author_mode=\$2/);
  assert.ok(!calls[0]!.sql.includes('likes'));
  assert.deepEqual(calls[0]!.values, [actor, 'anonymous']);
  // A single topic branch must still be a derived table: appending an outer
  // ORDER BY directly to its parenthesized SELECT is invalid PostgreSQL.
  assert.match(calls[0]!.sql, /^SELECT \* FROM \(\(SELECT /);
  assert.match(calls[0]!.sql, /\)\) AS candidates ORDER BY published_at DESC/);
  await repository.candidates(
    actor,
    { ...query, kind: 'reply' },
    { targetKind: 'comment', at: '2026-01-01T00:00:00.000Z', id: randomUUID() },
    101,
    tx,
  );
  assert.match(calls[1]!.sql, /root_comments/);
  assert.match(calls[1]!.sql, /replies/);
  assert.match(calls[1]!.sql, /UNION ALL/);
  assert.match(calls[1]!.sql, /^SELECT \* FROM \(\(SELECT /);
  assert.match(calls[1]!.sql, /\)\) AS candidates ORDER BY published_at DESC/);
  assert.equal((calls[1]!.sql.match(/LIMIT 101/g) ?? []).length, 3);
  assert.equal(
    await repository.guard(
      actor,
      query,
      { targetKind: 'reply', at: '2026-01-01T00:00:00.000Z', id: randomUUID() },
      tx,
    ),
    null,
  );
});
test('service emits only own identity-matching visible content and reauthenticates before return', async () => {
  const actor = randomUUID(),
    session = randomUUID(),
    id = randomUUID();
  let currentOwner = actor,
    mode = 'anonymous',
    hidden = false,
    authCalls = 0;
  const row = {
    id,
    account_id: actor,
    author_mode: 'anonymous',
    text: 'private owner history',
    published_at: new Date(),
    space_id: randomUUID(),
  } as StoredPost;
  const candidate = {
    kind: 'post' as const,
    target_id: id,
    post_id: id,
    root_comment_id: null,
    record_id: id,
    published_at: row.published_at,
  };
  const tx = {
    query: async () => ({ rows: [{ version: '0' }] }),
  } as unknown as PoolClient;
  const community = {
    database: {
      transaction: async <T>(fn: (tx: PoolClient) => Promise<T>) => {
        startTransactionDeadlines(tx);
        try {
          return await fn(tx);
        } finally {
          clearTransactionDeadlines(tx);
        }
      },
    },
  } as unknown as CommunityRepository;
  const identity = {
    session: async () => {
      authCalls++;
      return { accountId: actor, sessionId: session };
    },
  } as unknown as IdentityService;
  const access = {
    projectionPost: async () => {
      if (hidden) throw new ApplicationError('POST_NOT_FOUND');
    },
  } as unknown as CommunityAccessService;
  const serializer = {
    images: async () => [],
    author: async () => ({
      kind: 'anonymous',
      personaId: randomUUID(),
      displayName: '分身',
      avatar: null,
      isPostAuthor: true,
    }),
  } as unknown as CommunitySerializer;
  const repo = {
    candidates: async () => [candidate],
    current: async () => candidate,
  } as unknown as PublicationHistoryRepository;
  const service = new PublicationHistoryService(
    community,
    access,
    serializer,
    identity,
    repo,
    {} as DiscoveryCursorRepository,
  );
  Object.defineProperty(service, 'lockedContent', {
    value: async () => ({
      posts: new Map([
        [id, { ...row, account_id: currentOwner, author_mode: mode }],
      ]),
      roots: new Map(),
      replies: new Map(),
    }),
  });
  const page = await service.list('token', query);
  publicationPageSchema.parse(page);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]!.preview.isSelf, true);
  assert.equal(authCalls, 2);
  assert.ok(!JSON.stringify(page).includes(actor));
  currentOwner = randomUUID();
  assert.deepEqual((await service.list('token', query)).items, []);
  currentOwner = actor;
  mode = 'named';
  assert.deepEqual((await service.list('token', query)).items, []);
  mode = 'anonymous';
  hidden = true;
  assert.deepEqual((await service.list('token', query)).items, []);
});

test('reply history maps real root navigation and suppresses denied ancestors; stale visible guard restarts', async () => {
  const actor = randomUUID(),
    session = randomUUID(),
    postId = randomUUID(),
    rootId = randomUUID(),
    replyId = randomUUID(),
    now = new Date();
  const post = {
    id: postId,
    account_id: randomUUID(),
    author_mode: 'named',
    text: 'parent',
    published_at: now,
  } as StoredPost;
  const root = {
    id: rootId,
    post_id: postId,
    account_id: actor,
    author_mode: 'anonymous',
    text: 'root reply',
    created_at: now,
  };
  const reply = {
    ...root,
    id: replyId,
    root_comment_id: rootId,
    text: 'nested reply',
  };
  let kind: 'comment' | 'reply' = 'comment',
    parentAllowed = true,
    rootAllowed = true,
    guardPresent = true;
  const candidate = () => ({
    kind,
    target_id: kind === 'comment' ? rootId : replyId,
    post_id: postId,
    root_comment_id: rootId,
    record_id: kind === 'comment' ? rootId : replyId,
    published_at: now,
  });
  const tx = {
    query: async () => ({ rows: [{ version: '0' }] }),
  } as unknown as PoolClient;
  const community = {
    database: {
      transaction: async <T>(fn: (tx: PoolClient) => Promise<T>) => {
        startTransactionDeadlines(tx);
        try {
          return await fn(tx);
        } finally {
          clearTransactionDeadlines(tx);
        }
      },
    },
  } as unknown as CommunityRepository;
  const access = {
    projectionPost: async () => {
      if (!parentAllowed) throw new ApplicationError('POST_NOT_FOUND');
    },
    visible: async (_actor: string, row: { id: string }) =>
      row.id !== rootId || rootAllowed,
  } as unknown as CommunityAccessService;
  const serializer = {
    images: async () => [],
    author: async () => ({
      kind: 'anonymous',
      personaId: randomUUID(),
      displayName: '分身',
      avatar: null,
      isPostAuthor: false,
    }),
  } as unknown as CommunitySerializer;
  const identity = {
    session: async () => ({ accountId: actor, sessionId: session }),
  } as unknown as IdentityService;
  const repo = {
    candidates: async () => [candidate()],
    current: async () => candidate(),
    guard: async () => (guardPresent ? candidate() : null),
  } as unknown as PublicationHistoryRepository;
  const cursors = {
    get: async () => ({
      v: 1,
      kind: 'publication',
      after: {
        targetKind: kind,
        id: candidate().record_id,
        at: now.toISOString(),
      },
      visible: {
        targetKind: kind,
        id: candidate().record_id,
        at: now.toISOString(),
      },
    }),
  } as unknown as DiscoveryCursorRepository;
  const service = new PublicationHistoryService(
    community,
    access,
    serializer,
    identity,
    repo,
    cursors,
  );
  Object.defineProperty(service, 'lockedContent', {
    value: async () => ({
      posts: new Map([[postId, post]]),
      roots: new Map([[rootId, root]]),
      replies: new Map([[replyId, reply]]),
    }),
  });
  const selector = { ...query, kind: 'reply' as const };
  let item = (await service.list('token', selector)).items[0]!;
  assert.equal(item.kind, 'comment');
  assert.equal(item.targetId, rootId);
  assert.equal(item.rootCommentId, rootId);
  assert.equal(item.postId, postId);
  kind = 'reply';
  item = (await service.list('token', selector)).items[0]!;
  assert.equal(item.kind, 'reply');
  assert.equal(item.targetId, replyId);
  assert.equal(item.rootCommentId, rootId);
  parentAllowed = false;
  assert.deepEqual((await service.list('token', selector)).items, []);
  parentAllowed = true;
  rootAllowed = false;
  assert.deepEqual((await service.list('token', selector)).items, []);
  await assert.rejects(
    service.list('token', { ...selector, cursor: 'opaque' }),
    { code: 'DISCOVERY_RESTART_REQUIRED' },
  );
  rootAllowed = true;
  guardPresent = false;
  await assert.rejects(
    service.list('token', { ...selector, cursor: 'opaque' }),
    { code: 'DISCOVERY_RESTART_REQUIRED' },
  );
});
