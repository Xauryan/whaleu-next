/** Real AppModule/PostgreSQL regression. Canonical approvals, identity, blocks,
 * authority, media and final proofs are not replaced. Synthetic timing hooks
 * delay the real query but never replace its SQL, result or owner decision. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import request from 'supertest';
import type {
  PostView,
  CommentView,
  ReplyView,
} from '../../src/community/contracts.js';
import { FeedService } from '../../src/community/feed.service.js';
import {
  discussionEnumeration,
  proveDiscussionPlan,
} from '../support/discussion-query-plans.js';
import type { DiscussionQuerySample } from '../support/discussion-query-plans.js';
import { hashToken } from '../../src/identity/tokens.js';
import { setReviewState } from '../support/community-approval-fixtures.js';
import { childEnvelope, seedChildren } from './discussion-search-fixtures.js';
import { searchHarness, ok, failure } from './search-fixtures.js';
import type { SearchActor } from './search-fixtures.js';

function exact(post: PostView, comments: number, replies: number) {
  assert.deepEqual(
    [post.commentCount, post.replyCount, post.discussionCount],
    [comments, replies, comments + replies],
  );
}
function exactOrUnavailable(post: PostView, comments: number, replies: number) {
  // Budget variance may erase the ENTIRE triple, never accept a wrong known value.
  if (post.commentCount === null) exactNull(post);
  else exact(post, comments, replies);
}
function exactNull(post: PostView) {
  assert.deepEqual(
    [post.commentCount, post.replyCount, post.discussionCount],
    [null, null, null],
  );
  for (const key of ['countReason', 'countStatus', 'rawCount', 'scannedCount'])
    assert.equal(Object.hasOwn(post, key), false);
}
const at = (i: number) =>
  new Date(Date.UTC(2020, 0, 1) + i * 1000).toISOString();

test(
  'large discussion canonical PostgreSQL visibility, bounded continuation and optional proof',
  { timeout: 300000 },
  async (t) => {
    const h = await searchHarness();
    assert.deepEqual(h.migrationPlan.deferred, []);
    assert.ok(
      h.migrationPlan.appliedInitially.includes(
        '0168_community_discussion_order.sql',
      ),
    );
    await assert.rejects(
      h.applyDeferredMigrations(),
      /already apply every migration/,
    );
    const get = (
      path: string,
      actor: SearchActor,
      query: Record<string, unknown> = {},
    ) =>
      request(h.http)
        .get(path)
        .set('Authorization', `Bearer ${actor.accessToken}`)
        .query(query);
    try {
      await t.test(
        'small exact counts retain outgoing block, anonymous and ancestor semantics',
        async () => {
          const w = await h.world(),
            other = await w.actor();
          const [post] = await w.seed(1);
          const rootBase = await childEnvelope(h, w, post!.id);
          const [root] = await seedChildren(h, 'comment', 1, () => rootBase);
          const named = await childEnvelope(
            h,
            w,
            post!.id,
            root!.id,
            other,
            'Synthetic named reply',
          );
          const anonymous = await childEnvelope(
            h,
            w,
            post!.id,
            root!.id,
            other,
            'Synthetic anonymous reply',
            'anonymous',
          );
          const replies = await seedChildren(h, 'reply', 2, (i) =>
            i === 0 ? named : anonymous,
          );
          const detail = async () => {
            const result = await get(
              `/v1/community/posts/${post!.id}`,
              w.reader,
            );
            ok(result);
            return result.body as PostView;
          };
          exact(await detail(), 1, 2);
          await h.writeBlock(other, w.reader);
          exact(await detail(), 1, 2); // Incoming child block does not hide list projections.
          await h.writeBlock(w.reader, other);
          exact(await detail(), 1, 1); // Anonymous sibling does not disclose its owner.
          const comment = await get(
            `/v1/community/comments/${root!.id}`,
            w.reader,
          );
          ok(comment);
          assert.equal(comment.body.replyCount, 1);
          assert.deepEqual(
            comment.body.replyPreview.items.map((r: ReplyView) => r.id),
            [replies[1]!.id],
          );
          await setReviewState(h.pool, root!.decision, 'held');
          exact(await detail(), 0, 0);
          failure(
            await get(`/v1/community/replies/${replies[1]!.id}`, w.reader),
            404,
          );
        },
      );

      await t.test(
        '1025 roots plus 1025 replies do not reject a mixed feed or deep context; hidden-heavy pages advance',
        async () => {
          const w = await h.world(),
            hidden = await w.actor();
          const posts = await w.seed(4),
            post = posts[0]!;
          const hiddenRoot = await childEnvelope(h, w, post.id, null, hidden);
          const visibleRoot = await childEnvelope(h, w, post.id);
          const roots = await seedChildren(
            h,
            'comment',
            1025,
            (i) => (i < 1024 ? hiddenRoot : visibleRoot),
            { time: at },
          );
          const root = roots[1024]!;
          const replyBase = await childEnvelope(h, w, post.id, root.id);
          const replies = await seedChildren(
            h,
            'reply',
            1025,
            () => replyBase,
            { time: at },
          );
          await h.pool.query(
            'ANALYZE whaleu_community.root_comments; ANALYZE whaleu_community.discussion_root_order; ANALYZE whaleu_community.discussion_live_root_order; ANALYZE whaleu_community.replies',
          );
          const feed = await get('/v1/community/posts', w.reader, {
            spaceId: w.scope.home.spaceId,
          });
          ok(feed);
          assert.equal(feed.body.items.length, 4);
          for (const item of feed.body.items as PostView[])
            exactOrUnavailable(
              item,
              item.id === post.id ? 1025 : 0,
              item.id === post.id ? 1025 : 0,
            );
          await h.writeBlock(w.reader, hidden);
          const detail = await get(`/v1/community/posts/${post.id}`, w.reader);
          ok(detail);
          exactOrUnavailable(detail.body, 1, 1025);
          let rootsQueries = 0,
            replyQueries = 0;
          h.observer.setHook(async ({ sql, rows }) => {
            if (sql.startsWith('/* discussion:root-time */')) {
              rootsQueries++;
              assert.ok(rows <= 129);
            }
            if (
              sql.startsWith('SELECT * FROM whaleu_community.replies') &&
              sql.includes('LIMIT 129')
            ) {
              replyQueries++;
              assert.ok(rows <= 129);
            }
          });
          try {
            const found: string[] = [];
            let cursor: string | null = null,
              empty = 0,
              pages = 0;
            do {
              const response = await get(
                `/v1/community/posts/${post.id}/comments`,
                w.reader,
                {
                  sort: 'time',
                  order: 'asc',
                  limit: 10,
                  ...(cursor ? { cursor } : {}),
                },
              );
              ok(response);
              const items = response.body.items as CommentView[];
              found.push(...items.map((item) => item.id));
              if (!items.length) empty++;
              cursor = response.body.nextCursor as string | null;
              if (cursor) {
                assert.match(cursor, /^[A-Za-z0-9_-]{43}$/);
                for (const row of roots)
                  assert.equal(cursor.includes(row.id), false);
              }
              assert.ok(
                ++pages <= 9,
                'Hidden prefix must make progress in bounded scans',
              );
            } while (cursor);
            assert.deepEqual(found, [root.id]);
            assert.equal(empty, 8);
            assert.equal(rootsQueries, 9);
            const actual = new Set<string>();
            cursor = null;
            pages = 0;
            do {
              const response = await get(
                `/v1/community/comments/${root.id}/replies`,
                w.reader,
                { limit: 50, ...(cursor ? { cursor } : {}) },
              );
              ok(response);
              for (const item of response.body.items as ReplyView[]) {
                assert.equal(actual.has(item.id), false);
                actual.add(item.id);
              }
              cursor = response.body.nextCursor as string | null;
              assert.ok(++pages <= 21);
            } while (cursor);
            assert.deepEqual(
              [...actual].sort(),
              replies.map((r) => r.id).sort(),
            );
            assert.ok(replyQueries <= 23); // 21 pages plus selected-root preview.
            const target = (
              await h.pool.query<{ id: string }>(
                'SELECT id FROM whaleu_community.replies WHERE root_comment_id=$1 ORDER BY sequence DESC LIMIT 1',
                [root.id],
              )
            ).rows[0]!;
            const context = await get(
              `/v1/community/posts/${post.id}/discussion-context`,
              w.reader,
              { replyId: target.id },
            );
            ok(context);
            assert.equal(context.body.reply.id, target.id);
            assert.ok(context.body.replies.items.length <= 5);
            assert.ok(
              context.body.replies.items.some(
                (r: ReplyView) => r.id === target.id,
              ),
            );
            assert.equal(context.body.replies.nextCursor, null);
            const first = await get(
              `/v1/community/comments/${root.id}/replies`,
              w.reader,
              { limit: 1 },
            );
            ok(first);
            assert.ok(first.body.nextCursor);
            // Opaque position is not a credential and is bound to the authenticated session/viewer.
            failure(
              await get(`/v1/community/comments/${root.id}/replies`, w.author, {
                limit: 1,
                cursor: first.body.nextCursor,
              }),
              409,
              'DISCUSSION_RESTART_REQUIRED',
            );
            const firstReply = replies.find(
              (r) => r.id === first.body.items[0].id,
            )!;
            await setReviewState(h.pool, firstReply.decision, 'held');
            failure(
              await get(`/v1/community/comments/${root.id}/replies`, w.reader, {
                limit: 1,
                cursor: first.body.nextCursor,
              }),
              409,
              'DISCUSSION_RESTART_REQUIRED',
            );
          } finally {
            h.observer.setHook(null);
          }
          const samples = new Map<string, DiscussionQuerySample>();
          const proved = new Set<string>();
          let phase = 'live';
          h.observer.setHook(async ({ sql, values, rows }) => {
            const kind = discussionEnumeration(sql);
            if (!kind) return;
            assert.ok(rows <= 129);
            const seek = values.length > 2;
            const direction =
              kind === 'time'
                ? sql.includes('created_at ASC,root_id ASC')
                  ? '-asc'
                  : '-desc'
                : kind === 'replies'
                  ? sql.includes(
                      'ORDER BY post_id ASC,root_comment_id ASC,sequence ASC',
                    )
                    ? '-asc'
                    : '-desc'
                  : '';
            samples.set(
              `${phase}:${kind}${direction}:${seek ? 'seek' : 'first'}`,
              { sql, values },
            );
          });
          try {
            await h.pool.query(
              'INSERT INTO whaleu_community.comment_pins(post_id,comment_id) VALUES($1,$2)',
              [post.id, root.id],
            );
            await h.pool.query(
              'INSERT INTO whaleu_community.comment_likes(comment_id,account_id) VALUES($1,$2)',
              [roots[0]!.id, w.reader.accountId],
            );
            const readModes = async () => {
              for (const [sort, order] of [
                ['likes', 'desc'],
                ['likes', 'asc'],
                ['time', 'asc'],
                ['time', 'desc'],
              ] as const) {
                const options =
                  sort === 'likes' && order === 'desc'
                    ? { limit: 2 }
                    : { sort, order, limit: 2 };
                const first = await get(
                  `/v1/community/posts/${post.id}/comments`,
                  w.reader,
                  options,
                );
                ok(first);
                let next = first.body.nextCursor as string | null,
                  reads = 1;
                while (next) {
                  const result = await get(
                    `/v1/community/posts/${post.id}/comments`,
                    w.reader,
                    { ...options, cursor: next },
                  );
                  ok(result);
                  next = result.body.nextCursor as string | null;
                  assert.ok(++reads <= 10);
                  if (sort !== 'likes' || order !== 'asc') break;
                }
              }
              ok(
                await get(
                  `/v1/community/posts/${post.id}/discussion-context`,
                  w.reader,
                  { replyId: replies[1024]!.id },
                ),
              );
            };
            await readModes();
            for (const [label, sample] of samples) {
              await proveDiscussionPlan(h.pool, t, label, sample);
              proved.add(label);
            }
            samples.clear();
            // Long physical prefixes remain in the table, but cannot participate
            // in live index ranges. Alternate hidden and tombstoned rows.
            await h.pool.query(
              "UPDATE whaleu_community.root_comments SET visibility='hidden' WHERE id=ANY($1::uuid[])",
              [roots.slice(0, 512).map((r) => r.id)],
            );
            await h.pool.query(
              'UPDATE whaleu_community.root_comments SET deleted_at=clock_timestamp() WHERE id=ANY($1::uuid[])',
              [roots.slice(512, 1024).map((r) => r.id)],
            );
            await h.pool.query(
              "UPDATE whaleu_community.replies SET visibility='hidden' WHERE id=ANY($1::uuid[])",
              [replies.slice(0, 500).map((r) => r.id)],
            );
            await h.pool.query(
              'UPDATE whaleu_community.replies SET deleted_at=clock_timestamp() WHERE id=ANY($1::uuid[])',
              [replies.slice(500, 1000).map((r) => r.id)],
            );
            await h.pool.query(
              'ANALYZE whaleu_community.root_comments; ANALYZE whaleu_community.discussion_root_order; ANALYZE whaleu_community.discussion_live_root_order; ANALYZE whaleu_community.replies',
            );
            phase = 'physical-hidden-deleted-prefix';
            await readModes();
            ok(
              await get(`/v1/community/comments/${root.id}/replies`, w.reader, {
                limit: 10,
              }),
            );
          } finally {
            h.observer.setHook(null);
          }
          for (const [label, sample] of samples) {
            await proveDiscussionPlan(h.pool, t, label, sample);
            proved.add(label);
          }
          for (const required of [
            'live:likes-desc:first',
            'live:likes-desc:seek',
            'live:likes-asc:first',
            'live:likes-asc:seek',
            'live:time-asc:seek',
            'live:time-desc:seek',
            'live:replies-asc:first',
            'live:replies-desc:seek',
            'live:replies-asc:seek',
            'physical-hidden-deleted-prefix:likes-desc:first',
            'physical-hidden-deleted-prefix:likes-asc:first',
            'physical-hidden-deleted-prefix:time-asc:first',
            'physical-hidden-deleted-prefix:time-desc:first',
            'physical-hidden-deleted-prefix:replies-asc:first',
          ])
            assert.ok(
              proved.has(required),
              `Missing actual route plan sample: ${required}`,
            );
        },
      );

      await t.test(
        'reply ranges exclude live unrelated prefixes, suffixes and interleaved scopes',
        async () => {
          const w = await h.world();
          const [post, otherPost] = await w.seed(2);
          const base = await childEnvelope(h, w, post!.id);
          const [root, otherRoot, emptyRoot] = await seedChildren(
            h,
            'comment',
            3,
            () => base,
          );
          const otherBase = await childEnvelope(h, w, otherPost!.id);
          const [foreignRoot] = await seedChildren(
            h,
            'comment',
            1,
            () => otherBase,
          );
          const target = await childEnvelope(h, w, post!.id, root!.id);
          const sibling = await childEnvelope(h, w, post!.id, otherRoot!.id);
          const foreign = await childEnvelope(
            h,
            w,
            otherPost!.id,
            foreignRoot!.id,
          );
          await seedChildren(h, 'reply', 257, () => sibling);
          const wanted = await seedChildren(h, 'reply', 5, () => target);
          await seedChildren(h, 'reply', 257, () => foreign);
          wanted.push(...(await seedChildren(h, 'reply', 5, () => target)));
          await seedChildren(h, 'reply', 257, () => sibling);
          await h.pool.query('ANALYZE whaleu_community.replies');
          const samples: DiscussionQuerySample[] = [];
          h.observer.setHook(async ({ sql, values, rows }) => {
            if (discussionEnumeration(sql) !== 'replies') return;
            assert.ok(rows <= 129);
            samples.push({ sql, values });
          });
          try {
            const ids: string[] = [];
            let cursor: string | null = null;
            do {
              const page = await get(
                `/v1/community/comments/${root!.id}/replies`,
                w.reader,
                { limit: 3, ...(cursor ? { cursor } : {}) },
              );
              ok(page);
              ids.push(...page.body.items.map((row: ReplyView) => row.id));
              cursor = page.body.nextCursor as string | null;
              assert.ok(ids.length <= wanted.length);
            } while (cursor);
            assert.deepEqual(
              ids,
              wanted.map((row) => row.id),
            );
            const empty = await get(
              `/v1/community/comments/${emptyRoot!.id}/replies`,
              w.reader,
            );
            ok(empty);
            assert.deepEqual(empty.body.items, []);
            assert.equal(empty.body.nextCursor, null);
            ok(
              await get(
                `/v1/community/posts/${post!.id}/discussion-context`,
                w.reader,
                { replyId: wanted[5]!.id },
              ),
            );
          } finally {
            h.observer.setHook(null);
          }
          assert.ok(samples.some((sample) => sample.values.length === 2));
          assert.ok(samples.some((sample) => sample.values.length === 3));
          assert.ok(
            samples.some((sample) =>
              sample.sql.includes(
                'post_id DESC,root_comment_id DESC,sequence DESC',
              ),
            ),
          );
          assert.ok(
            samples.some((sample) => sample.values[1] === emptyRoot!.id),
          );
          for (const [index, sample] of samples.entries())
            await proveDiscussionPlan(
              h.pool,
              t,
              `unrelated-live:${index}`,
              sample,
            );
        },
      );

      await t.test(
        'live root ranges isolate other posts and retain sparse, pin-only and empty plans',
        async () => {
          const w = await h.world();
          const [post, otherPost, emptyPost] = await w.seed(3);
          const otherBase = await childEnvelope(h, w, otherPost!.id);
          await seedChildren(h, 'comment', 1025, () => otherBase);
          const base = await childEnvelope(h, w, post!.id);
          const roots = await seedChildren(h, 'comment', 5, () => base, {
            time: at,
          });
          await h.pool.query(
            'INSERT INTO whaleu_community.comment_pins(post_id,comment_id) VALUES($1,$2)',
            [post!.id, roots[0]!.id],
          );
          await h.pool.query(
            'INSERT INTO whaleu_community.comment_likes(comment_id,account_id) VALUES($1,$2),($3,$2),($3,$4)',
            [
              roots[3]!.id,
              w.reader.accountId,
              roots[4]!.id,
              w.author.accountId,
            ],
          );
          const samples = new Map<string, DiscussionQuerySample>();
          let phase = 'sparse';
          h.observer.setHook(async ({ sql, values, rows }) => {
            const kind = discussionEnumeration(sql);
            if (!kind || kind === 'replies') return;
            assert.ok(rows <= 129);
            samples.set(
              `${phase}:${kind}:${sql.includes('created_at ASC,root_id ASC') ? 'asc' : 'desc'}:${values.length > 2 ? 'seek' : 'first'}`,
              { sql, values },
            );
          });
          const checkPlans = async () => {
            for (const [label, sample] of samples)
              await proveDiscussionPlan(
                h.pool,
                t,
                `other-live-roots:${label}`,
                sample,
              );
            samples.clear();
          };
          const modes = async (postId: string, expected: readonly string[]) => {
            for (const [sort, order] of [
              ['time', 'asc'],
              ['time', 'desc'],
              ['likes', 'asc'],
              ['likes', 'desc'],
            ] as const) {
              const ids: string[] = [];
              let cursor: string | null = null;
              do {
                const page = await get(
                  `/v1/community/posts/${postId}/comments`,
                  w.reader,
                  { sort, order, limit: 2, ...(cursor ? { cursor } : {}) },
                );
                ok(page);
                ids.push(...page.body.items.map((row: CommentView) => row.id));
                cursor = page.body.nextCursor as string | null;
                assert.ok(ids.length <= expected.length);
              } while (cursor);
              assert.equal(new Set(ids).size, ids.length);
              const expectedOrder = [...expected].sort((a, b) => {
                if (a === roots[0]!.id) return -1;
                if (b === roots[0]!.id) return 1;
                const left = roots.findIndex((root) => root.id === a);
                const right = roots.findIndex((root) => root.id === b);
                if (sort === 'likes') {
                  const counts = [0, 0, 0, 1, 2];
                  const difference = counts[left]! - counts[right]!;
                  if (difference)
                    return order === 'asc' ? difference : -difference;
                }
                return sort === 'time' && order === 'asc'
                  ? left - right
                  : right - left;
              });
              assert.deepEqual(ids, expectedOrder);
            }
          };
          try {
            await h.pool.query(
              'ANALYZE whaleu_community.discussion_live_root_order',
            );
            await modes(
              post!.id,
              roots.map((row) => row.id),
            );
            await checkPlans();
            await h.pool.query(
              "UPDATE whaleu_community.root_comments SET visibility='hidden' WHERE id=ANY($1::uuid[])",
              [roots.slice(1).map((row) => row.id)],
            );
            await h.pool.query(
              'ANALYZE whaleu_community.discussion_live_root_order',
            );
            phase = 'pin-only';
            await modes(post!.id, [roots[0]!.id]);
            await checkPlans();
            phase = 'empty';
            await modes(emptyPost!.id, []);
            await checkPlans();
          } finally {
            h.observer.setHook(null);
          }
        },
      );

      await t.test(
        'all real nested preview projections precede the first account cursor quota lock',
        async () => {
          const w = await h.world();
          const [post] = await w.seed(1);
          const base = await childEnvelope(h, w, post!.id);
          const roots = await seedChildren(h, 'comment', 3, () => base);
          for (const root of roots) {
            const replies = await childEnvelope(h, w, post!.id, root.id);
            await seedChildren(h, 'reply', 4, () => replies);
          }
          const locked = new WeakSet<object>(),
            finalizing = new WeakSet<object>();
          let quotas = 0;
          h.observer.setBeforeHook(async ({ sql, values }, tx) => {
            if (sql === 'SET CONSTRAINTS ALL IMMEDIATE') finalizing.add(tx);
            const quota =
              sql === 'SELECT pg_advisory_xact_lock(hashtextextended($1,0))' &&
              String(values[0]).startsWith('whaleu:discovery:quota:v1:');
            if (locked.has(tx) && !finalizing.has(tx))
              assert.ok(
                quota ||
                  sql.includes('whaleu_community.discovery_cursors') ||
                  sql === 'COMMIT',
                `Domain operation after first quota lock: ${sql}`,
              );
            if (quota) {
              locked.add(tx);
              quotas++;
            }
            if (sql === 'COMMIT' || sql === 'ROLLBACK') {
              locked.delete(tx);
              finalizing.delete(tx);
            }
          });
          try {
            const page = await get(
              `/v1/community/posts/${post!.id}/comments`,
              w.reader,
              { sort: 'time', order: 'asc', limit: 2, previewLimit: 2 },
            );
            ok(page);
            assert.ok(page.body.nextCursor);
            assert.equal(page.body.items.length, 2);
            for (const root of page.body.items as CommentView[])
              assert.ok(root.replyPreview.nextCursor);
            assert.equal(quotas, 3);
            const detail = await get(
              `/v1/community/comments/${roots[0]!.id}`,
              w.reader,
            );
            ok(detail);
            assert.ok(detail.body.replyPreview.nextCursor);
            const context = await get(
              `/v1/community/posts/${post!.id}/discussion-context`,
              w.reader,
              { commentId: roots[0]!.id },
            );
            ok(context);
            assert.ok(context.body.comment.replyPreview.nextCursor);
            const legacy = await h.app
              .get(FeedService)
              .comments(w.reader.accessToken, post!.id, { limit: 2 });
            assert.equal(legacy.items.length, 2);
            for (const root of legacy.items)
              assert.ok(root.replyPreview.nextCursor);
          } finally {
            h.observer.setBeforeHook(null);
          }
        },
      );

      await t.test(
        'one real source-budget expiry leaves the entire ten-post feed readable with generic null counts',
        async () => {
          const w = await h.world();
          await w.seed(10);
          let waited = false,
            candidateQueries = 0;
          h.observer.setBeforeHook(async ({ sql }) => {
            if (!sql.includes('AS "postId"') || !sql.includes('LIMIT 257'))
              return;
            candidateQueries++;
            if (!waited) {
              waited = true;
              await sleep(2100);
            }
          });
          try {
            const result = await get('/v1/community/posts', w.reader, {
              spaceId: w.scope.home.spaceId,
            });
            ok(result);
            assert.equal(result.body.items.length, 10);
            for (const post of result.body.items as PostView[]) exactNull(post);
            assert.equal(waited, true);
            assert.equal(
              candidateQueries,
              1,
              'Budget must not reset for each feed item',
            );
          } finally {
            h.observer.setBeforeHook(null);
          }
        },
      );

      await t.test(
        'late transactional count-source change erases only counts; real session expiry still denies the response',
        async () => {
          for (const scenario of ['owner', 'session'] as const) {
            const w = await h.world(),
              [post] = await w.seed(1);
            const base = await childEnvelope(h, w, post!.id);
            const [root] = await seedChildren(h, 'comment', 1, () => base);
            const expires = new Date(Date.now() + 1800);
            if (scenario === 'session')
              await h.pool.query(
                'UPDATE whaleu_identity.access_tokens SET expires_at=$2 WHERE token_hash=$1',
                [hashToken(w.reader.accessToken), expires],
              );
            let changed = false;
            h.observer.setHook(async ({ sql }, tx) => {
              if (
                changed ||
                sql !== 'RELEASE SAVEPOINT discovery_optional_count'
              )
                return;
              changed = true;
              if (scenario === 'owner')
                // Test-only in-transaction source mutation exercises real epoch
                // triggers without inventing a concurrent policy-lock bypass.
                await tx.query(
                  'UPDATE whaleu_community.root_comments SET deleted_at=clock_timestamp() WHERE id=$1',
                  [root!.id],
                );
              else
                await sleep(Math.max(0, expires.getTime() - Date.now()) + 60);
            });
            try {
              const result = await get(
                `/v1/community/posts/${post!.id}`,
                w.reader,
              );
              assert.equal(changed, true);
              if (scenario === 'owner') {
                ok(result);
                exactNull(result.body);
                assert.equal(result.body.id, post!.id);
              } else failure(result, 401, 'ACCESS_TOKEN_EXPIRED');
            } finally {
              h.observer.setHook(null);
            }
          }
        },
      );
    } finally {
      await h.close();
    }
  },
);
