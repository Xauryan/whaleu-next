import { hotPostViewSchema } from '../src/community/hot/response-schema.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { CommunityDiscussionCounts } from '../src/community/discussion/counts.js';
import { DISCOVERY_COUNT_BATCH } from '../src/database/optional-count.js';
import type {
  ContentReviewCountFacade,
  DiscussionCountCandidate,
} from '../src/community/content-review/count-snapshot.facade.js';
import { COUNT_EPOCH_SLOTS } from '../src/database/count-proof.js';
import { CommunitySerializer } from '../src/community/community-serialization.js';
import type { StoredPost } from '../src/community/community.repository.js';
import type { CommunitySpace } from '../src/community/contracts.js';
import { ApplicationError } from '../src/http/application-error.js';
import { untouchedCategoryRows } from './support/category-read-facts.js';
import {
  checkTransactionDeadlines,
  checkpointTransactionDeadlines,
  clearTransactionDeadlines,
  registerTransactionDeadline,
  startTransactionDeadlines,
  restoreTransactionDeadlines,
  transactionLifetime,
  transactionReadEpoch,
} from '../src/database/transaction-deadlines.js';

function fixture(size = 1025, poolMax = 10) {
  const owner = randomUUID();
  const source = Array.from({ length: size }, (_, index) => ({
    id: `${(index + 1).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
    kind: 'comment' as const,
    postId: owner,
    rootId: `${(index + 1).toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`,
  }));
  const post: StoredPost = {
    id: owner,
    account_id: randomUUID(),
    space_id: randomUUID(),
    category: 'discussion',
    text: 'Visible content',
    author_mode: 'named',
    comments_policy: 'open',
    visibility: 'approved',
    deleted_at: null,
    published_at: new Date(0),
  };
  const space: CommunitySpace = {
    id: post.space_id,
    kind: 'regional',
    name: 'Synthetic',
    isActive: true,
    operatingRegionId: null,
  };
  const commands: { sql: string; values: unknown[] | undefined }[] = [];
  const batches: number[] = [];
  const state = {
    epoch: '1',
    now: 100,
    replies: [] as DiscussionCountCandidate[],
    mediaEpoch: '1',
    mediaMissing: false,
    mediaFence: true,
    images: new Set<string>(),
    writerCapacity: 108,
    unknown: null as string | null,
    denied: new Set<string>(),
    failure: null as Error | null,
    failRollback: false,
    until: null as number | null,
    fence: true,
  };
  const tx = {
    query: async (sql: string, values?: unknown[]) => {
      commands.push({ sql, values });
      if (sql.startsWith('ROLLBACK TO') && state.failRollback)
        throw new Error('rollback failed');
      if (sql.includes("current_setting('statement_timeout')"))
        return {
          rows: [
            {
              timeout: '100ms',
              isolation: 'read committed',
              statement_timeout: '10s',
              lock_timeout: '0',
              work_mem: '4MB',
            },
          ],
        };
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              writer_capacity: state.writerCapacity,
            },
          ],
        };
      if (sql.includes('whaleu_media.media_owner_states')) {
        if (state.mediaMissing)
          throw Object.assign(new Error('Media schema absent'), {
            code: '42P01',
          });
        if (sql.includes('LOCK TABLE') && !state.mediaFence)
          throw Object.assign(new Error('Media writer active'), {
            code: '55P03',
          });
        return {
          rows: Array.from({ length: COUNT_EPOCH_SLOTS }, (_, slot) => ({
            slot,
            version: 1,
            epoch: state.mediaEpoch,
          })),
        };
      }
      if (sql.includes('discovery_count_epochs'))
        return {
          rows: Array.from({ length: COUNT_EPOCH_SLOTS }, (_, slot) => ({
            slot,
            version: 1,
            epoch: state.epoch,
          })),
        };
      if (sql.includes('pg_try_advisory_xact_lock('))
        return { rows: [{ locked: state.fence }] };
      if (sql.includes('pg_try_advisory_xact_lock_shared'))
        return {
          rows: Array.from({ length: COUNT_EPOCH_SLOTS }, () => ({
            locked: state.fence,
          })),
        };
      if (sql === 'SELECT clock_timestamp() AS now')
        return { rows: [{ now: new Date(state.now) }] };
      if (
        sql.startsWith("SELECT 'comment' AS kind") ||
        sql.startsWith("SELECT 'reply' AS kind")
      ) {
        assert.ok(!sql.includes('FOR SHARE'));
        assert.ok(!sql.includes('FOR UPDATE'));
        assert.ok(sql.includes('LIMIT 257'));
        if (state.failure) throw state.failure;
        assert.equal(values?.[0], owner);
        const current = sql.startsWith("SELECT 'comment'")
          ? source
          : state.replies;
        const after = values?.[1];
        const start = after
          ? current.findIndex((item) => item.id === after) + 1
          : 0;
        assert.ok(start >= 0);
        return {
          rows: current.slice(start, start + DISCOVERY_COUNT_BATCH + 1),
        };
      }
      if (sql.startsWith('SELECT requested.post_id'))
        return {
          rows: untouchedCategoryRows(
            values![0] as string[],
            new Map([[post.id, post]]),
          ),
        };
      if (sql.includes('LEFT JOIN whaleu_community.post_owner_visibility'))
        return {
          rows: [
            {
              postId: post.id,
              ownerHidden: false,
              version: 0,
              requestId: null,
              xmin: null,
            },
          ],
        };
      if (sql.includes('FROM whaleu_community.post_likes'))
        return { rows: [{ count: 0, liked: false }] };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  const facts = {
    evaluateDiscussion: async (candidates: DiscussionCountCandidate[]) => {
      const ids = candidates.map((row) => row.id);
      batches.push(ids.length);
      assert.ok(ids.length <= DISCOVERY_COUNT_BATCH);
      return {
        optionalUntil: state.until,
        mediaRequired: ids.some((id) => state.images.has(id)),
        facts: new Map(
          candidates.map(({ id, kind }) => [
            `${kind}:${id}`,
            {
              decision:
                state.unknown === id
                  ? 'unknown'
                  : state.denied.has(id)
                    ? 'deny'
                    : 'allow',
              optionalUntil: state.until,
              post: {
                account_id: owner,
                author_mode: 'named',
                category: 'discussion',
              },
              listing: null,
            },
          ]),
        ),
        dependencies: { contentIds: ids, spaceIds: [], namedAccountIds: [] },
      };
    },
  } as unknown as ContentReviewCountFacade;
  const service = new CommunityDiscussionCounts(facts, {
    PG_POOL_MAX: poolMax,
  });
  type D = ConstructorParameters<typeof CommunitySerializer>;
  const serializer = new CommunitySerializer(
    {
      projection: async () => ({ saveCount: 0, isSaved: false }),
    } as unknown as D[0],
    { images: async () => [] } as unknown as D[1],
    {} as D[2],
    {} as D[3],
    {
      projectionPost: async () => ({ post }),
      advisory: async () => null,
    } as unknown as D[4],
    { project: async () => null } as unknown as D[5],
    { project: async () => null } as unknown as D[6],
    { project: async () => null } as unknown as D[7],
    undefined,
    undefined,
    undefined,
    service,
  );
  serializer.author = async () => ({
    kind: 'named',
    profileId: post.account_id,
    displayName: 'Synthetic',
    avatar: null,
    experienceDisplay: {
      title: { status: 'unavailable', value: null },
      color: { status: 'unavailable', value: null },
      level: { status: 'unavailable', value: null },
    },
  });
  startTransactionDeadlines(tx);
  const render = () => serializer.post(post, space, null, null, tx);
  return {
    owner,
    post,
    space,
    source,
    commands,
    batches,
    state,
    tx,
    service,
    facts,
    serializer,
    render,
  };
}

test('1025 roots, per-root replies and combined replies no longer fail visible post serialization', async (t) => {
  for (const [roots, replies] of [
    [1025, 0],
    [1, 1025],
    [2, 1025],
    [4097, 4097],
  ] as const)
    await t.test(`${roots}/${replies}`, async () => {
      const f = fixture(roots);
      f.state.replies = Array.from({ length: replies }, (_, i) => ({
        kind: 'reply',
        id: `20000000-0000-4000-8000-${(i + 1).toString(16).padStart(12, '0')}`,
        postId: f.owner,
        rootId: f.source[i % roots]!.id,
      }));
      const result = await f.render();
      assert.deepEqual(
        [result.commentCount, result.replyCount, result.discussionCount],
        [roots, replies, roots + replies],
      );
      await checkTransactionDeadlines(f.tx);
      assert.equal(result.discussionCount, roots + replies);
      assert.equal(result.text, 'Visible content');
      assert.ok(f.batches.every((n) => n <= 256));
      clearTransactionDeadlines(f.tx);
    });
});
test('unknown/timeout/resource exhaustion erase only optional counts, not readable content', async () => {
  for (const code of ['unknown', '57014', '55P03', '53400']) {
    const f = fixture();
    if (code === 'unknown') f.state.unknown = f.source[0]!.id;
    else
      f.state.failure = Object.assign(new Error('optional failure'), { code });
    const result = await f.render();
    assert.deepEqual(
      [result.commentCount, result.replyCount, result.discussionCount],
      [null, null, null],
    );
    assert.equal(result.text, 'Visible content');
    assert.ok(
      f.commands.some(
        (c) => c.sql === 'ROLLBACK TO SAVEPOINT discovery_optional_count',
      ),
    );
    await checkTransactionDeadlines(f.tx);
    clearTransactionDeadlines(f.tx);
  }
});
test('ten feed items share 2s total source budget across read epoch restores and one final proof', async (t) => {
  let elapsed = 0;
  t.mock.method(performance, 'now', () => elapsed);
  const f = fixture(1);
  const original = f.facts.evaluateDiscussion.bind(f.facts);
  f.facts.evaluateDiscussion = async (...args) => {
    const result = await original(...args);
    elapsed += 600;
    return result;
  };
  const items = [];
  for (let i = 0; i < 10; i++) items.push(await f.render());
  assert.equal(items.length, 10);
  assert.equal(items.filter((row) => row.discussionCount === 1).length, 3);
  assert.equal(f.batches.length, 4);
  assert.ok(items.every((row) => row.text === 'Visible content'));
  await checkTransactionDeadlines(f.tx);
  assert.equal(
    f.commands.filter((c) => c.sql.includes('pg_try_advisory_xact_lock('))
      .length,
    1,
  );
  clearTransactionDeadlines(f.tx);
});
test('late owner/media mutation and expiry erase all optional triples but mandatory session expiry still rejects', async () => {
  for (const changed of ['epoch', 'media', 'horizon', 'session']) {
    const f = fixture(3);
    if (changed === 'media') f.state.images.add(f.source[0]!.id);
    if (changed === 'horizon') f.state.until = 150;
    if (changed === 'session')
      registerTransactionDeadline(f.tx, 150, 'AUTHENTICATION_REQUIRED');
    const a = await f.render(),
      b = await f.render();
    if (changed === 'epoch') f.state.epoch = '2';
    if (changed === 'media') f.state.mediaEpoch = '2';
    if (changed === 'horizon' || changed === 'session') f.state.now = 200;
    if (changed === 'session')
      await assert.rejects(
        checkTransactionDeadlines(f.tx),
        (e: unknown) =>
          e instanceof ApplicationError && e.code === 'AUTHENTICATION_REQUIRED',
      );
    else {
      await checkTransactionDeadlines(f.tx);
      assert.equal(a.discussionCount, null);
      assert.equal(b.discussionCount, null);
      assert.equal(a.text, 'Visible content');
    }
    clearTransactionDeadlines(f.tx);
  }
});
test('small fallback stays exact and large unsupported-writer history is readable with null', async () => {
  for (const size of [3, 1025]) {
    const f = fixture(size);
    f.state.writerCapacity = 128;
    const result = await f.render();
    await checkTransactionDeadlines(f.tx);
    assert.equal(result.discussionCount, size === 3 ? 3 : null);
    assert.equal(result.text, 'Visible content');
    clearTransactionDeadlines(f.tx);
  }
});
test('exact export fails closed on late proof mismatch; rollback failure remains fatal', async () => {
  const f = fixture();
  await f.serializer.publicExport(f.post.id, f.tx);
  f.state.epoch = '2';
  await assert.rejects(
    checkTransactionDeadlines(f.tx),
    (e: unknown) =>
      e instanceof ApplicationError && e.code === 'COMMUNITY_UNAVAILABLE',
  );
  clearTransactionDeadlines(f.tx);
  const g = fixture();
  g.state.failure = Object.assign(new Error('timeout'), { code: '57014' });
  g.state.failRollback = true;
  await assert.rejects(g.render(), /rollback failed/);
  clearTransactionDeadlines(g.tx);
});
test('stable budget lifetime survives restores while authority read epoch still changes', () => {
  const f = fixture();
  const lifetime = transactionLifetime(f.tx),
    epoch = transactionReadEpoch(f.tx);
  restoreTransactionDeadlines(f.tx, checkpointTransactionDeadlines(f.tx));
  assert.equal(transactionLifetime(f.tx), lifetime);
  assert.notEqual(transactionReadEpoch(f.tx), epoch);
  clearTransactionDeadlines(f.tx);
  assert.equal(transactionLifetime(f.tx), undefined);
  startTransactionDeadlines(f.tx);
  assert.notEqual(transactionLifetime(f.tx), lifetime);
  clearTransactionDeadlines(f.tx);
});

test('public hot/pinned schema accepts only all-null or exact safe count triples', async () => {
  const f = fixture(2);
  const post = await f.render();
  const wire: Record<string, unknown> = { ...post };
  delete wire['allowAnonymousDm'];
  assert.equal(hotPostViewSchema.safeParse(wire).success, true);
  assert.equal(
    hotPostViewSchema.safeParse({
      ...wire,
      commentCount: null,
      replyCount: null,
      discussionCount: null,
    }).success,
    true,
  );
  assert.equal(
    hotPostViewSchema.safeParse({
      ...wire,
      commentCount: 2147483648,
      replyCount: 0,
      discussionCount: 2147483648,
    }).success,
    true,
  );
  for (const patch of [
    { commentCount: null },
    { replyCount: null },
    { discussionCount: null },
    { discussionCount: 999 },
    { commentCount: -1, discussionCount: -1 },
    {
      commentCount: Number.MAX_SAFE_INTEGER,
      replyCount: 1,
      discussionCount: Number.MAX_SAFE_INTEGER + 1,
    },
  ])
    assert.equal(
      hotPostViewSchema.safeParse({ ...wire, ...patch }).success,
      false,
    );
  clearTransactionDeadlines(f.tx);
});
