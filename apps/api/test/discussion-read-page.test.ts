import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from '../src/database/database.js';
import type { TransactionOptions } from '../src/database/database.js';
import type {
  CommunityRepository,
  StoredComment,
  StoredPost,
} from '../src/community/community.repository.js';
import type { CommunityAccessService } from '../src/community/community-access.service.js';
import type {
  CommunitySerializer,
  CommentMetadata,
} from '../src/community/community-serialization.js';
import type { Authority } from '../src/community/community-policy.js';
import type { CommentView } from '../src/community/contracts.js';
import type { CommentsQuery } from '../src/community/discussion/contracts.js';
import { DiscussionReadService } from '../src/community/discussion/read.service.js';
import {
  discussionRootSnapshot,
  orderDiscussionRoots,
} from '../src/community/discussion/root-page.js';
import { requireAllowedSafetyRelationship } from '../src/safety/relationship-proof.js';
import { ApplicationError } from '../src/http/application-error.js';

const errorIs = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
const query: CommentsQuery = {
  limit: 10,
  sort: 'time',
  order: 'asc',
  previewLimit: 5,
};
function fixture(rootCount = 12, repliesPerRoot = 2) {
  const actor = randomUUID(),
    parentAuthor = randomUUID(),
    postId = randomUUID();
  const post = { id: postId, account_id: parentAuthor } as StoredPost;
  const roots: StoredComment[] = Array.from(
    { length: rootCount },
    (_, index) => ({
      id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
      post_id: postId,
      account_id: randomUUID(),
      text: `root ${index}`,
      author_mode: 'named',
      visibility: 'approved',
      deleted_at: null,
      created_at: new Date(Date.UTC(2020, 0, 1) + index * 1000),
    }),
  );
  const facts = new Map(
    roots.map((root) => [
      root.id,
      { likeCount: 0, isLiked: false, isPinned: false },
    ]),
  );
  const replyCounts = new Map(roots.map((root) => [root.id, repliesPerRoot]));
  const hidden = new Set<string>(),
    rendered: string[] = [],
    commands: string[] = [];
  const allowedRender = new Set(
    roots.slice(0, query.limit).map((root) => root.id),
  );
  const batches: number[] = [];
  const state = { corrupt: '' };
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      commands.push(sql);
      if (sql.startsWith('SELECT * FROM whaleu_community.root_comments'))
        return { rows: roots };
      if (sql.startsWith('SELECT root.id')) {
        const ids = values![0] as string[];
        const rows = ids.map((id) => ({
          id,
          like_count: facts.get(id)!.likeCount,
          is_liked: facts.get(id)!.isLiked,
          is_pinned: facts.get(id)!.isPinned,
        }));
        if (state.corrupt === 'missing') rows.pop();
        if (state.corrupt === 'duplicate' && rows.length > 1)
          rows[1] = rows[0]!;
        if (state.corrupt === 'negative' && rows.length)
          rows[0]!.like_count = -1;
        return { rows };
      }
      if (sql.includes('current_setting'))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '10s',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.includes('FROM unnest')) {
        const viewers = values![0] as string[];
        batches.push(viewers.length);
        return {
          rows: viewers.map((_, index) => ({
            ordinal: index + 1,
            outgoing: false,
            incoming: false,
          })),
        };
      }
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date() }] };
      return { rows: [] };
    },
    release: () => {},
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as Pick<Pool, 'connect'>;
  const repository = {
    database: {
      transaction: <T>(
        work: (tx: PoolClient) => Promise<T>,
        options: TransactionOptions,
      ) => {
        assert.deepEqual(options, { isolationLevel: 'read committed' });
        return inTransaction(pool, work, options);
      },
    },
  } as unknown as CommunityRepository;
  const access = {
    actor: async () => actor,
    accessiblePost: async (_id: string, _viewer: string, tx: PoolClient) => {
      requireAllowedSafetyRelationship(actor, parentAuthor, 'direct_post', tx);
      return { post, space: {} };
    },
    advisory: async () => null,
    visible: async (
      _viewer: string,
      root: StoredComment,
      tx: PoolClient,
      purpose: string,
    ) => {
      assert.equal(purpose, 'list_projection');
      if (hidden.has(root.id)) return false;
      requireAllowedSafetyRelationship(
        actor,
        root.account_id,
        'list_projection',
        tx,
      );
      return true;
    },
  } as unknown as CommunityAccessService;
  const serializer = {
    comment: async (
      root: StoredComment,
      _post: StoredPost,
      _viewer: string,
      _authority: Authority | null,
      tx: PoolClient,
      previewLimit: number,
      metadata: CommentMetadata,
    ) => {
      assert.ok(
        allowedRender.has(root.id),
        'Off-page replies/body/media/name must never be touched',
      );
      rendered.push(root.id);
      assert.deepEqual(metadata, facts.get(root.id));
      const count = replyCounts.get(root.id)!;
      // Distinct relationship facts model the full per-selected-root reply scan.
      for (let index = 0; index < count; index++)
        requireAllowedSafetyRelationship(
          actor,
          `${root.id}:${index}`,
          'list_projection',
          tx,
        );
      return {
        id: root.id,
        postId,
        createdAt: root.created_at.toISOString(),
        likeCount: metadata.likeCount,
        isPinned: metadata.isPinned,
        replyCount: count,
        replyPreview: {
          items: Array.from(
            { length: Math.min(count, previewLimit) },
            (_, index) => ({ id: `${root.id}:${index}` }),
          ),
          nextCursor: count > previewLimit ? 'reply-v1-default20' : null,
        },
      } as unknown as CommentView;
    },
  } as unknown as CommunitySerializer;
  const service = new DiscussionReadService(repository, access, serializer);
  return {
    service,
    roots,
    postId,
    facts,
    hidden,
    replyCounts,
    allowedRender,
    rendered,
    batches,
    commands,
    state,
  };
}

