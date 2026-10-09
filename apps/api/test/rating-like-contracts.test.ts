import { readFileSync } from 'node:fs';
import { ratingCommentPageSchema } from '../src/ratings/contracts.js';
import {
  ratingLikeUpdatesPageSchema,
  ratingLikeNoticeTargetSchema,
} from '../src/notifications/ratings/like-contracts.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import * as c from '../src/ratings/likes/contracts.js';
import {
  ratingReceiptSchema,
  ratingCommentQuerySchema,
} from '../src/ratings/contracts.js';
import {
  ratingReplyReceiptSchema,
  ratingReplyQuerySchema,
} from '../src/ratings/discussion-contracts.js';
const id = randomUUID(),
  root = randomUUID(),
  reply = randomUUID(),
  key = randomUUID();
const command = {
  clientRequestId: key,
  regionId: null,
  targetId: id,
  expectedTargetRevision: randomUUID(),
  expectedRevision: randomUUID(),
  expectedLikeRevision: randomUUID(),
  liked: true,
};
for (const name of [
  'actor',
  'recipient',
  'authorMode',
  'profileId',
  'points',
  'quotaDay',
  'count',
  'messageId',
])
  test(`like rejects client-owned ${name}`, () => {
    assert.equal(
      c.setRatingCommentLikeSchema.safeParse({ ...command, [name]: id })
        .success,
      false,
    );
    assert.equal(
      c.setRatingReplyLikeSchema.safeParse({
        ...command,
        rootId: root,
        expectedRootRevision: id,
        [name]: id,
      }).success,
      false,
    );
  });
test('likes have strict desired boolean and non-null membership CAS', () => {
  assert.ok(c.setRatingCommentLikeSchema.safeParse(command).success);
  for (const liked of [0, 1, 'true', null])
    assert.equal(
      c.setRatingCommentLikeSchema.safeParse({ ...command, liked }).success,
      false,
    );
  assert.equal(
    c.setRatingCommentLikeSchema.safeParse({
      ...command,
      expectedLikeRevision: null,
    }).success,
    false,
  );
  assert.equal(c.setRatingReplyLikeSchema.safeParse(command).success, false);
});
test('like receipt and current state stay minimal and typed; old decoders closed', () => {
  for (const operation of ['set_comment_like', 'set_reply_like'])
    for (const outcome of ['applied', 'noop']) {
      const r = {
        requestId: key,
        operation,
        outcome,
        targetId: id,
        rootId: root,
        replyId: operation === 'set_reply_like' ? reply : null,
        liked: true,
        revision: id,
        occurredAt: '2026-10-09T00:00:00.123456Z',
      };
      assert.ok(c.ratingLikeReceiptSchema.safeParse(r).success);
      assert.equal(
        c.ratingLikeReceiptSchema.safeParse({
          ...r,
          replyId: r.replyId ? null : reply,
        }).success,
        false,
      );
      assert.equal(
        c.ratingLikeReceiptSchema.safeParse({ ...r, count: 1 }).success,
        false,
      );
      assert.equal(ratingReceiptSchema.safeParse(r).success, false);
      assert.equal(ratingReplyReceiptSchema.safeParse(r).success, false);
    }
  assert.ok(
    c.ratingLikeStateSchema.safeParse({ status: 'unavailable' }).success,
  );
  assert.equal(
    c.ratingLikeStateSchema.safeParse({
      status: 'unavailable',
      liked: false,
      count: 0,
    }).success,
    false,
  );
  for (const count of [-1, 1.2, 2147483648])
    assert.equal(
      c.ratingLikeStateSchema.safeParse({
        status: 'known',
        targetId: id,
        rootId: root,
        replyId: null,
        count,
        liked: false,
        revision: id,
        allowedActions: { setLike: true },
      }).success,
      false,
    );
});
test('explicit root order does not expand legacy reply query or erase omission', () => {
  assert.deepEqual(ratingCommentQuerySchema.parse({}), { limit: 20 });
  for (const sort of ['time', 'likes'])
    for (const order of ['asc', 'desc'])
      assert.deepEqual(ratingCommentQuerySchema.parse({ sort, order }), {
        limit: 20,
        sort,
        order,
      });
  assert.equal(
    ratingReplyQuerySchema.safeParse({ sort: 'time' }).success,
    false,
  );
  assert.equal(
    ratingCommentQuerySchema.safeParse({ sort: 'hot' }).success,
    false,
  );
});

test('actual HTTP golden fixtures validate the API and preserve unavailable coverage', () => {
  const golden = JSON.parse(
    readFileSync(
      new URL('../../../packages/fixtures/ratings-r2b.json', import.meta.url),
      'utf8',
    ),
  ) as Record<string, unknown>;
  for (const key of ['rootLikeState', 'replyLikeState', 'unavailableLikeState'])
    assert.deepEqual(c.ratingLikeStateSchema.parse(golden[key]), golden[key]);
  for (const key of ['rootLikeReceipt', 'replyLikeReceipt'])
    assert.deepEqual(c.ratingLikeReceiptSchema.parse(golden[key]), golden[key]);
  assert.deepEqual(
    ratingLikeUpdatesPageSchema.parse(golden['likeUpdatesPage']),
    golden['likeUpdatesPage'],
  );
  for (const key of ['rootLikeNoticeTarget', 'replyLikeNoticeTarget'])
    assert.deepEqual(
      ratingLikeNoticeTargetSchema.parse(golden[key]),
      golden[key],
    );
  assert.deepEqual(
    ratingCommentPageSchema.parse(golden['sortedCommentPage']),
    golden['sortedCommentPage'],
  );
});
