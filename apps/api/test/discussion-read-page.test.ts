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
import {
  DiscussionPages,
  DISCUSSION_SCAN_BATCH,
} from '../src/community/discussion/pages.js';
import type { DiscoveryCursorRepository } from '../src/community/discovery-cursors.js';
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
  const state: { corrupt: string; beforeQuery?: (sql: string) => void } = {
    corrupt: '',
  };
  const client = {
    query: async (sql: string, values?: unknown[]) => {
      if (sql.startsWith('BEGIN')) {
        const prior = commands.indexOf('cursor-created');
        if (prior >= 0) commands.splice(prior, 1);
      }
      commands.push(sql);
      state.beforeQuery?.(sql);
      if (
        sql.startsWith(
          'SELECT version::text FROM whaleu_community.post_category_read_epoch',
        )
      )
        return { rows: [{ version: '1' }] };
      if (
        sql.startsWith('SELECT comment_id FROM whaleu_community.comment_pins')
      )
        return {
          rows: roots
            .filter((r) => facts.get(r.id)!.isPinned)
            .map((r) => ({ comment_id: r.id })),
        };
      if (sql.startsWith('/* discussion:root-lock */')) {
        const rows = roots
          .filter((r) => (values![1] as string[]).includes(r.id))
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((r) => ({
            ...r,
            scan_at: r.created_at.toISOString().replace('Z', '000Z'),
          }));
        if (state.corrupt === 'duplicate' && rows.length > 1)
          rows[1] = rows[0]!;
        return { rows };
      }
      if (sql.startsWith('/* discussion:order-lock */'))
        return {
          rows: (values![0] as string[]).map((id) => ({
            root_id: id,
            post_id: postId,
            scan_at: roots
              .find((r) => r.id === id)!
              .created_at.toISOString()
              .replace('Z', '000Z'),
            live: true,
            like_count:
              state.corrupt === 'negative' ? -1 : facts.get(id)!.likeCount,
          })),
        };
      if (sql.startsWith('/* discussion:viewer-likes */'))
        return {
          rows: (values![0] as string[]).map((id) => ({
            id,
            liked: facts.get(id)!.isLiked,
          })),
        };
      if (sql.startsWith('/* discussion:root-')) {
        const limit = Number(/LIMIT (\d+)/.exec(sql)![1]);
        assert.ok(limit <= DISCUSSION_SCAN_BATCH + 1);
        const phase = /discussion:root-([a-z-]+)/.exec(sql)![1]!;
        let selected = roots.filter(
          (r) => r.deleted_at === null && r.visibility === 'approved',
        );
        if (phase === 'exact')
          selected = selected.filter((r) => r.id === values![1]);
        else selected = selected.filter((r) => r.id !== values![1]);
        const sort = phase === 'time' ? 'time' : 'likes';
        const order =
          phase === 'time'
            ? sql.includes('created_at ASC,root_id ASC')
              ? 'asc'
              : 'desc'
            : phase === 'likes-desc'
              ? 'desc'
              : 'asc';
        if (values!.length > 2 && phase !== 'exact')
          selected = selected.filter((r) => {
            const likes = facts.get(r.id)!.likeCount;
            const date = r.created_at.toISOString().replace('Z', '000Z');
            const anchorAt = values![phase === 'time' ? 2 : 3] as string;
            const anchorId = values![phase === 'time' ? 3 : 4] as string;
            const older =
              date < anchorAt || (date === anchorAt && r.id < anchorId);
            const newer =
              date > anchorAt || (date === anchorAt && r.id > anchorId);
            if (phase === 'time') return order === 'asc' ? newer : older;
            if (phase === 'likes-asc')
              return (
                likes > (values![2] as number) ||
                (likes === values![2] && older)
              );
            return (
              likes < (values![2] as number) || (likes === values![2] && older)
            );
          });
        const rows = orderDiscussionRoots(
          selected.map((r) => ({
            row: r,
            id: r.id,
            createdAt: r.created_at.toISOString(),
            likeCount: facts.get(r.id)!.likeCount,
            isPinned: false,
          })),
          { sort, order },
        )
          .slice(0, limit)
          .map((r) => ({
            id: r.id,
            at: r.createdAt.replace('Z', '000Z'),
            likes: phase === 'time' ? null : r.likeCount,
          }));
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
    mediaSession: async () => ({ accountId: actor, sessionId: 'session-1' }),
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
      assert.equal(purpose, 'detail_projection');
      if (hidden.has(root.id)) return false;
      requireAllowedSafetyRelationship(
        actor,
        root.account_id,
        'detail_projection',
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
      assert.equal(
        commands.includes('cursor-created'),
        false,
        'No quota lock before all selected serialization',
      );
      rendered.push(root.id);
      assert.deepEqual(metadata, facts.get(root.id));
      const count = replyCounts.get(root.id)!;
      // Distinct relationship facts model the full per-selected-root reply scan.
      for (let index = 0; index < count; index++)
        requireAllowedSafetyRelationship(
          actor,
          `${root.id}:${index}`,
          'detail_projection',
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
  const positions = new Map<string, { scope: string; position: unknown }>();
  const cursors = {
    create: async (scope: string, _bucket: unknown, position: unknown) => {
      commands.push('cursor-created');
      const token = String(positions.size + 1).padStart(43, 'a');
      positions.set(token, { scope, position });
      return token;
    },
    get: async (
      token: string,
      scope: string,
      _tx: PoolClient,
      validate: (value: unknown) => unknown,
    ) => {
      const saved = positions.get(token);
      if (!saved || saved.scope !== scope)
        throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
      return validate(saved.position);
    },
  } as unknown as DiscoveryCursorRepository;
  const pages = new DiscussionPages(repository, access, cursors);
  const service = new DiscussionReadService(
    repository,
    access,
    serializer,
    pages,
  );
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

test('4097 roots with millions of possible replies render only ten roots in a bounded scan', async () => {
  const f = fixture(4097, 1024);
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
    1 + 10 + 10 * 1024,
  );
  assert.ok(f.batches.every((count) => count <= 256));
  assert.ok(f.commands.includes('BEGIN ISOLATION LEVEL READ COMMITTED'));
  assert.equal(
    f.commands.filter((sql) => sql.startsWith('/* discussion:root-lock */'))
      .length,
    1,
  );
  assert.equal(
    f.commands.some((sql) => sql.includes('count_epochs')),
    false,
  );
  assert.match(result.nextCursor!, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!result.nextCursor!.includes(f.roots[9]!.id));
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
    const anchor = first.items.at(-1)!.id;
    if (change === 'eligibility') f.hidden.add(anchor);
    if (change === 'pin') f.facts.get(anchor)!.isPinned = true;
    if (change === 'like') f.facts.get(anchor)!.likeCount = 1;
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

test('large roots remain readable, empty pages end and malformed metadata fails before rendering', async () => {
  const over = fixture(1025);
  const large = await over.service.comments('token', over.postId, query);
  assert.equal(large.items.length, 10);
  assert.notEqual(large.nextCursor, null);
  const empty = fixture(0);
  assert.deepEqual(await empty.service.comments('token', empty.postId, query), {
    items: [],
    nextCursor: null,
  });
  assert.equal(
    empty.commands.some((sql) => sql.startsWith('SELECT root.id')),
    false,
  );
  for (const corruption of ['duplicate', 'negative']) {
    const f = fixture();
    f.state.corrupt = corruption;
    await assert.rejects(
      f.service.comments('token', f.postId, query),
      errorIs('COMMUNITY_UNAVAILABLE'),
    );
    assert.equal(f.rendered.length, 0);
  }
});

test('hidden-heavy bounded root scans retain opaque continuation without a false end', async () => {
  const f = fixture(1025, 0);
  for (const root of f.roots.slice(0, 1000)) f.hidden.add(root.id);
  f.allowedRender.clear();
  for (const root of f.roots.slice(1000)) f.allowedRender.add(root.id);
  let cursor: string | undefined,
    firstVisible = false,
    pages = 0;
  do {
    const result = await f.service.comments('token', f.postId, {
      ...query,
      ...(cursor ? { cursor } : {}),
    });
    pages++;
    if (!firstVisible && result.items.length === 0)
      assert.notEqual(result.nextCursor, null);
    firstVisible ||= result.items.length > 0;
    cursor = result.nextCursor ?? undefined;
    assert.ok(pages < 20);
  } while (cursor);
  assert.equal(firstVisible, true);
  assert.equal(f.rendered.length, 25);
});
test('legacy whole-discussion cursor explicitly requires restart', async () => {
  const f = fixture();
  const cursor = Buffer.from(
    JSON.stringify({ v: 3, scope: 'old', offset: 10 }),
  ).toString('base64url');
  await assert.rejects(
    f.service.comments('token', f.postId, { ...query, cursor }),
    errorIs('DISCUSSION_RESTART_REQUIRED'),
  );
});

test('indexed mixed-direction likes preserve newest ties and a single pinned first row through every keyset', async () => {
  for (const order of ['asc', 'desc'] as const) {
    const f = fixture(8, 0);
    f.allowedRender.clear();
    for (const [i, root] of f.roots.entries()) {
      f.allowedRender.add(root.id);
      root.created_at = new Date(
        Date.UTC(2020, 0, 1) + Math.floor(i / 2) * 1000,
      );
      f.facts.get(root.id)!.likeCount = Math.floor(i / 3);
    }
    f.facts.get(f.roots[2]!.id)!.isPinned = true;
    const expected = orderDiscussionRoots(
      f.roots.map((r) => ({
        id: r.id,
        createdAt: r.created_at.toISOString(),
        ...f.facts.get(r.id)!,
      })),
      { sort: 'likes', order },
    ).map((r) => r.id);
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await f.service.comments('token', f.postId, {
        ...query,
        sort: 'likes',
        order,
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor ?? undefined;
      assert.ok(seen.length <= 8);
    } while (cursor);
    assert.deepEqual(seen, expected);
    assert.ok(
      f.commands.some((sql) =>
        sql.startsWith(`/* discussion:root-likes-${order} */`),
      ),
    );
    if (order === 'asc')
      assert.ok(
        f.commands.some(
          (sql) =>
            sql.startsWith('/* discussion:root-likes-asc */') &&
            sql.includes('(-$3::integer)'),
        ),
      );
    assert.equal(
      f.commands.some(
        (sql) =>
          sql.startsWith('/* discussion:root-') &&
          /LATERAL|count\(\*\)/i.test(sql),
      ),
      false,
    );
  }
});

test('hidden singleton pin consumes the same 128-candidate budget and cannot repeat on empty continuation', async () => {
  const f = fixture(260, 0);
  const pin = f.roots[259]!;
  f.facts.get(pin.id)!.isPinned = true;
  for (const root of [...f.roots.slice(0, 127), pin]) f.hidden.add(root.id);
  f.allowedRender.clear();
  const first = await f.service.comments('token', f.postId, query);
  assert.deepEqual(first.items, []);
  assert.ok(first.nextCursor);
  assert.ok(
    f.commands.some(
      (sql) =>
        sql.startsWith('/* discussion:root-time */') &&
        sql.includes('LIMIT 128'),
    ),
  );
  for (const root of f.roots.slice(127, 137)) f.allowedRender.add(root.id);
  const next = await f.service.comments('token', f.postId, {
    ...query,
    cursor: first.nextCursor!,
  });
  assert.deepEqual(
    next.items.map((r) => r.id),
    f.roots.slice(127, 137).map((r) => r.id),
  );
  assert.equal(
    next.items.some((r) => r.id === pin.id),
    false,
  );
});

test('split-read pin changes and changed ordering coordinates restart before rendering', async () => {
  for (const kind of ['pin', 'likes', 'deleted'] as const) {
    const f = fixture(12, 0);
    for (const r of f.roots) f.allowedRender.add(r.id);
    let changed = false;
    f.state.beforeQuery = (sql) => {
      if (!changed && sql.startsWith('/* discussion:root-lock */')) {
        changed = true;
        if (kind === 'pin') f.facts.get(f.roots[0]!.id)!.isPinned = true;
        if (kind === 'likes') f.facts.get(f.roots[0]!.id)!.likeCount = 10;
        if (kind === 'deleted') f.roots[0]!.deleted_at = new Date();
      }
    };
    await assert.rejects(
      f.service.comments('token', f.postId, { ...query, sort: 'likes' }),
      errorIs('DISCUSSION_RESTART_REQUIRED'),
    );
    assert.equal(changed, true);
    assert.deepEqual(f.rendered, []);
  }
});

test('pin flip between visible-anchor guard and candidate selection still restarts', async () => {
  const f = fixture(12, 0);
  const first = await f.service.comments('token', f.postId, query);
  f.rendered.length = 0;
  let pins = 0;
  f.state.beforeQuery = (sql) => {
    if (
      sql.startsWith('SELECT comment_id FROM whaleu_community.comment_pins') &&
      ++pins === 3
    )
      f.facts.get(first.items.at(-1)!.id)!.isPinned = true;
  };
  await assert.rejects(
    f.service.comments('token', f.postId, {
      ...query,
      cursor: first.nextCursor!,
    }),
    errorIs('DISCUSSION_RESTART_REQUIRED'),
  );
  assert.equal(pins, 3);
  assert.deepEqual(f.rendered, []);
});

test('all root enumeration uses live-only complete-scope ranges, preserving canonical lock owners', async () => {
  const f = fixture(12, 0);
  const seen = new Set<string>();
  f.state.beforeQuery = (sql) => {
    const phase = /discussion:root-(time|likes-desc|likes-asc)/.exec(sql)?.[1];
    if (!phase) return;
    seen.add(phase);
    assert.ok(sql.includes('FROM whaleu_community.discussion_live_root_order'));
    assert.equal(sql.includes('WHERE post_id=$1'), false);
    assert.equal(sql.includes('AND live'), false);
    assert.ok(sql.includes('AND (post_id,'));
    assert.ok(sql.includes('ORDER BY post_id '));
    assert.equal((sql.match(/AND \(post_id,/g) ?? []).length, 2);
    if (phase === 'likes-asc') {
      assert.ok(sql.includes('(-like_count)'));
      assert.ok(sql.includes('-2147483647'));
    }
  };
  for (const [sort, order] of [
    ['time', 'asc'],
    ['time', 'desc'],
    ['likes', 'asc'],
    ['likes', 'desc'],
  ] as const) {
    const expected = orderDiscussionRoots(
      f.roots.map((root) => ({
        id: root.id,
        createdAt: root.created_at.toISOString(),
        ...f.facts.get(root.id)!,
      })),
      { sort, order },
    ).map((root) => root.id);
    f.allowedRender.clear();
    for (const id of expected.slice(0, 2)) f.allowedRender.add(id);
    const first = await f.service.comments('token', f.postId, {
      ...query,
      limit: 2,
      sort,
      order,
    });
    assert.deepEqual(
      first.items.map((row) => row.id),
      expected.slice(0, 2),
    );
    assert.ok(first.nextCursor);
    f.allowedRender.clear();
    for (const id of expected.slice(2, 4)) f.allowedRender.add(id);
    const second = await f.service.comments('token', f.postId, {
      ...query,
      limit: 2,
      sort,
      order,
      cursor: first.nextCursor!,
    });
    assert.deepEqual(
      second.items.map((row) => row.id),
      expected.slice(2, 4),
    );
  }
  assert.deepEqual([...seen].sort(), ['likes-asc', 'likes-desc', 'time']);
});
