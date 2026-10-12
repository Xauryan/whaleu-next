import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  windowDiscussionFixture,
  discussionHistory,
  reviewWindowDiscussion,
  revokeWindowDiscussionReview,
} from '../support/window-discussion-fixture.js';
import { inTransaction } from '../../src/database/database.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { windowDiscussionIntentHash } from '../../src/ratings/windows/discussion/service.js';
const base = '/v1/ratings/windows';
function ok(r: { status: number; body: unknown }, status = 200) {
  assert.equal(r.status, status, JSON.stringify(r.body));
}
test(
  'W3 named roots, flat addressed replies, reversible CAS and exact local notices under ordinary AppModule',
  { timeout: 240000 },
  async (t) => {
    const f = await windowDiscussionFixture();
    t.after(() => f.close());
    const actor = await f.actor({ affiliation: 'unverified', identity: false }),
      other = await f.actor({ affiliation: 'unverified', identity: false }),
      third = await f.actor({ affiliation: 'unverified', identity: false }),
      http = f.app.getHttpServer(),
      w = f.add(),
      foreign = f.add(),
      unknown = f.add({ history: 'unknown' });
    let catalog = await f.accept([w, foreign, unknown]);
    const get = (path: string, a = actor) =>
      request(http)
        .get(base + path)
        .set('Authorization', 'Bearer ' + a.accessToken);
    const post = (path: string, body: object, a = actor) =>
      request(http)
        .post(base + path)
        .set('Authorization', 'Bearer ' + a.accessToken)
        .send(body);
    const notices = (a = actor) =>
      request(http)
        .get('/v1/me/window-discussion/notices')
        .set('Authorization', 'Bearer ' + a.accessToken);
    const publish = async (body: string, a = actor, window = w) => {
      const q = f.root(catalog, window, body);
      await reviewWindowDiscussion(f.pool, a.accountId, window.id, q);
      const r = await post(`/${window.id}/discussion`, q, a);
      ok(r);
      return { id: r.body.commentId as string, q, receipt: r.body };
    };
    const reply = async (
      root: string,
      body: string,
      a = other,
      target: string | null = null,
    ) => {
      const q = f.reply(catalog, w, body, target);
      await reviewWindowDiscussion(f.pool, a.accountId, w.id, q, root);
      const r = await post(`/${w.id}/discussion/${root}/replies`, q, a);
      ok(r);
      return { id: r.body.commentId as string, q, receipt: r.body };
    };
    let root: Awaited<ReturnType<typeof publish>>,
      first: Awaited<ReturnType<typeof reply>>,
      second: Awaited<ReturnType<typeof reply>>,
      like: ReturnType<typeof f.like>,
      revision: string,
      originalLike: unknown;
    await t.test(
      'catalog and W1 score history never imply known discussion or like coverage',
      async () => {
        ok(await request(http).get(`${base}/${w.id}/discussion`), 401);
        assert.equal(
          (await get(`/${w.id}/discussion`)).body.error.code,
          'WINDOW_DISCUSSION_HISTORY_UNAVAILABLE',
        );
        await discussionHistory(f.pool, w.id, 'population');
        ok(await get(`/${w.id}/discussion`), 503);
        await f.acceptDiscussion([w.id, foreign.id]);
        const r = await get(`/${w.id}/discussion`);
        ok(r);
        assert.deepEqual(r.body.items, []);
        assert.equal(r.body.totalCount, 0);
        assert.equal(r.body.creatorNotice, 'unavailable');
        ok(await get(`/${unknown.id}/discussion`), 503);
        await f.acceptDiscussion([unknown.id]);
        const separate = await get(`/${unknown.id}/discussion`);
        ok(separate);
        assert.equal(separate.body.totalCount, 0);
        assert.equal(
          (await get(`/${unknown.id}`)).body.window.summary.kind,
          'unavailable',
        );
        await publish(
          'discussion independent of unknown score history',
          actor,
          unknown,
        );
      },
    );
    await t.test(
      'phone-only no affiliation actors publish named roots and addressed flat replies with exact fanout',
      async () => {
        root = await publish('  根评论 🍱  ');
        first = await reply(root.id, 'direct');
        second = await reply(root.id, 'addressed', third, first.id);
        await publish('another root');
        const page = await get(`/${w.id}/discussion/${root.id}`);
        ok(page);
        assert.equal(page.body.totalCount, 2);
        assert.equal(page.body.root.replyCount, 2);
        assert.equal(page.body.root.body, '  根评论 🍱  ');
        assert.equal(page.body.root.author.mode, 'named');
        assert.equal(page.body.items[1].replyToReplyId, first.id);
        assert.deepEqual(
          page.body.items[1].addressedAuthor,
          page.body.items[0].author,
        );
        for (const item of [page.body.root, ...page.body.items]) {
          assert.equal('actorId' in item, false);
          assert.equal('accountId' in item.author, false);
          assert.equal('allowedActions' in item, false);
          assert.equal('images' in item, false);
          assert.equal('avatar' in item.author, false);
          assert.equal('ratingCount' in item, false);
        }
        const a = await notices(),
          b = await notices(other),
          c = await notices(third);
        ok(a);
        ok(b);
        ok(c);
        assert.equal(a.body.unreadCount, 2);
        assert.equal(b.body.unreadCount, 1);
        assert.equal(c.body.unreadCount, 0);
        await reply(root.id, 'self root addressed to other', actor, first.id);
        assert.equal((await notices()).body.unreadCount, 2);
        assert.equal((await notices(other)).body.unreadCount, 2);
        await reply(
          root.id,
          'target equals root author',
          other,
          (await reply(root.id, 'self reply', actor)).id,
        );
        assert.equal((await notices()).body.unreadCount, 3);
        const ni = a.body.items[0],
          target = await request(http)
            .get(`/v1/me/window-discussion/notices/${ni.noticeId}/target`)
            .set('Authorization', 'Bearer ' + actor.accessToken);
        ok(target);
        assert.equal(target.body.rootId, root.id);
        ok(
          await request(http)
            .get(`/v1/me/window-discussion/notices/${ni.noticeId}/target`)
            .set('Authorization', 'Bearer ' + third.accessToken),
          404,
        );
        const read = () =>
          request(http)
            .put(`/v1/me/window-discussion/notices/${ni.noticeId}/read`)
            .set('Authorization', 'Bearer ' + actor.accessToken)
            .send({});
        const read1 = await read();
        ok(read1);
        assert.deepEqual((await read()).body, read1.body);
      },
    );
    await t.test(
      'root/reply likes reverse, re-like notices per transition, CAS precedes noop, replay cannot resurrect',
      async () => {
        const before = (await notices()).body.unreadCount;
        like = f.like(catalog, w);
        let r = await post(`/${w.id}/discussion/${root.id}/like`, like, other);
        ok(r);
        assert.equal(r.body.outcome, 'applied');
        revision = r.body.membershipRevision;
        originalLike = r.body;
        assert.equal((await notices()).body.unreadCount, before + 1);
        assert.deepEqual(
          (await post(`/${w.id}/discussion/${root.id}/like`, like, other)).body,
          originalLike,
        );
        r = await post(
          `/${w.id}/discussion/${root.id}/like`,
          f.like(catalog, w, true, revision),
          other,
        );
        ok(r);
        assert.equal(r.body.outcome, 'noop');
        assert.equal((await notices()).body.unreadCount, before + 1);
        r = await post(
          `/${w.id}/discussion/${root.id}/like`,
          f.like(catalog, w, true, null),
          other,
        );
        ok(r);
        assert.equal(r.body.code, 'WINDOW_DISCUSSION_MEMBERSHIP_CONFLICT');
        const removal = f.like(catalog, w, false, revision);
        r = await post(`/${w.id}/discussion/${root.id}/like`, removal, other);
        ok(r);
        revision = r.body.membershipRevision;
        assert.equal(r.body.active, false);
        assert.equal((await notices()).body.unreadCount, before + 1);
        assert.deepEqual(
          (await post(`/${w.id}/discussion/${root.id}/like`, like, other)).body,
          originalLike,
        );
        assert.equal(
          (await get(`/${w.id}/discussion/${root.id}/my-like`, other)).body
            .active,
          false,
        );
        r = await post(
          `/${w.id}/discussion/${root.id}/like`,
          f.like(catalog, w, true, revision),
          other,
        );
        ok(r);
        revision = r.body.membershipRevision;
        assert.equal((await notices()).body.unreadCount, before + 2);
        assert.equal(
          (await post(`/${w.id}/discussion/${root.id}/like`, removal, other))
            .body.active,
          false,
        );
        assert.equal(
          (await get(`/${w.id}/discussion/${root.id}/my-like`, other)).body
            .active,
          true,
        );
        const selfBefore = (await notices()).body.unreadCount;
        r = await post(
          `/${w.id}/discussion/${root.id}/like`,
          f.like(catalog, w),
          actor,
        );
        ok(r);
        assert.equal((await notices()).body.unreadCount, selfBefore);
        r = await post(
          `/${w.id}/discussion/${first.id}/like`,
          f.like(catalog, w),
          third,
        );
        ok(r);
        assert.equal(
          (await get(`/${w.id}/discussion/${root.id}`)).body.items.find(
            (i: { id: string }) => i.id === first.id,
          ).likes,
          1,
        );
        const replyNoticeCount = (await notices(other)).body.unreadCount;
        const replyRemoval = f.like(
          catalog,
          w,
          false,
          r.body.membershipRevision,
        );
        const removedReply = await post(
          `/${w.id}/discussion/${first.id}/like`,
          replyRemoval,
          third,
        );
        ok(removedReply);
        assert.equal(removedReply.body.active, false);
        assert.equal((await notices(other)).body.unreadCount, replyNoticeCount);
        const relikedReply = await post(
          `/${w.id}/discussion/${first.id}/like`,
          f.like(catalog, w, true, removedReply.body.membershipRevision),
          third,
        );
        ok(relikedReply);
        assert.equal(
          (await notices(other)).body.unreadCount,
          replyNoticeCount + 1,
        );
        assert.equal(
          (
            await post(
              `/${w.id}/discussion/${first.id}/like`,
              replyRemoval,
              third,
            )
          ).body.active,
          false,
        );
        assert.equal(
          (await get(`/${w.id}/discussion/${first.id}/my-like`, third)).body
            .active,
          true,
        );
        const threadFirst = await get(`/${w.id}/discussion/${root.id}?limit=1`);
        ok(threadFirst);
        const replies = [...threadFirst.body.items];
        let replyCursor = threadFirst.body.nextCursor as string | null;
        while (replyCursor) {
          const next = await get(
            `/${w.id}/discussion/${root.id}?limit=1&cursor=${encodeURIComponent(replyCursor)}`,
          );
          ok(next);
          replies.push(...next.body.items);
          replyCursor = next.body.nextCursor;
        }
        assert.equal(replies.length, threadFirst.body.totalCount);
        assert.equal(new Set(replies.map((r) => r.id)).size, replies.length);
        assert.deepEqual(
          replies,
          [...replies].sort(
            (a, b) =>
              a.createdAt.localeCompare(b.createdAt) ||
              a.id.localeCompare(b.id),
          ),
        );
        const page = await get(`/${w.id}/discussion`);
        ok(page);
        assert.equal(page.body.items[0].id, root.id);
        assert.equal(page.body.items[0].likes, 2);
        ok(
          await post(
            `/${w.id}/discussion/${root.id}/like`,
            { ...like, active: false },
            other,
          ),
          409,
        );
      },
    );
    await t.test(
      'strict HTTP rejects images, spoofed actor/recipient, nesting, foreign root and foreign target',
      async () => {
        for (const value of [
          '',
          ' ',
          '\ufeff',
          '\u0000',
          '\ud800',
          '🍱'.repeat(2001),
        ])
          ok(await post(`/${w.id}/discussion`, f.root(catalog, w, value)), 400);
        for (const extra of [
          { images: [] },
          { actorId: other.accountId },
          { anonymous: true },
          { replyToUserId: other.accountId },
          { parentId: root.id },
        ])
          ok(
            await post(`/${w.id}/discussion`, {
              ...f.root(catalog, w),
              ...extra,
            }),
            400,
          );
        const fr = await publish('foreign', actor, foreign);
        for (const [rootId, target] of [
          [first.id, null],
          [fr.id, null],
          [root.id, fr.id],
          [root.id, root.id],
          [root.id, randomUUID()],
        ] as const) {
          const q = f.reply(catalog, w, 'invalid target', target);
          ok(await post(`/${w.id}/discussion/${rootId}/replies`, q), 404);
          ok(await get(`/discussion-requests/${q.clientRequestId}`), 404);
        }
        ok(
          await post(
            `/${foreign.id}/discussion/${root.id}/like`,
            f.like(catalog, foreign),
          ),
          404,
        );
        ok(await get(`/${foreign.id}/discussion/${root.id}`), 404);
        ok(await get(`/${w.id}/discussion?limit=51`), 400);
        ok(await get(`/${w.id}/discussion?sort=unknown`), 400);
        ok(await get(`/${w.id}/discussion/${root.id}?sort=likes`), 400);
        const q = f.root(catalog, w, '0');
        await reviewWindowDiscussion(f.pool, actor.accountId, w.id, q);
        ok(await post(`/${w.id}/discussion`, q));
      },
    );
    await t.test(
      'exact Review body/original-key/root/target; unavailable never creates terminal result',
      async () => {
        const q = f.root(catalog, w, 'review body');
        ok(await post(`/${w.id}/discussion`, q), 503);
        ok(await get(`/discussion-requests/${q.clientRequestId}`), 404);
        await reviewWindowDiscussion(f.pool, actor.accountId, w.id, q);
        ok(await post(`/${w.id}/discussion`, { ...q, body: 'changed' }), 503);
        ok(await get(`/discussion-requests/${q.clientRequestId}`), 404);
        const reject = f.root(catalog, w, 'reject');
        await reviewWindowDiscussion(
          f.pool,
          actor.accountId,
          w.id,
          reject,
          null,
          'reject',
        );
        const rejected = await post(`/${w.id}/discussion`, reject);
        ok(rejected);
        assert.equal(rejected.body.code, 'CONTENT_REJECTED');
        const replyQ = f.reply(catalog, w, 'bound reply', first.id);
        await reviewWindowDiscussion(
          f.pool,
          actor.accountId,
          w.id,
          replyQ,
          root.id,
        );
        ok(
          await post(`/${w.id}/discussion/${root.id}/replies`, {
            ...replyQ,
            replyToReplyId: null,
          }),
          503,
        );
        const wrongActor = f.root(catalog, w, 'actor binding');
        await reviewWindowDiscussion(f.pool, other.accountId, w.id, wrongActor);
        ok(await post(`/${w.id}/discussion`, wrongActor), 503);
        const wrongKey = f.root(catalog, w, 'key binding');
        await reviewWindowDiscussion(f.pool, actor.accountId, w.id, wrongKey);
        ok(
          await post(`/${w.id}/discussion`, {
            ...wrongKey,
            clientRequestId: randomUUID(),
          }),
          503,
        );
      },
    );
    await t.test(
      'same-key cancel is a durable fence, exact replay owner-only, independent history withdrawal and unlike closure',
      async () => {
        const q = f.root(catalog, w, 'cancel me'),
          cancel = {
            windowId: w.id,
            operation: 'window.discussion.root.v1',
            command: q,
          };
        let r = await post(
          `/discussion-requests/${q.clientRequestId}/cancel`,
          cancel,
        );
        ok(r);
        assert.equal(r.body.code, 'WINDOW_DISCUSSION_CANCELLED');
        await reviewWindowDiscussion(f.pool, actor.accountId, w.id, q);
        assert.deepEqual((await post(`/${w.id}/discussion`, q)).body, r.body);
        ok(
          await post(`/discussion-requests/${q.clientRequestId}/cancel`, {
            ...cancel,
            command: { ...q, body: 'changed' },
          }),
          409,
        );
        ok(
          await get(`/discussion-requests/${root.q.clientRequestId}`, other),
          404,
        );
        await discussionHistory(f.pool, w.id, 'likes', 'unknown');
        ok(await get(`/${w.id}/discussion`), 503);
        assert.equal(
          (await get(`/${w.id}/discussion/${root.id}/my-like`, other)).body
            .kind,
          'recorded',
        );
        assert.equal(
          (await get(`/${w.id}/discussion/${second.id}/my-like`, actor)).body
            .kind,
          'unavailable',
        );
        await f.pool.query(
          "UPDATE whaleu_ratings.window_catalog_head SET state='withdrawn'",
        );
        await f.certify(other.accountId, {
          phone: 'unverified',
          affiliation: 'unverified',
          identity: false,
        });
        await f.pool.query(
          'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=$1',
          [other.accountId],
        );
        r = await post(
          `/${w.id}/discussion/${root.id}/like`,
          f.like(catalog, w, false, revision),
          other,
        );
        ok(r);
        assert.equal(r.body.active, false);
        revision = r.body.membershipRevision;
        assert.deepEqual(
          (await get(`/discussion-requests/${like.clientRequestId}`, other))
            .body,
          originalLike,
        );
        assert.equal(
          (await get(`/${w.id}/discussion/${root.id}/my-like`, other)).body
            .active,
          false,
        );
        ok(
          await post(
            `/${w.id}/discussion/${root.id}/like`,
            f.like(catalog, w, true, revision),
            other,
          ),
          403,
        );
        const cancelLike = f.like(catalog, w, true, revision);
        r = await post(
          `/discussion-requests/${cancelLike.clientRequestId}/cancel`,
          {
            operation: 'window.discussion.like.v1',
            windowId: w.id,
            commentId: root.id,
            command: cancelLike,
          },
          other,
        );
        ok(r);
        assert.equal(r.body.code, 'WINDOW_DISCUSSION_CANCELLED');
        await f.certify(other.accountId, {
          affiliation: 'unverified',
          identity: false,
        });
        await f.pool.query(
          'UPDATE whaleu_safety.account_heads SET actions_allowed=true WHERE account_id=$1',
          [other.accountId],
        );
        catalog = await f.accept([w, foreign, unknown]);
        await f.acceptDiscussion([w.id]);
        const current = await get(`/${w.id}/discussion`);
        ok(current);
        assert.equal(
          current.body.items.find((i: { id: string }) => i.id === root.id)
            .likes,
          1,
        );
        assert.equal(current.body.totalCount > 0, true);
      },
    );
    await t.test(
      'source replacement preserves roots and memberships; inactive topology and revoked root close reads/replies/notices',
      async () => {
        for (const patch of [
          { active: false },
          { floorActive: false },
          { parentActive: false },
        ]) {
          await f.accept([{ ...w, ...patch }, foreign, unknown]);
          ok(await get(`/${w.id}/discussion`), 404);
        }
        catalog = await f.accept([w, foreign, unknown]);
        const decision = (
          await f.pool.query<{ review_decision_id: string }>(
            'SELECT review_decision_id FROM whaleu_ratings.window_discussion_comments WHERE id=$1',
            [root.id],
          )
        ).rows[0]!.review_decision_id;
        await revokeWindowDiscussionReview(f.pool, decision);
        const page = await get(`/${w.id}/discussion`);
        ok(page);
        assert.equal(
          page.body.items.some((r: { id: string }) => r.id === root.id),
          false,
        );
        ok(await get(`/${w.id}/discussion/${root.id}`), 404);
        const q = f.reply(catalog, w, 'root withdrawn');
        ok(await post(`/${w.id}/discussion/${root.id}/replies`, q), 404);
        const n = await notices();
        ok(n);
        assert.equal(
          n.body.items.some(
            (item: { status: string }) => item.status === 'unavailable',
          ),
          true,
        );
        await f.pool.query(
          "UPDATE whaleu_community.window_discussion_review_heads SET state='active' WHERE decision_id=$1",
          [decision],
        );
      },
    );
    await t.test(
      'withdrawn explicit reply target is unavailable, its addressed identity is tombstoned and notice reads do not restore access',
      async () => {
        const before = await notices();
        ok(before);
        const notice = before.body.items.find(
          (i: { status: string; target?: { commentId: string } }) =>
            i.status === 'available' && i.target?.commentId === first.id,
        );
        assert.ok(notice);
        await f.pool.query(
          "UPDATE whaleu_community.window_discussion_review_heads SET state='revoked' WHERE request_id=$1",
          [first.q.clientRequestId],
        );
        try {
          const thread = await get(`/${w.id}/discussion/${root.id}`);
          ok(thread);
          assert.equal(
            thread.body.items.some((i: { id: string }) => i.id === first.id),
            false,
          );
          const addressed = thread.body.items.find(
            (i: { id: string }) => i.id === second.id,
          );
          assert.ok(addressed);
          assert.equal(addressed.body, 'addressed');
          assert.equal(addressed.replyToReplyId, null);
          assert.equal(addressed.addressedAuthor, null);
          ok(
            await post(
              `/${w.id}/discussion/${root.id}/replies`,
              f.reply(catalog, w, 'hidden addressed target', first.id),
              third,
            ),
            404,
          );
          ok(
            await post(
              `/${w.id}/discussion/${first.id}/like`,
              f.like(catalog, w),
              actor,
            ),
            404,
          );
          ok(
            await request(http)
              .put(`/v1/me/window-discussion/notices/${notice.noticeId}/read`)
              .set('Authorization', 'Bearer ' + actor.accessToken)
              .send({}),
          );
          ok(
            await request(http)
              .get(`/v1/me/window-discussion/notices/${notice.noticeId}/target`)
              .set('Authorization', 'Bearer ' + actor.accessToken),
            404,
          );
          const after = await notices();
          ok(after);
          assert.equal(
            after.body.items.find(
              (i: { noticeId: string }) => i.noticeId === notice.noticeId,
            ).status,
            'unavailable',
          );
        } finally {
          await f.pool.query(
            "UPDATE whaleu_community.window_discussion_review_heads SET state='active' WHERE request_id=$1",
            [first.q.clientRequestId],
          );
        }
      },
    );
    await t.test(
      'named block directions suppress roots and descendants; unknown author coverage never means empty',
      async () => {
        for (const [blocker, blocked] of [
          [other, actor],
          [actor, other],
        ]) {
          const profile = (
            await f.pool.query<{ public_id: string }>(
              'SELECT public_id FROM whaleu_profile.profiles WHERE account_id=$1',
              [blocked!.accountId],
            )
          ).rows[0]!.public_id;
          const bid = randomUUID();
          await withCommunityScopeWriter(f.pool, async (tx) => {
            await tx.query(
              "INSERT INTO whaleu_safety.blocks(id,blocker_id,blocked_id,active,revision,display_snapshot,source_kind,source_id) VALUES($1,$2,$3,true,1,'Synthetic W3 named block','profile',$4)",
              [bid, blocker!.accountId, blocked!.accountId, profile],
            );
            await tx.query(
              "INSERT INTO whaleu_safety.events(id,account_id,relationship_id,kind,revision) VALUES($1,$2,$3,'blocked',1)",
              [randomUUID(), blocker!.accountId, bid],
            );
          });
          try {
            const hidden = await get(`/${w.id}/discussion`, other);
            ok(hidden);
            assert.equal(
              hidden.body.items.some((r: { id: string }) => r.id === root.id),
              false,
            );
            ok(await get(`/${w.id}/discussion/${root.id}`, other), 404);
            const q = f.reply(catalog, w, 'blocked');
            ok(
              await post(`/${w.id}/discussion/${root.id}/replies`, q, other),
              404,
            );
          } finally {
            await withCommunityScopeWriter(f.pool, async (tx) => {
              await tx.query(
                'UPDATE whaleu_safety.blocks SET active=false,revision=revision+1 WHERE id=$1',
                [bid],
              );
              await tx.query(
                "INSERT INTO whaleu_safety.events(id,account_id,relationship_id,kind,revision) VALUES($1,$2,$3,'unblocked',2)",
                [randomUUID(), blocker!.accountId, bid],
              );
            });
          }
        }
        await f.pool.query(
          "UPDATE whaleu_safety.account_heads SET block_coverage='missing' WHERE account_id=$1",
          [other.accountId],
        );
        try {
          ok(await get(`/${w.id}/discussion`), 503);
        } finally {
          await f.pool.query(
            "UPDATE whaleu_safety.account_heads SET block_coverage='complete' WHERE account_id=$1",
            [other.accountId],
          );
        }
        ok(await get(`/${w.id}/discussion`));
      },
    );
    await t.test(
      'expired source yields private unavailable notice shells and does not veto session-only own absence',
      async () => {
        await f.accept([w, foreign, unknown], {
          validUntil: new Date(Date.now() + 900),
        });
        await new Promise((resolve) => setTimeout(resolve, 950));
        const n = await notices();
        ok(n);
        assert.ok(n.body.items.length > 0);
        assert.ok(
          n.body.items.every(
            (item: { status: string }) => item.status === 'unavailable',
          ),
        );
        const absent = await get(
          `/${w.id}/discussion/${second.id}/my-like`,
          actor,
        );
        ok(absent);
        assert.deepEqual(absent.body, { kind: 'not_liked' });
        await f.certify(actor.accountId, {
          phone: 'unverified',
          affiliation: 'unverified',
          identity: false,
        });
        await f.pool.query(
          "UPDATE whaleu_safety.account_heads SET actions_allowed=false,valid_until=clock_timestamp()-interval '1 second' WHERE account_id=$1",
          [actor.accountId],
        );
        const stillAbsent = await get(
          `/${w.id}/discussion/${second.id}/my-like`,
          actor,
        );
        ok(stillAbsent);
        assert.deepEqual(stillAbsent.body, { kind: 'not_liked' });
        await f.certify(actor.accountId, {
          affiliation: 'unverified',
          identity: false,
        });
        await f.pool.query(
          'UPDATE whaleu_safety.account_heads SET actions_allowed=true,valid_until=NULL WHERE account_id=$1',
          [actor.accountId],
        );
        catalog = await f.accept([w, foreign, unknown]);
      },
    );
    await t.test(
      'no generic rewards, media or W1 score population side effects; old SQL records immutable',
      async () => {
        assert.equal(
          (await get(`/${w.id}`)).body.window.summary.ratingCount,
          0,
        );
        for (const table of [
          'window_discussion_comments',
          'window_discussion_commands',
          'window_discussion_like_events',
        ])
          await assert.rejects(
            f.pool.query(
              `UPDATE whaleu_ratings.${table} SET actor_id=actor_id`,
            ),
            /immutable/,
          );
        await assert.rejects(
          f.pool.query(
            'DELETE FROM whaleu_notifications.window_discussion_notices',
          ),
          /immutable/,
        );
        await assert.rejects(
          f.pool.query(
            'DELETE FROM whaleu_ratings.window_discussion_like_heads',
          ),
          /immutable/,
        );
        const q = f.like(catalog, w, false, revision),
          operation = 'window.discussion.like.v1' as const,
          receipt = {
            requestId: q.clientRequestId,
            operation,
            windowId: w.id,
            commentId: root.id,
            outcome: 'rejected',
            code: 'WINDOW_DISCUSSION_MEMBERSHIP_CONFLICT',
          };
        await assert.rejects(
          inTransaction(f.pool, (tx) =>
            tx.query(
              'INSERT INTO whaleu_ratings.window_discussion_commands(actor_id,request_id,session_id,window_id,subject_id,operation,command,intent_hash,receipt) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
              [
                other.accountId,
                q.clientRequestId,
                other.sessionId,
                w.id,
                root.id,
                operation,
                q,
                windowDiscussionIntentHash(
                  other.accountId,
                  w.id,
                  root.id,
                  operation,
                  q,
                ),
                receipt,
              ],
            ),
          ),
          /causal/,
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_ratings.window_discussion_commands WHERE request_id=$1',
              [q.clientRequestId],
            )
          ).rowCount,
          0,
        );
      },
    );
  },
);
