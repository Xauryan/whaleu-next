import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';
import { ratingSubscriptionUpdatesFixture } from '../support/rating-subscription-updates-fixture.js';
import { setRatingReviewState } from '../support/rating-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import {
  ratingSubscriptionUpdatesPageSchema,
  ratingSubscriptionNoticeReadSchema,
} from '../../src/notifications/ratings/subscription-contracts.js';
test('subscription HTTP: current anonymous root/reply, owner-only locator, unavailable privacy and monotonic read', async (t) => {
  const f = await ratingSubscriptionUpdatesFixture();
  t.after(() => f.close());
  const a = await f.actor(),
    r = await f.actor(),
    outsider = await f.actor(),
    c = await f.catalog(a),
    target = c.targets[0]!;
  await f.subscribe(r, c, target);
  const root = await f.publish(
    a,
    c,
    target,
    f.body(c, target, { authorMode: 'anonymous' }),
  );
  const reply = await f.publishReply(
    a,
    c,
    target,
    root,
    f.replyBody(c, target, root, { authorMode: 'anonymous' }),
  );
  const events = [
    await f.event(a, root.input.clientRequestId),
    await f.event(a, reply.input.clientRequestId),
  ];
  const result = await f.worker().run({ mode: 'apply', eventIds: events });
  assert.equal(result.materialized, 2);
  assert.equal(result.processed, 2);
  assert.equal(result.failed, 0, JSON.stringify(result));
  const response = await f.get(r),
    page = ratingSubscriptionUpdatesPageSchema.parse(response.body);
  assert.equal(response.status, 200);
  assert.equal(page.unreadCount, 2);
  assert.equal(page.items.length, 2);
  for (const n of page.items) {
    assert.equal(n.status, 'available');
    if (n.status !== 'available') throw Error('Expected current available');
    assert.equal(n.preview.author.mode, 'anonymous');
    assert.equal('accountId' in n.preview.author, false);
    assert.equal(JSON.stringify(n).includes(a.accountId), false);
    assert.equal(n.target.targetId, target.id);
  }
  const rootNotice = page.items.find(
      (n) => n.status === 'available' && n.activity === 'root',
    )!,
    replyNotice = page.items.find(
      (n) => n.status === 'available' && n.activity === 'reply',
    )!;
  const rootTarget = await f.get(r, `/${rootNotice.noticeId}/target`),
    replyTarget = await f.get(r, `/${replyNotice.noticeId}/target`);
  assert.equal(rootTarget.body.target.replyId, null);
  assert.equal(replyTarget.body.target.replyId, reply.id);
  assert.equal((await f.get(r, '/unread-count')).body.unreadCount, 2);
  for (const id of [rootNotice.noticeId, replyNotice.noticeId]) {
    assert.equal((await f.get(outsider, `/${id}/target`)).status, 404);
    assert.equal((await f.read(outsider, id)).status, 404);
    assert.equal(
      (
        await f.auth(
          request(f.http).get(`/v1/me/ratings/updates/${id}/target`),
          r,
        )
      ).status,
      404,
    );
  }
  // Stored notices retain no preview or hidden author, and survive unsubscribing.
  await f.subscribe(r, c, target, false);
  assert.equal(
    (await f.get(r)).body.items.every(
      (n: { status: string }) => n.status === 'available',
    ),
    true,
  );
  const cursorPage = await f.get(r).query({ limit: 1 });
  assert.ok(cursorPage.body.nextCursor);
  const next = await f
    .get(r)
    .query({ limit: 1, cursor: cursorPage.body.nextCursor });
  assert.equal(next.body.items.length, 1);
  assert.notEqual(
    next.body.items[0].noticeId,
    cursorPage.body.items[0].noticeId,
  );
  assert.equal(
    (
      await f
        .auth(request(f.http).get('/v1/me/ratings/updates'), r)
        .query({ limit: 1, cursor: cursorPage.body.nextCursor })
    ).status,
    409,
  );
  await setRatingReviewState(f.pool, reply.approval.decisionId, 'held');
  const hidden = await f.get(r, `/${replyNotice.noticeId}/target`);
  assert.deepEqual(hidden.body, {
    noticeId: replyNotice.noticeId,
    status: 'unavailable',
  });
  assert.equal((await f.get(r, '/unread-count')).body.unreadCount, 2);
  const list = (await f.get(r)).body.items.find(
    (n: { noticeId: string }) => n.noticeId === replyNotice.noticeId,
  );
  assert.deepEqual(Object.keys(list).sort(), [
    'createdAt',
    'noticeId',
    'readAt',
    'status',
  ]);
  const read = await f.read(r, replyNotice.noticeId);
  assert.equal(read.status, 200);
  ratingSubscriptionNoticeReadSchema.parse(read.body);
  assert.equal(read.body.unreadCount, 1);
  const again = await f.read(r, replyNotice.noticeId);
  assert.deepEqual(again.body, read.body);
  const stored = (
    await f.pool.query<{ read_at: string }>(
      `SELECT to_char(read_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') read_at FROM whaleu_notifications.rating_subscription_notices WHERE id=$1`,
      [replyNotice.noticeId],
    )
  ).rows[0]!;
  assert.equal(read.body.readAt, stored.read_at);
  await setRatingReviewState(f.pool, reply.approval.decisionId, 'allow');
  assert.equal(
    (await f.get(r, `/${replyNotice.noticeId}/target`)).body.status,
    'available',
  );
  assert.equal((await f.get(r, '/unread-count')).body.unreadCount, 1);
  await f.deleteRoot(a, c, target, root);
  assert.deepEqual((await f.get(r, `/${rootNotice.noticeId}/target`)).body, {
    noticeId: rootNotice.noticeId,
    status: 'unavailable',
  });
  assert.equal((await f.read(r, rootNotice.noticeId)).body.unreadCount, 0);
  await assert.rejects(
    withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        'UPDATE whaleu_notifications.rating_subscription_notices SET read_at=NULL WHERE id=$1',
        [replyNotice.noticeId],
      ),
    ),
  );
  await assert.rejects(
    withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        "UPDATE whaleu_notifications.rating_subscription_notices SET read_at=clock_timestamp()+interval '1 second' WHERE id=$1",
        [replyNotice.noticeId],
      ),
    ),
  );
});
