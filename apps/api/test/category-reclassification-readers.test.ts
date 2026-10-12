import {
  batchCategoryChildContextAllowed,
  categoryChildContextAllowed,
} from '../src/community/category-reclassification/child-context.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import type { Category } from '../src/community/contracts.js';
import {
  resolvePostCategory,
  resolvePostCategories,
  readPostCategorySnapshot,
} from '../src/community/category-reclassification/read-proof.js';
import { currentCategoryCursorScope } from '../src/community/current-category-cursor.js';
import { CURRENT_CATEGORY_POSTS_SQL } from '../src/community/current-category-sql.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
  checkTransactionDeadlines,
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { ApplicationError } from '../src/http/application-error.js';

const unavailable = (error: unknown) =>
  error instanceof ApplicationError && error.code === 'COMMUNITY_UNAVAILABLE';
function fixture(original: Category = 'pets') {
  const id = randomUUID(),
    space = randomUUID(),
    event = randomUUID(),
    policy = randomUUID(),
    review = randomUUID();
  const now = new Date('2026-10-12T12:00:00.000Z');
  const until = new Date(now.getTime() + 60000).toISOString();
  const state = {
    category: null as Category | null,
    live: true,
    revision: 0,
    epoch: '0',
    batches: 0,
    liveQueries: 0,
    childQueries: 0,
    childLiveQueries: 0,
    locks: [] as string[],
    minimumQueries: 0,
  };
  const tx = {
    query: async (sql: string, args: unknown[] = []) => {
      if (
        sql.startsWith('SELECT q.kind,q.id,q.post_id') ||
        sql.startsWith('WITH category_child_wanted')
      ) {
        if (sql.startsWith('SELECT q.kind')) state.childQueries++;
        else state.childLiveQueries++;
        const targets = JSON.parse(args[0] as string) as {
          kind: 'comment' | 'reply';
          id: string;
          post_id: string;
        }[];
        return {
          rows: targets.map((target) => ({
            kind: target.kind,
            id: target.id,
            postId: target.post_id,
            allowed: state.category === null || state.live,
            head: state.category ? event : null,
            binding: null,
            review: null,
            validUntil: state.category && state.live ? until : null,
          })),
        };
      }
      if (sql.startsWith('SELECT min(value)::text')) {
        state.minimumQueries++;
        return {
          rows: [{ until: [...(args[0] as string[])].sort()[0] ?? null }],
        };
      }
      if (
        sql.startsWith('SELECT requested.post_id') ||
        sql.startsWith('WITH category_read_live')
      ) {
        if (sql.startsWith('SELECT requested.post_id')) state.batches++;
        else state.liveQueries++;
        return {
          rows: (args[0] as string[]).map((postId) => ({
            postId,
            originalCategory: original,
            originalSpaceId: space,
            headPostId: state.category ? postId : null,
            headCategory: state.category,
            revision: state.category ? state.revision : null,
            eventId: state.category ? event : null,
            headXmin: state.category ? '42' : null,
            livePostId: state.category && state.live ? postId : null,
            liveCategory: state.live ? state.category : null,
            liveRevision: state.category && state.live ? state.revision : null,
            liveEventId: state.category && state.live ? event : null,
            policyId: state.category && state.live ? policy : null,
            reviewId: state.category && state.live ? review : null,
            validUntil: state.category && state.live ? until : null,
            batchValidUntil: state.category && state.live ? until : null,
            batchValidUntilMs:
              state.category && state.live ? Date.parse(until) : null,
            batchValidUntilMicros:
              state.category && state.live
                ? String(BigInt(Date.parse(until)) * 1000n)
                : null,
          })),
        };
      }
      if (sql.startsWith('LOCK TABLE')) state.locks.push(sql);
      if (sql.includes('SELECT version::text'))
        return { rows: [{ version: state.epoch }] };
      if (sql.includes("current_setting('transaction_isolation')"))
        return {
          rows: [
            {
              isolation: 'read committed',
              statement_timeout: '0',
              lock_timeout: '0',
            },
          ],
        };
      if (sql.includes('clock_timestamp'))
        return { rows: [{ now, expired: [] }] };
      return { rows: [] };
    },
  } as unknown as PoolClient;
  startTransactionDeadlines(tx);
  return { id, tx, state };
}

