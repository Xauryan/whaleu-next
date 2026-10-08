import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import type { PoolClient } from 'pg';
import { SearchRepository } from '../../src/community/search/repository.js';
import { searchHarness, ok, failure } from './search-fixtures.js';
import type { SearchHarness } from './search-fixtures.js';
import {
  childEnvelope,
  seedChildren,
  hitKeys,
} from './discussion-search-fixtures.js';
import { withScalarSearchLocks } from '../support/search-scalar-locks.js';

const uuid = (i: number) =>
  `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
const at = '2026-10-01T00:00:00.123456Z';
const sources = [
  { kind: 'post', table: 'posts', alias: 'p' },
  { kind: 'comment', table: 'root_comments', alias: 'c' },
  { kind: 'reply', table: 'replies', alias: 'r' },
] as const;
async function chains(h: SearchHarness, offset: number, count = 3) {
  const w = await h.world();
  const base = await w.envelope({ text: 'needle 原样 parent' });
  const posts = await w.seed(count, () => base, {
    id: (i) => uuid(offset + i),
    time: () => at,
  });
  for (const post of posts) {
    const root = await childEnvelope(
      h,
      w,
      post.id,
      null,
      w.author,
      'NEEDLE 原样 root',
    );
    await seedChildren(h, 'comment', 1, () => root, {
      id: () => post.id,
      time: () => at,
    });
    const reply = await childEnvelope(
      h,
      w,
      post.id,
      post.id,
      w.author,
      'needle 原样 reply',
    );
    await seedChildren(h, 'reply', 1, () => reply, {
      id: () => post.id,
      time: () => at,
    });
  }
  return { w, posts };
}
async function waitForMetadata(h: SearchHarness, table: string, alias: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await h.pool.query<{ waiting: boolean }>(
      "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE query LIKE $1 AND query LIKE $2 AND wait_event_type='Lock') waiting",
      [
        `%FROM whaleu_community.${table} ${alias}%`,
        `%ORDER BY ${alias}.id ASC FOR SHARE OF ${alias}%`,
      ],
    );
    if (result.rows[0]!.waiting) return;
    await sleep(5);
  }
  assert.fail(`Search must wait on the actual ${table} metadata batch`);
}
async function probeLock(
  tx: PoolClient,
  table: string,
  id: string,
  locked: boolean,
) {
  await tx.query('BEGIN');
  try {
    const probe = () =>
      tx.query(
        `SELECT id FROM whaleu_community.${table} WHERE id=$1 FOR UPDATE NOWAIT`,
        [id],
      );
    if (locked)
      await assert.rejects(
        probe(),
        (e: unknown) =>
          typeof e === 'object' &&
          e !== null &&
          'code' in e &&
          e.code === '55P03',
      );
    else await probe();
  } finally {
    await tx.query('ROLLBACK');
  }
}

test(
  'batched search metadata preserves scalar results and PostgreSQL lock hierarchy',
  { timeout: 120000 },
  async (t) => {
    const h = await searchHarness();
    try {
      await t.test(
        'scalar and batch traversal preserve tied kind-qualified IDs, snippets and logical cursor positions',
        async () => {
          const { w } = await chains(h, 1);
          const repository = h.app.get(SearchRepository);
          for (const type of ['all', 'post', 'comment', 'reply'] as const) {
            for (const q of ['needle', 'absent']) {
              const traverse = async () => {
                const pages: unknown[] = [];
                let cursor: string | undefined;
                do {
                  const result = await w.search({
                    type,
                    q,
                    limit: '1',
                    ...(cursor ? { cursor } : {}),
                  });
                  ok(result);
                  cursor = result.body.nextCursor ?? undefined;
                  pages.push({
                    ...result.body,
                    nextCursor: cursor ? await h.position(cursor) : null,
                  });
                  assert.ok(pages.length <= 10);
                } while (cursor);
                return pages;
              };
              const scalar = await withScalarSearchLocks(repository, traverse);
              assert.deepEqual(await traverse(), scalar, `${type}/${q}`);
            }
          }
          const first = await w.search({ type: 'reply', limit: '1' });
          ok(first);
          await h.mutate((tx) =>
            tx.query(
              'UPDATE whaleu_community.replies SET deleted_at=clock_timestamp() WHERE id=$1',
              [first.body.items[0].contentId],
            ),
          );
          const resume = async () =>
            await w.search({
              type: 'reply',
              limit: '1',
              cursor: first.body.nextCursor,
            });
          failure(
            await withScalarSearchLocks(repository, resume),
            409,
            'DISCOVERY_RESTART_REQUIRED',
          );
          failure(await resume(), 409, 'DISCOVERY_RESTART_REQUIRED');
          // Existing source without an owner approval remains unknown, not a denial.
          await h.mutate((tx) =>
            tx.query(
              "INSERT INTO whaleu_community.replies(id,post_id,root_comment_id,account_id,text,author_mode,created_at) VALUES($1,$2,$2,$3,'irrelevant unknown','named',$4)",
              [
                uuid(99),
                uuid(1),
                w.author.accountId,
                '2026-10-02T00:00:00.000000Z',
              ],
            ),
          );
          const unknown = async () =>
            await w.search({ type: 'reply', q: 'absent' });
          failure(
            await withScalarSearchLocks(repository, unknown),
            503,
            'COMMUNITY_UNAVAILABLE',
          );
          failure(await unknown(), 503, 'COMMUNITY_UNAVAILABLE');
        },
      );

      await t.test(
        'each SQL batch locks UUIDs ascending and all parents before roots before replies',
        async () => {
          for (const [index, source] of sources.entries()) {
            const { w, posts } = await chains(h, 100 + index * 10);
            const writer = await h.pool.connect(),
              probe = await h.pool.connect();
            await writer.query('BEGIN');
            await writer.query(
              `SELECT id FROM whaleu_community.${source.table} WHERE id=$1 FOR UPDATE`,
              [posts[1]!.id],
            );
            const pending = w
              .search({ type: 'reply', limit: '1' })
              .then((r) => r);
            try {
              await waitForMetadata(h, source.table, source.alias);
              for (const [otherIndex, other] of sources.entries()) {
                await probeLock(
                  probe,
                  other.table,
                  posts[0]!.id,
                  otherIndex <= index,
                );
                await probeLock(
                  probe,
                  other.table,
                  posts[2]!.id,
                  otherIndex < index,
                );
              }
              await writer.query('COMMIT');
              ok(await pending);
            } finally {
              await writer.query('ROLLBACK');
              writer.release();
              probe.release();
              await pending;
            }
          }
        },
      );

      await t.test(
        'a metadata batch timeout rolls back acquired locks before any body or cursor work',
        async () => {
          const { w, posts } = await chains(h, 400);
          const writer = await h.pool.connect(),
            probe = await h.pool.connect();
          await writer.query('BEGIN');
          await writer.query(
            'SELECT id FROM whaleu_community.root_comments WHERE id=$1 FOR UPDATE',
            [posts[1]!.id],
          );
          let timeoutSet = false;
          const observed: string[] = [],
            failures: (string | null)[] = [];
          h.observer.setHook(async (event, tx) => {
            observed.push(event.sql);
            if (!timeoutSet && event.sql.includes('UNION ALL')) {
              timeoutSet = true;
              await tx.query("SET LOCAL statement_timeout='250ms'");
            }
          });
          h.observer.setFailureHook(async (event) => {
            if (event.sql.endsWith('FOR SHARE OF c')) failures.push(event.code);
          });
          try {
            failure(
              await w.search({ type: 'reply', limit: '1' }),
              500,
              'INTERNAL_ERROR',
            );
            assert.equal(timeoutSet, true);
            assert.deepEqual(failures, ['57014']);
            assert.ok(observed.includes('ROLLBACK'));
            assert.equal(
              observed.some(
                (sql) =>
                  sql.includes(
                    'INSERT INTO whaleu_community.discovery_cursors',
                  ) ||
                  /SELECT \* FROM whaleu_community\.(posts|root_comments|replies)/.test(
                    sql,
                  ),
              ),
              false,
            );
            await probeLock(probe, 'posts', posts[0]!.id, false);
            await probeLock(probe, 'root_comments', posts[0]!.id, false);
          } finally {
            h.observer.setHook(null);
            h.observer.setFailureHook(null);
            await writer.query('ROLLBACK');
            writer.release();
            probe.release();
          }
        },
      );

      await t.test(
        'lock-wait deletion, source hiding and newly eligible unheld children are rechecked',
        async () => {
          for (const [index, mode] of ['delete', 'hide', 'unheld'].entries()) {
            const { w, posts } = await chains(h, 200 + index * 10);
            const target = posts[2]!.id;
            if (mode === 'unheld')
              await h.mutate((tx) =>
                tx.query(
                  "UPDATE whaleu_community.replies SET visibility='hidden' WHERE id=$1",
                  [posts[0]!.id],
                ),
              );
            const writer = await h.pool.connect();
            await writer.query('BEGIN');
            await writer.query(
              'SELECT id FROM whaleu_community.replies WHERE id=$1 FOR UPDATE',
              [target],
            );
            const pending = w
              .search({ type: 'reply', limit: '1' })
              .then((r) => r);
            try {
              await waitForMetadata(h, 'replies', 'r');
              if (mode === 'delete')
                await writer.query(
                  'UPDATE whaleu_community.replies SET deleted_at=clock_timestamp() WHERE id=$1',
                  [target],
                );
              if (mode === 'hide')
                await writer.query(
                  "UPDATE whaleu_community.replies SET visibility='hidden' WHERE id=$1",
                  [target],
                );
              if (mode === 'unheld')
                await writer.query(
                  "UPDATE whaleu_community.replies SET visibility='approved' WHERE id=$1",
                  [posts[0]!.id],
                );
              await writer.query('COMMIT');
              const result = await pending;
              if (mode === 'unheld')
                failure(result, 503, 'COMMUNITY_UNAVAILABLE');
              else {
                ok(result);
                assert.deepEqual(hitKeys(result.body), [
                  `reply:${posts[1]!.id}`,
                ]);
              }
            } finally {
              await writer.query('ROLLBACK');
              writer.release();
              await pending;
            }
          }
        },
      );
    } finally {
      await h.close();
    }
  },
);