test('root order preserves pins, directional time and newest tie breaks for either like direction', () => {
  const roots = [
    { id: 'a', createdAt: '2020-01-01', likeCount: 2, isPinned: false },
    { id: 'b', createdAt: '2020-01-01', likeCount: 2, isPinned: false },
    { id: 'c', createdAt: '2020-01-02', likeCount: 1, isPinned: false },
    { id: 'p', createdAt: '2019-01-01', likeCount: 0, isPinned: true },
  ];
  for (const [sort, order, expected] of [
    ['time', 'asc', ['p', 'a', 'b', 'c']],
    ['time', 'desc', ['p', 'c', 'b', 'a']],
    ['likes', 'asc', ['p', 'c', 'b', 'a']],
    ['likes', 'desc', ['p', 'b', 'a', 'c']],
  ] as const)
    assert.deepEqual(
      orderDiscussionRoots(roots, { sort, order }).map((root) => root.id),
      expected,
    );
  assert.equal(roots[0]!.id, 'a', 'Input stays unchanged');
});

test('root snapshots include only relevant eligibility and order facts', () => {
  const root = {
    id: 'a',
    createdAt: '2020-01-01',
    likeCount: 2,
    isPinned: false,
    replyCount: 9,
  };
  assert.equal(
    discussionRootSnapshot([root], 'time'),
    discussionRootSnapshot([{ ...root, likeCount: 100 }], 'time'),
  );
  assert.equal(
    discussionRootSnapshot([root], 'likes'),
    discussionRootSnapshot([{ ...root, ...{ replyCount: 1000 } }], 'likes'),
  );
  for (const changed of [
    { ...root, id: 'b' },
    { ...root, createdAt: '2020-01-02' },
    { ...root, isPinned: true },
  ])
    assert.notEqual(
      discussionRootSnapshot([root], 'time'),
      discussionRootSnapshot([changed], 'time'),
    );
  assert.notEqual(
    discussionRootSnapshot([root], 'likes'),
    discussionRootSnapshot([{ ...root, likeCount: 3 }], 'likes'),
  );
  assert.notEqual(
    discussionRootSnapshot([root], 'time'),
    discussionRootSnapshot([], 'time'),
  );
});