test('untouched excluded publication categories keep original reader behavior', async () => {
  for (const original of ['trading', 'feedback', 'discussion'] as const) {
    const f = fixture(original);
    try {
      assert.equal(await resolvePostCategory(f.id, f.tx), original);
      await checkTransactionDeadlines(f.tx);
      assert.equal(
        f.state.liveQueries,
        0,
        'Untouched posts never plan the current Review view',
      );
      assert.ok(
        f.state.locks.every(
          (sql) =>
            !sql.includes('post_category_live') &&
            !sql.includes('post_category_policies'),
        ),
        'Untouched classification proof fences only posts and head absence',
      );
    } finally {
      clearTransactionDeadlines(f.tx);
    }
  }
});

test('move and move-back use current classification without rewriting original category', async () => {
  const f = fixture('pets');
  try {
    f.state.category = 'scenery';
    f.state.revision = 1;
    assert.equal(await resolvePostCategory(f.id, f.tx), 'scenery');
    await checkTransactionDeadlines(f.tx);
    clearTransactionDeadlines(f.tx);
    startTransactionDeadlines(f.tx);
    f.state.category = 'pets';
    f.state.revision = 2;
    assert.equal(await resolvePostCategory(f.id, f.tx), 'pets');
    await checkTransactionDeadlines(f.tx);
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});

test('present invalid overlay has no original-category fallback', async () => {
  const f = fixture();
  try {
    f.state.category = 'scenery';
    f.state.revision = 1;
    f.state.live = false;
    assert.equal(await resolvePostCategory(f.id, f.tx), null);
    await checkTransactionDeadlines(f.tx);
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});

test('final source proof rejects first insertion and current Review withdrawal', async () => {
  for (const startMoved of [false, true]) {
    const f = fixture();
    try {
      if (startMoved) {
        f.state.category = 'scenery';
        f.state.revision = 1;
      }
      await resolvePostCategory(f.id, f.tx);
      if (startMoved) f.state.live = false;
      else {
        f.state.category = 'scenery';
        f.state.revision = 1;
      }
      await assert.rejects(checkTransactionDeadlines(f.tx), unavailable);
    } finally {
      clearTransactionDeadlines(f.tx);
    }
  }
});

test('category snapshots are batch bounded, never one SQL proof per post', async () => {
  const f = fixture();
  try {
    const ids = Array.from({ length: 513 }, () => randomUUID());
    const snapshot = await readPostCategorySnapshot(ids, f.tx);
    assert.equal(snapshot.categories.size, ids.length);
    assert.equal(f.state.batches, 2);
    assert.equal(f.state.liveQueries, 0);
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});

test('classification epoch changes cursor scope and invalidates empty-page captures', async () => {
  const f = fixture();
  try {
    const before = await currentCategoryCursorScope('feed:pets', f.tx);
    f.state.epoch = '1';
    assert.notEqual(
      await currentCategoryCursorScope('feed:pets', f.tx),
      before,
    );
    await assert.rejects(checkTransactionDeadlines(f.tx), unavailable);
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});

test('candidate relation has disjoint indexed source branches and never coalesces invalid heads', () => {
  assert.match(CURRENT_CATEGORY_POSTS_SQL, /UNION ALL/);
  assert.match(
    CURRENT_CATEGORY_POSTS_SQL,
    /NOT EXISTS[\s\S]*post_category_heads/,
  );
  assert.doesNotMatch(CURRENT_CATEGORY_POSTS_SQL, /post_category_live/);
  assert.match(
    CURRENT_CATEGORY_POSTS_SQL,
    /SELECT original\.\*,head\.current_category\s+FROM whaleu_community\.post_category_heads head/,
  );
  assert.match(
    CURRENT_CATEGORY_POSTS_SQL,
    /original\.space_id=head\.original_space_id/,
  );
  assert.match(
    CURRENT_CATEGORY_POSTS_SQL,
    /original\.published_at=head\.original_published_at/,
  );
  assert.match(
    CURRENT_CATEGORY_POSTS_SQL,
    /WHERE NOT EXISTS \(\s+SELECT 1 FROM whaleu_community\.post_category_heads head\s+WHERE head\.post_id=original\.id\s+OFFSET 0\s+\)/,
  );
  assert.doesNotMatch(CURRENT_CATEGORY_POSTS_SQL, /COALESCE|SET category/i);
});

test('bounded prewarm reuses only the current transaction read epoch', async () => {
  const f = fixture();
  try {
    const checkpoint = checkpointTransactionDeadlines(f.tx);
    const ids = [f.id, randomUUID(), randomUUID()];
    await resolvePostCategories(ids, f.tx);
    for (const id of ids)
      assert.equal(await resolvePostCategory(id, f.tx), 'pets');
    assert.equal(f.state.batches, 1);
    restoreTransactionDeadlines(f.tx, checkpoint);
    f.state.category = 'scenery';
    f.state.revision = 1;
    assert.equal(await resolvePostCategory(f.id, f.tx), 'scenery');
    assert.equal(
      f.state.batches,
      2,
      'A restored epoch cannot reuse pre-mutation classifications',
    );
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});

test('child prewarm bounds source queries and shares duplicate scalar gates in one epoch', async () => {
  const f = fixture();
  try {
    f.state.category = 'scenery';
    f.state.revision = 1;
    const targets = Array.from({ length: 600 }, (_, index) => ({
      kind: index % 2 ? ('comment' as const) : ('reply' as const),
      id: randomUUID(),
      postId: f.id,
    }));
    await batchCategoryChildContextAllowed(targets, f.tx);
    for (const target of targets) {
      assert.equal(
        await categoryChildContextAllowed(
          target.kind,
          target.id,
          target.postId,
          f.tx,
        ),
        true,
      );
      assert.equal(
        await categoryChildContextAllowed(
          target.kind,
          target.id,
          target.postId,
          f.tx,
        ),
        true,
      );
    }
    assert.equal(
      f.state.childQueries,
      2,
      '600 children require two bounded head reads, not 1200 duplicate scalar queries',
    );
    assert.equal(
      f.state.childLiveQueries,
      2,
      'Moved children require one materialized detail query per bounded batch',
    );
    assert.equal(
      f.state.minimumQueries,
      0,
      'Deadline aggregation belongs to the one final proof',
    );
    await checkTransactionDeadlines(f.tx);
    assert.equal(
      f.state.childQueries,
      4,
      'Final validation rereads the same two bounded head batches',
    );
    assert.equal(f.state.childLiveQueries, 4);
    assert.equal(f.state.minimumQueries, 1);
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});

test('restored read epoch invalidates child cache and current denial is never revived', async () => {
  const f = fixture();
  try {
    const target = { kind: 'comment' as const, id: randomUUID(), postId: f.id };
    const checkpoint = checkpointTransactionDeadlines(f.tx);
    f.state.category = 'scenery';
    f.state.revision = 1;
    assert.equal(
      await categoryChildContextAllowed(
        target.kind,
        target.id,
        target.postId,
        f.tx,
      ),
      true,
    );
    restoreTransactionDeadlines(f.tx, checkpoint);
    f.state.live = false;
    assert.equal(
      await categoryChildContextAllowed(
        target.kind,
        target.id,
        target.postId,
        f.tx,
      ),
      false,
    );
    assert.equal(f.state.childQueries, 2);
    await checkTransactionDeadlines(f.tx);
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});

test('one child identity cannot substitute a different parent inside a batch', async () => {
  const f = fixture();
  try {
    const id = randomUUID();
    await assert.rejects(
      batchCategoryChildContextAllowed(
        [
          { kind: 'comment', id, postId: f.id },
          { kind: 'comment', id, postId: randomUUID() },
        ],
        f.tx,
      ),
      unavailable,
    );
    assert.equal(f.state.childQueries, 0);
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});

test('untouched child batches and final proof never expand current Review views', async () => {
  const f = fixture();
  try {
    const targets = Array.from({ length: 600 }, () => ({
      kind: 'comment' as const,
      id: randomUUID(),
      postId: f.id,
    }));
    const result = await batchCategoryChildContextAllowed(targets, f.tx);
    assert.equal(result.size, 600);
    assert.equal([...result.values()].every(Boolean), true);
    assert.equal(f.state.childQueries, 2);
    assert.equal(f.state.childLiveQueries, 0);
    await checkTransactionDeadlines(f.tx);
    assert.equal(f.state.childQueries, 4);
    assert.equal(f.state.childLiveQueries, 0);
    assert.equal(f.state.minimumQueries, 0);
    assert.ok(
      f.state.locks.every(
        (sql) =>
          !sql.includes('post_category_live') &&
          !sql.includes('post_category_reviews'),
      ),
    );
  } finally {
    clearTransactionDeadlines(f.tx);
  }
});
