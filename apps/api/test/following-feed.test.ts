import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { FeedService } from '../src/community/feed.service.js';
import type { FollowingService } from '../src/community/following/service.js';
import type {
  CommunityRepository,
  StoredPost,
} from '../src/community/community.repository.js';
import type { CommunityAccessService } from '../src/community/community-access.service.js';
import type { CommunitySerializer } from '../src/community/community-serialization.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
function fixture() {
  const actor = randomUUID(),
    spaceId = randomUUID(),
    named = randomUUID(),
    hidden = randomUUID();
  const rows: StoredPost[] = [named, hidden, named, named].map(
    (account_id, index) =>
      ({
        id: randomUUID(),
        account_id,
        space_id: spaceId,
        category: 'discussion',
        author_mode: index === 0 ? 'anonymous' : 'named',
        published_at: new Date(Date.UTC(2026, 9, 20, 0, 0, 4 - index)),
        deleted_at: null,
        visibility: 'approved',
      }) as StoredPost,
  );
  let epoch = '0';
  const queries: { sql: string; params: unknown[] }[] = [];
  const tx = {
    query: async (sql: string, params: unknown[] = []) => {
      queries.push({ sql, params });
      if (sql.startsWith('SELECT pg_advisory')) return { rows: [] };
      if (sql.startsWith('SELECT revision::text'))
        return { rows: [{ revision: epoch }] };
      if (sql.startsWith('SELECT version::text'))
        return { rows: [{ version: '0' }] };
      if (sql.startsWith('SELECT p.*'))
        return {
          rows: rows.filter(
            (row) =>
              !params[2] || row.published_at.toISOString() < String(params[2]),
          ),
        };
      if (sql.startsWith('SELECT requested.post_id'))
        return {
          rows: (params[0] as string[]).map((id) => ({
            postId: id,
            originalCategory: 'discussion',
            originalSpaceId: spaceId,
            headPostId: null,
            headCategory: null,
            revision: null,
            eventId: null,
            headXmin: null,
            livePostId: null,
            liveCategory: null,
            liveRevision: null,
            liveEventId: null,
            policyId: null,
            reviewId: null,
            validUntil: null,
            batchValidUntil: null,
            batchValidUntilMs: null,
            batchValidUntilMicros: null,
          })),
        };
      throw new Error(sql);
    },
  } as unknown as PoolClient;
  const space = { id: spaceId, kind: 'regional', name: 'School' };
  const repository = {
    database: {
      transaction: async <T>(f: (tx: PoolClient) => Promise<T>) => {
        startTransactionDeadlines(tx);
        try {
          return await f(tx);
        } finally {
          clearTransactionDeadlines(tx);
        }
      },
    },
    space: async () => space,
  } as unknown as CommunityRepository;
  const access = {
    actor: async () => actor,
    advisory: async () => ({ phoneVerified: true }),
    authority: async () => ({ phoneVerified: true }),
    visible: async () => true,
  } as unknown as CommunityAccessService;
  const serializer = {
    post: async (post: StoredPost) => ({
      id: post.id,
      publishedAt: post.published_at.toISOString(),
      author: { kind: post.author_mode },
    }),
  } as unknown as CommunitySerializer;
  const follows = {
    eligibleFeedAuthor: async (_actor: string, target: string) =>
      target !== hidden,
  } as unknown as FollowingService;
  return {
    service: new FeedService(
      repository,
      access,
      serializer,
      undefined,
      undefined,
      follows,
    ),
    queries,
    spaceId,
    rows,
    changeEpoch: () => {
      epoch = '1';
    },
  };
}
test('Following feed filters anonymous/private candidates before serialization, seeks only visible rows and scopes edge revisions', async () => {
  const f = fixture();
  const query = { spaceId: f.spaceId, limit: 1 };
  const first = await f.service.feed('session-a', query, true);
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0]!.id, f.rows[2]!.id);
  assert.ok(first.nextCursor);
  const sql = f.queries.find((q) => q.sql.startsWith('SELECT p.*'))!;
  assert.match(sql.sql, /p.author_mode='named'/);
  assert.match(sql.sql, /user_follows/);
  assert.match(sql.sql, /hideProfilePosts/);
  assert.match(sql.sql, /deleted_at IS NULL/);
  assert.match(sql.sql, /visibility='approved'/);
  const second = await f.service.feed(
    'session-a',
    { ...query, cursor: first.nextCursor! },
    true,
  );
  assert.equal(second.items[0]!.id, f.rows[3]!.id);
  assert.equal(second.nextCursor, null);
  await assert.rejects(
    f.service.feed('session-b', { ...query, cursor: first.nextCursor! }, true),
  );
  f.changeEpoch();
  await assert.rejects(
    f.service.feed('session-a', { ...query, cursor: first.nextCursor! }, true),
  );
});
test('Following requires login, while ordinary feed does not acquire edge scope', async () => {
  const f = fixture();
  await assert.rejects(
    f.service.feed(null, { spaceId: f.spaceId, limit: 1 }, true),
  );
  assert.equal(
    f.queries.some((q) => q.sql.includes('follow_heads')),
    false,
  );
});
