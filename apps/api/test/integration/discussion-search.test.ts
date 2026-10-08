import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { hashToken } from '../../src/identity/tokens.js';
import { freshWorld, trading, position } from './federated-search-fixtures.js';
import { SearchRepository } from '../../src/community/search/repository.js';
import { withScalarSearchLocks } from '../support/search-scalar-locks.js';
import type {
  SearchHit,
  SearchPage,
} from '../../src/community/search/contracts.js';
import { setReviewState } from '../support/community-approval-fixtures.js';
import { setRuntimeVerification } from '../support/community-runtime-fixtures.js';
import { searchHarness, ok, failure } from './search-fixtures.js';
import {
  childEnvelope,
  seedChildren,
  nativeSearch,
  hitKeys,
  textOfSnippet,
  searchTargetPath,
  decodeDiscussionContext,
} from './discussion-search-fixtures.js';

const old = '2026-09-01T00:00:00.000000Z';
const at = (i: number) =>
  `2026-10-01T00:00:00.${String(999999 - i).padStart(6, '0')}Z`;
const finalRows = 'WITH ORDINALITY AS r(viewer,author,bilateral,ordinality)';
const expectLightweight = (hit: SearchHit) => {
  assert.deepEqual(Object.keys(hit).sort(), [
    'author',
    'category',
    'contentId',
    'createdAt',
    'kind',
    'postId',
    'postSummary',
    'replyId',
    'rootCommentId',
    'snippet',
    'space',
    'target',
    'tradingSubtype',
    'tradingUrgency',
  ]);
  assert.ok([...hit.postSummary].length <= 80);
  assert.ok([...textOfSnippet(hit)].length <= 240);
  assert.ok(hit.snippet.segments.some((segment) => segment.matched));
  assert.match(hit.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
  for (const forbidden of [
    'images',
    'text',
    'replyCount',
    'discussionCount',
    'commentCount',
    'component',
    'viewer',
    'score',
    'vector',
    'total',
  ])
    assert.equal(Object.hasOwn(hit, forbidden), false, forbidden);
};

test(
  'discussion search: canonical parent chains, query-independent privacy and real native HTTP',
  { timeout: 300000 },
  async (t) => {
    const h = await searchHarness();
    try {
      await t.test(
        'native gateway finds only root/reply text, uses exact thread targets and rechecks context after hiding',
        async () => {
          const w = await h.world(),
            base = await w.envelope({
              text: 'A plain parent without the search expression',
            });
          const [post] = await w.seed(1, () => base, { time: () => old });
          const rootEnvelope = await childEnvelope(
            h,
            w,
            post!.id,
            null,
            w.author,
            '评论命中 needle 🙂 <script>plain text</script>',
          );
          const [root] = await seedChildren(
            h,
            'comment',
            1,
            () => rootEnvelope,
            { time: () => at(2) },
          );
          const replyEnvelope = await childEnvelope(
            h,
            w,
            post!.id,
            root!.id,
            w.reader,
            '回复命中 NEEDLE 100%_\\',
          );
          const [reply] = await seedChildren(
            h,
            'reply',
            1,
            () => replyEnvelope,
            { time: () => at(1) },
          );
          const native = await nativeSearch(h, w.reader);
          const intent = {
            spaceId: w.scope.home.spaceId,
            q: 'needle',
            type: 'all',
          };
          const page = (await native.gateway.search(
            intent,
            null,
            native.cancel,
          )) as SearchPage;
          assert.deepEqual(page.effectiveTypes, ['post', 'comment', 'reply']);
          assert.deepEqual(hitKeys(page), [
            `reply:${reply!.id}`,
            `comment:${root!.id}`,
          ]);
          assert.equal(page.continuation, 'end');
          for (const hit of page.items) {
            expectLightweight(hit);
            assert.equal(hit.postId, post!.id);
            assert.equal(hit.rootCommentId, root!.id);
            assert.equal(hit.space.id, w.scope.home.spaceId);
            assert.equal(hit.category, 'discussion');
            assert.equal(hit.postSummary, base.text);
            assert.equal(hit.createdAt, hit.kind === 'reply' ? at(1) : at(2));
            assert.equal(
              textOfSnippet(hit),
              hit.kind === 'reply' ? replyEnvelope.text : rootEnvelope.text,
            );
            assert.deepEqual(
              hit.target,
              hit.kind === 'reply'
                ? {
                    kind: 'reply',
                    postId: post!.id,
                    rootCommentId: root!.id,
                    replyId: reply!.id,
                  }
                : {
                    kind: 'comment',
                    postId: post!.id,
                    rootCommentId: root!.id,
                  },
            );
            assert.equal(
              searchTargetPath(hit.target),
              `/pages/community-thread/community-thread?postId=${post!.id}&rootCommentId=${root!.id}${hit.kind === 'reply' ? `&replyId=${reply!.id}` : ''}`,
            );
            const context = await native.api.request(
              {
                path: `/v1/community/posts/${hit.postId}/discussion-context`,
                method: 'GET',
                authentication: 'required',
                authReplay: 'once',
                successStatus: 200,
                decode: decodeDiscussionContext,
              },
              {
                query:
                  hit.kind === 'reply'
                    ? { replyId: hit.replyId }
                    : { commentId: hit.rootCommentId },
              },
            );
            assert.equal(context.comment.id, root!.id);
            assert.equal(context.reply?.id ?? null, hit.replyId);
          }
          assert.equal(native.transport.exchanges[0]!.authorized, true);
          assert.match(
            native.transport.exchanges[0]!.path,
            /^\/v1\/community\/search\?/,
          );
          await h.mutate((tx) =>
            tx.query(
              "UPDATE whaleu_community.root_comments SET visibility='hidden' WHERE id=$1",
              [root!.id],
            ),
          );
          await assert.rejects(
            native.api.request(
              {
                path: `/v1/community/posts/${post!.id}/discussion-context`,
                method: 'GET',
                authentication: 'required',
                authReplay: 'once',
                successStatus: 200,
                decode: decodeDiscussionContext,
              },
              { query: { replyId: reply!.id } },
            ),
            (error: unknown) => {
              const details = (error as { details?: { httpStatus?: number } })
                .details;
              assert.equal(details?.httpStatus, 404);
              return true;
            },
          );
          const current = (await native.gateway.search(
            intent,
            null,
            native.cancel,
          )) as SearchPage;
          assert.deepEqual(current.items, []);
        },
      );

      await t.test(
        'exact microsecond and cross-table UUID ties paginate by time, kind, ID with own-time filters and cursor binding',
        async () => {
          const w = await h.world(),
            base = await w.envelope({ text: 'needle post' });
          const sharedId = randomUUID();
          const [parent] = await w.seed(
            1,
            () => ({ ...base, text: 'plain parent' }),
            { time: () => old },
          );
          const rootBase = await childEnvelope(h, w, parent!.id);
          const [threadRoot] = await seedChildren(
            h,
            'comment',
            1,
            () => rootBase,
            { time: () => old },
          );
          const comment = await childEnvelope(
            h,
            w,
            parent!.id,
            null,
            w.author,
            'needle root',
          );
          const reply = await childEnvelope(
            h,
            w,
            parent!.id,
            threadRoot!.id,
            w.author,
            'needle reply',
          );
          const [postHit] = await w.seed(1, () => base, {
            time: () => at(0),
            id: () => sharedId,
          });
          const roots = await seedChildren(h, 'comment', 2, () => comment, {
            time: (i) => at(i),
            id: (i) => (i === 0 ? sharedId : randomUUID()),
          });
          const replies = await seedChildren(h, 'reply', 2, () => reply, {
            time: (i) => at(i),
            id: (i) => (i === 0 ? sharedId : randomUUID()),
          });
          const expected = [
            `post:${sharedId}`,
            `comment:${sharedId}`,
            `reply:${sharedId}`,
            `comment:${roots[1]!.id}`,
            `reply:${replies[1]!.id}`,
          ];
          const native = await nativeSearch(h, w.reader);
          const intent = {
            scope: 'all',
            q: 'needle',
            type: 'all',
            from: '2026-10-01T00:00:00.999998Z',
            to: '2026-10-02T00:00:00Z',
          };
          // Explicit space isolates this world's fixture. The aggregate membership path
          // is already covered by the federated suites and the native child-source case below.
          const isolated = {
            spaceId: w.scope.home.spaceId,
            q: intent.q,
            type: intent.type,
            from: intent.from,
            to: intent.to,
          };
          const seen: string[] = [];
          let cursor: string | null = null,
            firstCursor = '';
          do {
            const page = (await native.gateway.search(
              isolated,
              cursor,
              native.cancel,
              1,
            )) as SearchPage;
            seen.push(...hitKeys(page));
            if (page.nextCursor) {
              const position = await h.position(page.nextCursor);
              assert.equal(position.after.kind, page.items[0]!.kind);
              assert.equal(position.after.at, page.items[0]!.createdAt);
              if (!firstCursor) firstCursor = page.nextCursor;
            }
            cursor = page.nextCursor;
            assert.ok(seen.length <= expected.length);
          } while (cursor);
          assert.deepEqual(seen, expected);
          const next = (await native.gateway.search(
            isolated,
            firstCursor,
            native.cancel,
            1,
          )) as SearchPage;
          assert.deepEqual(hitKeys(next), [expected[1]]);
          for (const mismatch of [
            { type: 'reply' },
            { from: at(0) },
            { to: at(0) },
            { postId: parent!.id },
          ])
            failure(
              await w.search({
                ...isolated,
                ...mismatch,
                limit: '1',
                cursor: firstCursor,
              }),
              400,
            );
          for (const [type, expectedIds] of [
            ['post', [postHit!.id]],
            ['comment', roots.map((row) => row.id)],
            ['reply', replies.map((row) => row.id)],
          ] as const) {
            const page = await w.search({
              q: 'needle',
              type,
              from: intent.from,
              to: intent.to,
            });
            ok(page);
            assert.deepEqual(
              page.body.items.map((hit: SearchHit) => hit.contentId),
              expectedIds,
            );
            assert.deepEqual(page.body.effectiveTypes, [type]);
          }
          const scoped = await w.search({
            q: 'needle',
            type: 'all',
            postId: parent!.id,
            from: at(1),
            to: at(0),
          });
          ok(scoped);
          assert.deepEqual(hitKeys(scoped.body), expected.slice(3));
          const noPosts = await w.search({
            q: 'needle',
            type: 'post',
            postId: parent!.id,
            from: at(1),
          });
          ok(noPosts);
          assert.deepEqual(noPosts.body.items, []);
          for (const invalid of [
            { type: 'discussion' },
            { from: 'yesterday' },
            { from: '2026-10-01' },
            { from: at(0), to: at(1) },
            { from: at(0), to: at(0) },
            { postId: 'invalid' },
          ])
            failure(await w.search(invalid), 400);
        },
      );

      await t.test(
        'child literal matching keeps zero, wildcard text, emoji, Chinese and whole-string Unicode case behavior',
        async () => {
          const w = await h.world(),
            base = await w.envelope({ text: 'plain parent' });
          const [post] = await w.seed(1, () => base, { time: () => old });
          const bodies = [
            '0',
            '100%_\\ literal',
            '鲸鱼🙂',
            'İstanbul',
            'ΟΣ',
            'Straße',
          ];
          const rootBase = await childEnvelope(h, w, post!.id);
          const roots = await seedChildren(
            h,
            'comment',
            bodies.length,
            (i) => ({ ...rootBase, text: bodies[i]! }),
            { time: at },
          );
          const cases: [string, number[]][] = [
            ['0', [0, 1]],
            ['%', [1]],
            ['_', [1]],
            ['\\', [1]],
            ['鲸鱼', [2]],
            ['🙂', [2]],
            ['i', [1, 3]],
            ['i\u0307', [3]],
            ['ος', [4]],
            ['οσ', []],
            ['σ', []],
            ['straße', [5]],
            ['SS', []],
          ];
          for (const [q, indexes] of cases) {
            const result = await w.search({ q, type: 'comment' });
            ok(result);
            assert.deepEqual(
              result.body.items.map((hit: SearchHit) => hit.contentId),
              indexes.map((i) => roots[i]!.id),
              q,
            );
            for (const hit of result.body.items as SearchHit[]) {
              expectLightweight(hit);
              assert.equal(
                textOfSnippet(hit),
                bodies[roots.findIndex((row) => row.id === hit.contentId)],
              );
            }
          }
        },
      );

      await t.test(
        'guest all is post-only, explicit child search rejects before content reads and login/phone scope remains current',
        async () => {
          const w = await h.world(),
            base = await w.envelope({ text: 'needle parent' });
          const [post] = await w.seed(1, () => base, { time: () => old });
          const child = await childEnvelope(
            h,
            w,
            post!.id,
            null,
            w.author,
            'needle child',
          );
          await seedChildren(h, 'comment', 130, () => child, { time: at });
          const guest = await nativeSearch(h, null);
          const intent = {
            spaceId: w.scope.home.spaceId,
            q: 'needle',
            type: 'all',
          };
          const page = (await guest.gateway.search(
            intent,
            null,
            guest.cancel,
          )) as SearchPage;
          assert.deepEqual(page.effectiveTypes, ['post']);
          assert.deepEqual(hitKeys(page), [`post:${post!.id}`]);
          let readBodies = false;
          h.observer.setHook(async (event) => {
            if (
              /SELECT \* FROM whaleu_community\.(posts|root_comments|replies)/.test(
                event.sql,
              )
            )
              readBodies = true;
          });
          try {
            for (const type of ['comment', 'reply']) {
              failure(
                await w.search({ type }, null),
                401,
                'AUTHENTICATION_REQUIRED',
              );
              await assert.rejects(
                guest.gateway.search({ ...intent, type }, null, guest.cancel),
              );
            }
            assert.equal(readBodies, false, 'No guest child body examination');
          } finally {
            h.observer.setHook(null);
          }
          const first = await w.search({ type: 'comment', limit: '1' });
          ok(first);
          assert.ok(first.body.nextCursor);
          await setRuntimeVerification(
            h.pool,
            w.reader.accountId,
            w.scope.institutionId,
            w.scope.home.regionId,
            'verified',
            'unverified',
          );
          failure(
            await w.search({
              type: 'comment',
              limit: '1',
              cursor: first.body.nextCursor,
            }),
            403,
            'PHONE_VERIFICATION_REQUIRED',
          );
          await setRuntimeVerification(
            h.pool,
            w.reader.accountId,
            w.scope.institutionId,
            w.scope.home.regionId,
          );
          await h.pool.query(
            "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=$1",
            [w.reader.sessionId],
          );
          failure(await w.search({ type: 'comment' }), 401);
        },
      );

      await t.test(
        'equivalent visible worlds keep child pages, snippets, positions and termination independent of held/revoked/blocked/hidden bodies',
        async () => {
          for (const mode of [
            'held',
            'revoked',
            'blocked',
            'hidden',
            'deleted',
          ] as const) {
            const outcomes: unknown[][] = [];
            for (const privateMatches of [false, true]) {
              const w = await h.world(),
                privateAuthor = await w.actor();
              const base = await w.envelope({ text: 'same plain parent' });
              const [post] = await w.seed(1, () => base, { time: () => old });
              const rootBase = await childEnvelope(h, w, post!.id);
              const [anchor] = await seedChildren(
                h,
                'comment',
                1,
                () => rootBase,
                { time: () => old },
              );
              const visibleRoot = await childEnvelope(
                h,
                w,
                post!.id,
                null,
                w.author,
                'needle public root',
              );
              const visibleReply = await childEnvelope(
                h,
                w,
                post!.id,
                anchor!.id,
                w.author,
                'needle public reply',
              );
              const secretText = privateMatches
                ? 'needle '.repeat(30)
                : 'private unrelated body';
              const hiddenRoot = await childEnvelope(
                h,
                w,
                post!.id,
                null,
                privateAuthor,
                secretText,
              );
              const hiddenReply = await childEnvelope(
                h,
                w,
                post!.id,
                anchor!.id,
                privateAuthor,
                secretText,
              );
              const prefix = randomUUID().slice(0, 24);
              const roots = await seedChildren(
                h,
                'comment',
                65,
                (i) => (i === 0 ? visibleRoot : hiddenRoot),
                {
                  time: (i) => at(2 * i),
                  id: (i) =>
                    prefix + (5000 - 2 * i).toString(16).padStart(12, '0'),
                  state: (i) =>
                    i !== 0 && (mode === 'held' || mode === 'revoked')
                      ? mode
                      : 'allow',
                },
              );
              const replies = await seedChildren(
                h,
                'reply',
                65,
                (i) => (i === 64 ? visibleReply : hiddenReply),
                {
                  time: (i) => at(2 * i + 1),
                  id: (i) =>
                    prefix + (4999 - 2 * i).toString(16).padStart(12, '0'),
                  state: (i) =>
                    i !== 64 && (mode === 'held' || mode === 'revoked')
                      ? mode
                      : 'allow',
                },
              );
              if (mode === 'blocked')
                await h.writeBlock(w.reader, privateAuthor);
              if (mode === 'hidden' || mode === 'deleted')
                await h.mutate(async (tx) => {
                  for (const [table, ids] of [
                    ['root_comments', roots.slice(1).map((row) => row.id)],
                    ['replies', replies.slice(0, -1).map((row) => row.id)],
                  ] as const)
                    await tx.query(
                      `UPDATE whaleu_community.${table} SET ${mode === 'hidden' ? "visibility='hidden'" : 'deleted_at=clock_timestamp()'} WHERE id=ANY($1::uuid[])`,
                      [ids],
                    );
                });
              const replacements = new Map<string, string>([
                [post!.id, 'parent'],
                [anchor!.id, 'thread-root'],
                [w.scope.home.spaceId, 'space'],
                [w.author.profileId, 'public-author'],
                ...roots.map(
                  (row, i) => [row.id, `root:${i}`] as [string, string],
                ),
                ...replies.map(
                  (row, i) => [row.id, `reply:${i}`] as [string, string],
                ),
              ]);
              const normalize = (value: unknown) =>
                JSON.parse(
                  [...replacements].reduce(
                    (json, [from, to]) => json.replaceAll(from, to),
                    JSON.stringify(value),
                  ),
                ) as unknown;
              const pages: unknown[] = [];
              let cursor: string | undefined;
              do {
                const response = await w.search({
                  type: 'all',
                  from: '2026-10-01T00:00:00Z',
                  ...(cursor ? { cursor } : {}),
                });
                ok(response);
                const position = response.body.nextCursor
                  ? await h.position(response.body.nextCursor)
                  : null;
                pages.push(
                  normalize({ ...response.body, nextCursor: position }),
                );
                if (
                  mode !== 'hidden' &&
                  mode !== 'deleted' &&
                  pages.length === 1
                ) {
                  assert.equal(response.body.continuation, 'scan_pending');
                  assert.deepEqual(position!.after, {
                    kind: 'reply',
                    id: replies[63]!.id,
                    at: at(127),
                  });
                  assert.deepEqual(hitKeys(response.body), [
                    `comment:${roots[0]!.id}`,
                  ]);
                }
                cursor = response.body.nextCursor ?? undefined;
                assert.ok(pages.length <= 2);
              } while (cursor);
              outcomes.push(pages);
            }
            assert.deepEqual(outcomes[0], outcomes[1], mode);
          }
        },
      );

      await t.test(
        'current parent/root direct and list policies keep anonymous exceptions scoped to each author',
        async () => {
          for (const mode of [
            'parent-hidden',
            'parent-deleted',
            'parent-held',
            'parent-revoked',
            'parent-incoming',
            'root-hidden',
            'root-deleted',
            'root-held',
            'root-revoked',
            'root-outgoing',
            'root-incoming',
            'reply-outgoing',
            'reply-incoming',
          ] as const) {
            const w = await h.world(),
              rootAuthor = await w.actor(),
              replyAuthor = await w.actor();
            const base = await w.envelope({ text: 'needle parent' });
            const [post] = await w.seed(1, () => base, { time: () => old });
            const rootBase = await childEnvelope(
              h,
              w,
              post!.id,
              null,
              rootAuthor,
              'needle root',
            );
            const [root] = await seedChildren(h, 'comment', 1, () => rootBase, {
              time: () => at(2),
            });
            const replyBase = await childEnvelope(
              h,
              w,
              post!.id,
              root!.id,
              replyAuthor,
              'needle reply',
            );
            const [reply] = await seedChildren(h, 'reply', 1, () => replyBase, {
              time: () => at(1),
            });
            const [node, rule] = mode.split('-');
            if (rule === 'hidden' || rule === 'deleted')
              await h.mutate((tx) =>
                tx.query(
                  `UPDATE whaleu_community.${node === 'parent' ? 'posts' : 'root_comments'} SET ${rule === 'hidden' ? "visibility='hidden'" : 'deleted_at=clock_timestamp()'} WHERE id=$1`,
                  [node === 'parent' ? post!.id : root!.id],
                ),
              );
            else if (rule === 'held' || rule === 'revoked')
              await setReviewState(
                h.pool,
                node === 'parent' ? post!.decision : root!.decision,
                rule,
              );
            else {
              const author =
                node === 'parent'
                  ? w.author
                  : node === 'root'
                    ? rootAuthor
                    : replyAuthor;
              await h.writeBlock(
                rule === 'incoming' ? author : w.reader,
                rule === 'incoming' ? w.reader : author,
              );
            }
            const result = await w.search({ type: 'all' });
            ok(result);
            const expected = mode.startsWith('parent-')
              ? mode === 'parent-incoming'
                ? [`post:${post!.id}`]
                : []
              : mode === 'root-incoming' || mode === 'reply-incoming'
                ? [
                    `reply:${reply!.id}`,
                    `comment:${root!.id}`,
                    `post:${post!.id}`,
                  ]
                : mode === 'reply-outgoing'
                  ? [`comment:${root!.id}`, `post:${post!.id}`]
                  : [`post:${post!.id}`];
            assert.deepEqual(hitKeys(result.body), expected, mode);
          }
          const w = await h.world(),
            namedChild = await w.actor();
          const base = await w.envelope({
            text: 'needle anonymous parent',
            authorMode: 'anonymous',
          });
          const [post] = await w.seed(1, () => base, { time: () => old });
          const anonymousRoot = await childEnvelope(
            h,
            w,
            post!.id,
            null,
            w.author,
            'needle anonymous root',
            'anonymous',
          );
          const [root] = await seedChildren(
            h,
            'comment',
            1,
            () => anonymousRoot,
            { time: () => at(2) },
          );
          const namedReply = await childEnvelope(
            h,
            w,
            post!.id,
            root!.id,
            namedChild,
            'needle named reply',
          );
          await seedChildren(h, 'reply', 1, () => namedReply, {
            time: () => at(1),
          });
          await h.writeBlock(w.reader, w.author);
          await h.writeBlock(w.author, w.reader);
          await h.writeBlock(w.reader, namedChild);
          const result = await w.search({ type: 'all' });
          ok(result);
          assert.deepEqual(hitKeys(result.body), [
            `comment:${root!.id}`,
            `post:${post!.id}`,
          ]);
          assert.equal(
            JSON.stringify(result.body).includes(namedChild.profileId),
            false,
          );
          for (const hit of result.body.items as SearchHit[])
            assert.equal(hit.author.kind, 'anonymous');
        },
      );

      await t.test(
        'unknown own or parent approval is unavailable for matching and nonmatching queries, never an empty result',
        async () => {
          for (const missing of ['post', 'comment', 'reply'] as const) {
            const w = await h.world(),
              base = await w.envelope({ text: 'plain parent' });
            const postId = randomUUID(),
              rootId = randomUUID(),
              replyId = randomUUID();
            if (missing === 'post')
              await h.mutate((tx) =>
                tx.query(
                  "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy,published_at) VALUES($1,$2,$3,'discussion','plain parent','named','open',$4)",
                  [postId, w.scope.home.spaceId, w.author.accountId, old],
                ),
              );
            else
              await w.seed(1, () => base, {
                time: () => old,
                id: () => postId,
              });
            const rootBase = await childEnvelope(
              h,
              w,
              postId,
              null,
              w.author,
              'needle root',
            );
            if (missing === 'comment')
              await h.mutate((tx) =>
                tx.query(
                  "INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode,created_at) VALUES($1,$2,$3,'needle root','named',$4)",
                  [rootId, postId, w.author.accountId, old],
                ),
              );
            else
              await seedChildren(h, 'comment', 1, () => rootBase, {
                time: () => old,
                id: () => rootId,
              });
            const replyBase = await childEnvelope(
              h,
              w,
              postId,
              rootId,
              w.author,
              'needle reply',
            );
            if (missing === 'reply')
              await h.mutate((tx) =>
                tx.query(
                  "INSERT INTO whaleu_community.replies(id,post_id,root_comment_id,account_id,text,author_mode,created_at) VALUES($1,$2,$3,$4,'needle reply','named',$5)",
                  [replyId, postId, rootId, w.author.accountId, at(1)],
                ),
              );
            else
              await seedChildren(h, 'reply', 1, () => replyBase, {
                time: () => at(1),
                id: () => replyId,
              });
            for (const q of ['needle', 'unmatched'])
              failure(
                await w.search({ type: 'reply', q }),
                503,
                'COMMUNITY_UNAVAILABLE',
              );
          }
        },
      );

      await t.test(
        'hidden reply targets contribute neither body, author nor target relation to a visible reply hit',
        async () => {
          const w = await h.world(),
            targetAuthor = await w.actor(),
            base = await w.envelope({ text: 'plain parent' });
          const [post] = await w.seed(1, () => base, { time: () => old });
          const rootBase = await childEnvelope(h, w, post!.id);
          const [root] = await seedChildren(h, 'comment', 1, () => rootBase, {
            time: () => old,
          });
          const targetBase = await childEnvelope(
            h,
            w,
            post!.id,
            root!.id,
            targetAuthor,
            'needle private target',
          );
          const [target] = await seedChildren(h, 'reply', 1, () => targetBase, {
            time: () => old,
          });
          const child = await childEnvelope(
            h,
            w,
            post!.id,
            root!.id,
            w.author,
            'needle public reply',
            'named',
            target!.id,
          );
          const [reply] = await seedChildren(h, 'reply', 1, () => child, {
            time: () => at(0),
          });
          await h.mutate((tx) =>
            tx.query(
              "UPDATE whaleu_community.replies SET visibility='hidden' WHERE id=$1",
              [target!.id],
            ),
          );
          let targetBodyRead = false;
          h.observer.setHook(async (event) => {
            if (
              /SELECT \* FROM whaleu_community\.replies/.test(event.sql) &&
              event.values.includes(target!.id)
            )
              targetBodyRead = true;
          });
          try {
            const result = await w.search({
              type: 'reply',
              from: '2026-10-01T00:00:00Z',
            });
            ok(result);
            assert.deepEqual(hitKeys(result.body), [`reply:${reply!.id}`]);
            assert.equal(targetBodyRead, false);
            const serialized = JSON.stringify(result.body);
            for (const secret of [
              target!.id,
              targetAuthor.profileId,
              targetAuthor.accountId,
              targetBase.text,
              'targetReplyId',
            ])
              assert.equal(serialized.includes(secret), false, secret);
          } finally {
            h.observer.setHook(null);
          }
        },
      );

      await t.test(
        'child sentinel is metadata-only and final named-child proof rejects after successor insertion with rollback',
        async () => {
          const w = await h.world(),
            author = await w.actor(),
            base = await w.envelope({
              text: 'plain anonymous parent',
              authorMode: 'anonymous',
            });
          const [post] = await w.seed(1, () => base, { time: () => old });
          const rootBase = await childEnvelope(
            h,
            w,
            post!.id,
            null,
            w.author,
            'plain anonymous root',
            'anonymous',
          );
          const [root] = await seedChildren(h, 'comment', 1, () => rootBase, {
            time: () => old,
          });
          const child = await childEnvelope(
            h,
            w,
            post!.id,
            root!.id,
            author,
            'unrelated',
          );
          const rows = await seedChildren(h, 'reply', 128, () => child, {
            time: at,
          });
          const unread = randomUUID();
          await h.mutate((tx) =>
            tx.query(
              "INSERT INTO whaleu_community.replies(id,post_id,root_comment_id,account_id,text,author_mode,created_at) VALUES($1,$2,$3,$4,'needle unknown review','named',$5)",
              [unread, post!.id, root!.id, author.accountId, at(128)],
            ),
          );
          const first = await w.search({ type: 'reply' });
          ok(first);
          assert.deepEqual(first.body.items, []);
          assert.equal(first.body.continuation, 'scan_pending');
          assert.deepEqual((await h.position(first.body.nextCursor)).after, {
            kind: 'reply',
            id: rows[127]!.id,
            at: at(127),
          });
          failure(
            await w.search({ type: 'reply', cursor: first.body.nextCursor }),
            503,
            'COMMUNITY_UNAVAILABLE',
          );
          // A separate bounded source ensures the unknown sentinel is not part of the proof race.
          const visible = await childEnvelope(
            h,
            w,
            post!.id,
            root!.id,
            author,
            'needle named reply',
          );
          await seedChildren(h, 'reply', 3, () => visible, {
            time: (i) => `2026-10-02T00:00:00.00000${3 - i}Z`,
          });
          const count = async () =>
            (
              await h.pool.query<{ n: number }>(
                'SELECT count(*)::integer n FROM whaleu_community.discovery_cursors',
              )
            ).rows[0]!.n;
          const before = await count();
          let inserted = false,
            proof = false;
          h.observer.setHook(async (event) => {
            if (
              event.sql.includes(finalRows) &&
              (event.values[1] as string[]).includes(author.accountId)
            )
              proof = true;
            if (
              !inserted &&
              event.sql.includes(
                'INSERT INTO whaleu_community.discovery_cursors',
              )
            ) {
              inserted = true;
              await h.writeBlock(w.reader, author);
            }
          });
          try {
            failure(
              await w.search({
                type: 'reply',
                from: '2026-10-02T00:00:00Z',
                limit: '1',
              }),
              503,
              'COMMUNITY_UNAVAILABLE',
            );
            assert.equal(inserted, true);
            assert.equal(proof, true);
            assert.equal(await count(), before);
          } finally {
            h.observer.setHook(null);
          }
        },
      );

      await t.test(
        'lightweight projection does not enumerate a large thread, count discussion, resolve media or claim detail-limit removal',
        async () => {
          const w = await h.world(),
            base = await w.envelope({ text: 'needle compact result' });
          const [post] = await w.seed(1, () => base, { time: () => old });
          const rootBase = await childEnvelope(h, w, post!.id);
          await seedChildren(h, 'comment', 1030, () => rootBase, { time: at });
          const sql: string[] = [];
          h.observer.setHook(async (event) => {
            sql.push(event.sql);
          });
          try {
            const result = await w.search({ type: 'post' });
            ok(result);
            assert.deepEqual(hitKeys(result.body), [`post:${post!.id}`]);
            expectLightweight(result.body.items[0]);
          } finally {
            h.observer.setHook(null);
          }
          assert.equal(
            sql.some((query) =>
              /count_snapshot|discussion_optional_count|LIMIT\s+(?:257|1025)/i.test(
                query,
              ),
            ),
            false,
          );
          assert.equal(
            sql.some((query) => /FROM whaleu_media\./i.test(query)),
            false,
          );
          assert.equal(
            sql.some((query) =>
              /SELECT \* FROM whaleu_community\.(root_comments|replies)/i.test(
                query,
              ),
            ),
            false,
          );
          // Existing discussion-context/detail owners keep their own independent limits.
          // This check proves only the new search projection, never a detail-limit change.
        },
      );
      await t.test(
        'native federation preserves child source/category/urgent filters without parent-body matches',
        async () => {
          const w = await freshWorld(h),
            query = 'federated child needle';
          const definitions = [
            await w.envelope({
              text: 'plain normal trade',
              category: 'trading',
              trading,
            }),
            await w.envelope({
              text: 'plain urgent trade',
              category: 'trading',
              trading: { ...trading, urgency: 'urgent' },
            }),
            await w.envelope({
              text: 'plain global discussion',
              spaceId: w.scope.global.spaceId,
            }),
          ];
          const posts = await w.seed(3, (i) => definitions[i]!, {
            time: () => old,
          });
          const roots: Awaited<ReturnType<typeof seedChildren>> = [];
          for (let i = 0; i < posts.length; i++) {
            const base = await childEnvelope(
              h,
              w,
              posts[i]!.id,
              null,
              w.author,
              query,
            );
            roots.push(
              (
                await seedChildren(h, 'comment', 1, () => base, {
                  time: () => at(i),
                })
              )[0]!,
            );
          }
          const native = await nativeSearch(h, w.reader);
          for (const [selector, indexes] of [
            [{ scope: 'all' }, [0, 1, 2]],
            [{ scope: 'global' }, [2]],
            [
              {
                scope: 'regional',
                category: 'trading',
                tradingSubtype: 'shuma',
              },
              [0, 1],
            ],
            [{ spaceId: w.scope.home.spaceId }, [0]],
            [{ spaceId: w.scope.home.spaceId, category: 'trading' }, [0, 1]],
          ] as const) {
            const page = (await native.gateway.search(
              { ...selector, q: query, type: 'comment' },
              null,
              native.cancel,
            )) as SearchPage;
            assert.deepEqual(
              hitKeys(page),
              indexes.map((i) => `comment:${roots[i]!.id}`),
            );
            for (const hit of page.items) {
              const index = roots.findIndex((row) => row.id === hit.contentId);
              assert.equal(hit.space.id, definitions[index]!.spaceId);
              assert.equal(hit.category, definitions[index]!.category);
              assert.equal(hit.tradingSubtype, index === 2 ? null : 'shuma');
              assert.equal(
                hit.tradingUrgency,
                index === 2 ? null : index === 1 ? 'urgent' : 'normal',
              );
            }
          }
        },
      );

      await t.test(
        'same UUID on its own post/root/reply chain survives strict native search and context navigation',
        async () => {
          const w = await h.world(),
            sharedId = randomUUID(),
            base = await w.envelope({ text: 'needle same-chain parent' });
          await w.seed(1, () => base, {
            time: () => at(0),
            id: () => sharedId,
          });
          const rootBase = await childEnvelope(
            h,
            w,
            sharedId,
            null,
            w.author,
            'needle same-chain root',
          );
          await seedChildren(h, 'comment', 1, () => rootBase, {
            time: () => at(0),
            id: () => sharedId,
          });
          const replyBase = await childEnvelope(
            h,
            w,
            sharedId,
            sharedId,
            w.author,
            'needle same-chain reply',
          );
          await seedChildren(h, 'reply', 1, () => replyBase, {
            time: () => at(0),
            id: () => sharedId,
          });
          const native = await nativeSearch(h, w.reader);
          const page = (await native.gateway.search(
            { spaceId: w.scope.home.spaceId, q: 'needle', type: 'all' },
            null,
            native.cancel,
          )) as SearchPage;
          assert.deepEqual(hitKeys(page), [
            `post:${sharedId}`,
            `comment:${sharedId}`,
            `reply:${sharedId}`,
          ]);
          const hit = page.items[2]!;
          assert.equal(
            searchTargetPath(hit.target),
            `/pages/community-thread/community-thread?postId=${sharedId}&rootCommentId=${sharedId}&replyId=${sharedId}`,
          );
          const context = await native.api.request(
            {
              path: `/v1/community/posts/${sharedId}/discussion-context`,
              method: 'GET',
              authentication: 'required',
              authReplay: 'once',
              successStatus: 200,
              decode: decodeDiscussionContext,
            },
            { query: { replyId: sharedId } },
          );
          assert.equal(context.comment.id, sharedId);
          assert.equal(context.reply.id, sharedId);
          assert.equal(context.reply.rootCommentId, sharedId);
          assert.equal(context.reply.postId, sharedId);
          assert.equal(context.reply.target.kind, 'comment');
          assert.equal(context.reply.target.id, sharedId);
        },
      );

      await t.test(
        'reply review, phone and session deadlines are re-proved after successor insertion and roll it back',
        async () => {
          for (const deadline of ['review', 'phone', 'session'] as const) {
            const w = await h.world(),
              base = await w.envelope({ text: 'plain parent' });
            const [post] = await w.seed(1, () => base, { time: () => old });
            const rootBase = await childEnvelope(h, w, post!.id);
            const [root] = await seedChildren(h, 'comment', 1, () => rootBase, {
              time: () => old,
            });
            const replyBase = await childEnvelope(
              h,
              w,
              post!.id,
              root!.id,
              w.author,
              'needle deadline reply',
            );
            const expiresAt = new Date(Date.now() + 1800);
            await seedChildren(h, 'reply', 3, () => replyBase, {
              time: at,
              ...(deadline === 'review' ? { visibilityUntil: expiresAt } : {}),
            });
            if (deadline === 'phone')
              await setRuntimeVerification(
                h.pool,
                w.reader.accountId,
                w.scope.institutionId,
                w.scope.home.regionId,
                'verified',
                'verified',
                expiresAt,
              );
            if (deadline === 'session')
              await h.pool.query(
                'UPDATE whaleu_identity.access_tokens SET expires_at=$2 WHERE token_hash=$1',
                [hashToken(w.reader.accessToken), expiresAt],
              );
            const count = async () =>
              (
                await h.pool.query<{ n: number }>(
                  'SELECT count(*)::integer n FROM whaleu_community.discovery_cursors',
                )
              ).rows[0]!.n;
            const before = await count();
            let inserted = false,
              waited = false;
            h.observer.setHook(async (event) => {
              if (
                event.sql.includes(
                  'INSERT INTO whaleu_community.discovery_cursors',
                )
              )
                inserted = true;
              if (!waited && event.sql === 'SET CONSTRAINTS ALL IMMEDIATE') {
                assert.equal(inserted, true);
                waited = true;
                await sleep(Math.max(0, expiresAt.getTime() - Date.now()) + 75);
              }
            });
            try {
              failure(
                await w.search({ type: 'reply', limit: '1' }),
                deadline === 'review' ? 503 : deadline === 'phone' ? 403 : 401,
                deadline === 'review'
                  ? 'COMMUNITY_UNAVAILABLE'
                  : deadline === 'phone'
                    ? 'PHONE_VERIFICATION_REQUIRED'
                    : undefined,
              );
              assert.equal(waited, true);
              assert.equal(await count(), before);
            } finally {
              h.observer.setHook(null);
            }
          }
        },
      );

      await t.test(
        'actual child and within-topic UNION plans remain structural and query independent',
        async () => {
          const w = await freshWorld(h),
            base = await w.envelope({ text: 'plain parent' });
          const posts = await w.seed(2, () => base, { time: () => old });
          const roots: Awaited<ReturnType<typeof seedChildren>> = [];
          for (const post of posts) {
            const rootBase = await childEnvelope(h, w, post.id);
            roots.push(
              ...(await seedChildren(h, 'comment', 650, () => rootBase, {
                time: at,
              })),
            );
          }
          for (let i = 0; i < posts.length; i++) {
            const replyBase = await childEnvelope(
              h,
              w,
              posts[i]!.id,
              roots[i * 650]!.id,
            );
            await seedChildren(h, 'reply', 650, () => replyBase, { time: at });
          }
          for (const table of ['posts', 'root_comments', 'replies'])
            await h.pool.query(`ANALYZE whaleu_community.${table}`);
          for (const [label, query] of [
            ['all child sources', { type: 'all' }],
            ['root source', { type: 'comment' }],
            ['reply source', { type: 'reply' }],
            ['within-topic', { type: 'all', postId: posts[0]!.id }],
          ] as const) {
            // Prime this exact successor so both measured paths reuse it.
            // Comparing an insert with a reuse adds unrelated cursor SQL.
            ok(await w.aggregate({ ...query, q: 'needle-not-in-fixture' }));
            let candidate:
              { sql: string; values: unknown[]; rows: number } | undefined;
            let metadataStatements = 0,
              metadataIds = 0;
            h.observer.setHook(async (event) => {
              if (/FOR SHARE OF [pcr]$/.test(event.sql)) {
                metadataStatements++;
                assert.ok(Array.isArray(event.values[0]));
                metadataIds += (event.values[0] as string[]).length;
              }
              if (
                event.sql.includes('UNION ALL') &&
                /LIMIT\s+129/.test(event.sql)
              )
                candidate ??= event;
            });
            let measured;
            try {
              measured = await h.observer.measure(label, () =>
                w.aggregate({ ...query, q: 'needle-not-in-fixture' }),
              );
            } finally {
              h.observer.setHook(null);
            }
            ok(measured.value);
            assert.deepEqual(measured.value.body.items, []);
            assert.equal(measured.value.body.continuation, 'scan_pending');
            assert.ok(candidate);
            assert.equal(candidate.rows, 129);
            assert.equal(
              JSON.stringify(candidate.values).includes(
                'needle-not-in-fixture',
              ),
              false,
            );
            assert.equal(
              /\b(?:ILIKE|LIKE|SIMILAR|text|wechat|qq|phone)\b/i.test(
                candidate.sql.replaceAll('::text', ''),
              ),
              false,
            );
            assert.ok(metadataStatements >= 1 && metadataStatements <= 3);
            const scalar = await withScalarSearchLocks(
              h.app.get(SearchRepository),
              () =>
                h.observer.measure(
                  `${label}: scalar metadata baseline`,
                  async () =>
                    await w.aggregate({ ...query, q: 'needle-not-in-fixture' }),
                ),
            );
            ok(scalar.value);
            assert.deepEqual(
              { ...scalar.value.body, nextCursor: null },
              { ...measured.value.body, nextCursor: null },
            );
            assert.deepEqual(
              await position(h, scalar.value.body.nextCursor),
              await position(h, measured.value.body.nextCursor),
            );
            assert.equal(
              scalar.measurement.queries - measured.measurement.queries,
              metadataIds - metadataStatements,
              'Only metadata round trips change; canonical and final proofs remain identical',
            );
            const explain = await h.pool.query(
              `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${candidate.sql}`,
              candidate.values,
            );
            const plan = explain.rows[0]['QUERY PLAN'][0];
            t.diagnostic(
              JSON.stringify({
                label,
                sourceRows: { post: 2, comment: 1300, reply: 1300 },
                structuralRows: candidate.rows,
                endpointMs:
                  Math.round(measured.measurement.durationMs * 100) / 100,
                endpointQueries: measured.measurement.queries,
                scalarEndpointQueries: scalar.measurement.queries,
                scalarEndpointMs:
                  Math.round(scalar.measurement.durationMs * 100) / 100,
                metadataStatements,
                scalarMetadataStatements: metadataIds,
                savedStatements:
                  scalar.measurement.queries - measured.measurement.queries,
                planningMs: plan['Planning Time'],
                executionMs: plan['Execution Time'],
                plan: plan.Plan,
              }),
            );
          }
        },
      );
    } finally {
      await h.close();
    }
  },
);