test('1024 roots with over a million possible replies render ten roots and prove only selected relationships', async () => {
  const f = fixture(1024, 1024);
  assert.ok(f.roots.length * 1024 > 110_000);
  const result = await f.service.comments('token', f.postId, query);
  assert.equal(result.items.length, 10);
  assert.equal(f.rendered.length, 10);
  assert.ok(
    result.items.every(
      (root) =>
        root.replyCount === 1024 && root.replyPreview.items.length === 5,
    ),
  );
  assert.equal(
    f.batches.reduce((sum, count) => sum + count, 0),
    1 + 1024 + 10 * 1024,
  );
  assert.ok(f.batches.every((count) => count <= 256));
  assert.ok(f.commands.includes('BEGIN ISOLATION LEVEL READ COMMITTED'));
  assert.equal(
    f.commands.filter((sql) => sql.startsWith('SELECT root.id')).length,
    1,
  );
  assert.equal(
    f.commands.some((sql) => sql.includes('count_epochs')),
    false,
  );
  assert.equal(
    JSON.parse(Buffer.from(result.nextCursor!, 'base64url').toString()).v,
    3,
  );
});

test('continuation ignores off-page replies and time-sort likes but returns fresh selected counts', async () => {
  const f = fixture();
  const first = await f.service.comments('token', f.postId, query);
  f.replyCounts.set(f.roots[0]!.id, 900);
  f.facts.get(f.roots[0]!.id)!.likeCount = 999;
  f.replyCounts.set(f.roots[10]!.id, 7);
  f.allowedRender.clear();
  for (const root of f.roots.slice(10)) f.allowedRender.add(root.id);
  const next = await f.service.comments('token', f.postId, {
    ...query,
    cursor: first.nextCursor!,
  });
  assert.deepEqual(
    next.items.map((root) => root.id),
    f.roots.slice(10).map((root) => root.id),
  );
  assert.equal(next.items[0]!.replyCount, 7);
  assert.equal(next.nextCursor, null);
});

test('root eligibility, pins and likes-sort changes require restart before any selected serialization', async () => {
  for (const change of ['eligibility', 'pin', 'like'] as const) {
    const f = fixture();
    f.allowedRender.clear();
    for (const root of f.roots) f.allowedRender.add(root.id);
    const current = { ...query, sort: 'likes' as const };
    const first = await f.service.comments('token', f.postId, current);
    f.rendered.length = 0;
    if (change === 'eligibility') f.hidden.add(f.roots[0]!.id);
    if (change === 'pin') f.facts.get(f.roots[0]!.id)!.isPinned = true;
    if (change === 'like') f.facts.get(f.roots[0]!.id)!.likeCount = 1;
    await assert.rejects(
      f.service.comments('token', f.postId, {
        ...current,
        cursor: first.nextCursor!,
      }),
      errorIs('DISCUSSION_RESTART_REQUIRED'),
    );
    assert.equal(f.rendered.length, 0);
  }
});

test('root candidate cap, empty page and malformed metadata fail without off-page rendering', async () => {
  const over = fixture(1025);
  await assert.rejects(
    over.service.comments('token', over.postId, query),
    errorIs('COMMUNITY_UNAVAILABLE'),
  );
  assert.equal(over.rendered.length, 0);
  const empty = fixture(0);
  assert.deepEqual(await empty.service.comments('token', empty.postId, query), {
    items: [],
    nextCursor: null,
  });
  assert.equal(
    empty.commands.some((sql) => sql.startsWith('SELECT root.id')),
    false,
  );
  for (const corruption of ['missing', 'duplicate', 'negative']) {
    const f = fixture();
    f.state.corrupt = corruption;
    await assert.rejects(
      f.service.comments('token', f.postId, query),
      errorIs('COMMUNITY_UNAVAILABLE'),
    );
    assert.equal(f.rendered.length, 0);
  }
});
