import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decodeRatingLikeIntent,
  decodeRatingLikeReceipt,
  decodeRatingLikeState,
  matchRatingLikeReceipt,
} from '../src/ratings/like-contract';
import {
  decodeRatingLikeNotice,
  decodeRatingLikeNoticeLocator,
  decodeRatingLikeNoticeTarget,
  decodeRatingLikeUpdatesPage,
} from '../src/ratings/like-updates-contract';
import { decodeRatingThreadRoute } from '../src/ratings/discussion-controller';
import {
  decodeRatingComment,
  decodeRatingCommentPage,
  decodeRatingIntent,
  decodeRatingReceipt,
  ratingRejections,
} from '../src/ratings/contract';
import {
  decodeRatingReply,
  decodeRatingReplyReceipt,
} from '../src/ratings/discussion-contract';
import { decodeRatingNotice } from '../src/ratings/updates-contract';
import {
  comment,
  commentId,
  otherId,
  revision,
  targetId,
} from './ratings-helpers';
import { notice, noticeId, reply, replyId, route } from './ratings-r2a-helpers';
import {
  likeIntent,
  likeLocator,
  likeNotice,
  likeNoticeTarget,
  likeReceipt,
  likeState,
  likeUpdates,
} from './ratings-r2b-helpers';

for (const replyIdOrNull of [null, replyId])
  test(`R2B current like state accepts typed subject ${replyIdOrNull ?? 'root'} and unknown is not zero`, () => {
    const raw = likeState({ replyId: replyIdOrNull });
    assert.deepEqual(decodeRatingLikeState(raw), raw);
    assert.deepEqual(decodeRatingLikeState({ status: 'unavailable' }), {
      status: 'unavailable',
    });
    assert.equal(
      decodeRatingLikeState(likeState({ count: 17, liked: false })).status,
      'known',
    );
    assert.ok(Object.isFrozen(decodeRatingLikeState(raw)));
  });
for (const [label, patch] of Object.entries({
  extraAuthor: { author: comment().author },
  extraAccount: { accountId: otherId },
  extraRecipient: { recipient: otherId },
  extraReward: { points: 2 },
  missingRoot: { rootId: undefined },
  invalidTarget: { targetId: 'bad' },
  invalidReply: { replyId: '' },
  missingReply: { replyId: undefined },
  invalidRevision: { revision: null },
  negative: { count: -1 },
  fractional: { count: 1.5 },
  unsafe: { count: Number.MAX_SAFE_INTEGER + 1 },
  stringCount: { count: '0' },
  nan: { count: NaN },
  stringLiked: { liked: 'false' },
  missingLiked: { liked: undefined },
  foreignActions: { allowedActions: { setLike: true, delete: true } },
  unavailableLeaks: { status: 'unavailable' },
}))
  test(`R2B current like decoder rejects ${label}`, () =>
    assert.throws(() => decodeRatingLikeState({ ...likeState(), ...patch })));

for (const operation of ['set_comment_like', 'set_reply_like'] as const)
  for (const liked of [false, true])
    test(`R2B ${operation} desired ${liked} is exact, immutable and rejects private/counter inputs`, () => {
      const raw = likeIntent(operation, liked);
      assert.deepEqual(decodeRatingLikeIntent(raw), raw);
      assert.ok(Object.isFrozen(decodeRatingLikeIntent(raw).payload));
      for (const patch of [
        { actorId: otherId },
        { recipient: otherId },
        { authorMode: 'anonymous' },
        { profileId: otherId },
        { count: 0 },
        { points: 2 },
        { quotaDay: '2026-10-09' },
        { messageId: otherId },
        { liked: 1 },
        { expectedTargetRevision: null },
        { expectedRevision: null },
        { expectedLikeRevision: null },
        { regionId: undefined },
        { clientRequestId: 'bad' },
      ])
        assert.throws(() =>
          decodeRatingLikeIntent({
            ...raw,
            payload: { ...raw.payload, ...patch },
          }),
        );
      assert.throws(
        () => decodeRatingIntent(raw),
        'legacy decoder stays closed',
      );
      assert.throws(() => decodeRatingLikeIntent({ ...raw, extra: true }));
      assert.throws(() =>
        decodeRatingLikeIntent({ ...raw, operation: 'set_score' }),
      );
    });

test('R2B root/reply intent branches require their own path and content CAS fields', () => {
  const root = likeIntent(),
    child = likeIntent('set_reply_like');
  assert.throws(() => decodeRatingLikeIntent({ ...root, commentId }));
  assert.throws(() => decodeRatingLikeIntent({ ...root, rootId: 'bad' }));
  assert.throws(() =>
    decodeRatingLikeIntent({
      ...root,
      payload: { ...root.payload, rootId: commentId },
    }),
  );
  assert.throws(() =>
    decodeRatingLikeIntent({
      ...child,
      payload: { ...child.payload, expectedRootRevision: null },
    }),
  );
  assert.throws(() => decodeRatingLikeIntent({ ...child, replyId: null }));
  assert.throws(() =>
    decodeRatingLikeIntent({
      ...child,
      payload: { ...child.payload, rootId: undefined },
    }),
  );
});

for (const operation of ['set_comment_like', 'set_reply_like'] as const)
  test(`R2B ${operation} applied/noop receipts are historical only and match exact desired state`, () => {
    const command = likeIntent(operation);
    for (const outcome of ['applied', 'noop'] as const) {
      const result = likeReceipt(command, { outcome });
      assert.deepEqual(decodeRatingLikeReceipt(result), result);
      assert.doesNotThrow(() => matchRatingLikeReceipt(command, result));
    }
    for (const code of ratingRejections) {
      const rejected = {
        requestId: command.payload.clientRequestId,
        operation,
        outcome: 'rejected',
        code,
      };
      assert.deepEqual(decodeRatingLikeReceipt(rejected), rejected);
      assert.doesNotThrow(() =>
        matchRatingLikeReceipt(command, decodeRatingLikeReceipt(rejected)),
      );
    }
    for (const patch of [
      { requestId: otherId },
      { targetId: otherId },
      { rootId: otherId },
      { liked: false },
      {
        operation:
          operation === 'set_comment_like'
            ? 'set_reply_like'
            : 'set_comment_like',
      },
      { replyId: operation === 'set_comment_like' ? replyId : otherId },
    ])
      assert.throws(() =>
        matchRatingLikeReceipt(
          command,
          decodeRatingLikeReceipt({ ...likeReceipt(command), ...patch }),
        ),
      );
    for (const patch of [
      { count: 1 },
      { actor: otherId },
      { recipient: otherId },
      { points: 2 },
      { body: 'old body' },
      { author: comment().author },
      { revision: 'bad' },
      { occurredAt: '2026-10-09T00:00:00+00:00' },
      { outcome: 'rejected', code: 'RATING_UNAVAILABLE' },
      { replyId: operation === 'set_comment_like' ? replyId : null },
    ])
      assert.throws(() =>
        decodeRatingLikeReceipt({ ...likeReceipt(command), ...patch }),
      );
    assert.throws(() => decodeRatingReceipt(likeReceipt(command)));
    assert.throws(() => decodeRatingReplyReceipt(likeReceipt(command)));
  });

test('R2B leaves original content shape closed and distinct from current like coverage', () => {
  assert.deepEqual(decodeRatingComment(comment()), comment());
  assert.deepEqual(decodeRatingReply(reply()), reply());
  assert.throws(() => decodeRatingComment({ ...comment(), likeCount: 0 }));
  assert.throws(() => decodeRatingReply({ ...reply(), liked: false }));
  assert.deepEqual(
    decodeRatingLikeState(
      likeState({ targetId, rootId: targetId, replyId: targetId }),
    ),
    likeState({ targetId, rootId: targetId, replyId: targetId }),
  );
});

test('R2B like notices use named actor plus current preview; legacy reply decoder remains closed', () => {
  for (const target of [likeLocator(), likeLocator({ replyId })]) {
    const raw = likeNotice({ target });
    assert.deepEqual(decodeRatingLikeNotice(raw), raw);
    assert.deepEqual(decodeRatingLikeNoticeLocator(target), target);
    assert.throws(() => decodeRatingNotice(raw));
  }
  assert.deepEqual(decodeRatingLikeUpdatesPage(likeUpdates()), likeUpdates());
  assert.deepEqual(
    decodeRatingLikeNoticeTarget(likeNoticeTarget()),
    likeNoticeTarget(),
  );
  assert.throws(() => decodeRatingLikeNotice(notice()));
  const unavailable = {
    noticeId,
    createdAt: likeNotice().createdAt,
    readAt: null,
    status: 'unavailable',
  };
  assert.deepEqual(decodeRatingLikeNotice(unavailable), unavailable);
  assert.deepEqual(
    decodeRatingLikeNoticeTarget({ noticeId, status: 'unavailable' }),
    { noticeId, status: 'unavailable' },
  );
  for (const patch of [
    { target: likeLocator() },
    { actor: likeNotice().actor },
    { preview: likeNotice().preview },
    { reason: 'deleted' },
  ])
    assert.throws(() => decodeRatingLikeNotice({ ...unavailable, ...patch }));
  for (const patch of [
    { kind: 'reply' },
    { reason: 'direct_root' },
    { domain: 'community' },
    { recipient: otherId },
    { actor: comment().author },
    { actor: { ...likeNotice().actor, accountId: otherId } },
    { actor: { ...likeNotice().actor, profileId: null } },
    { preview: { ...likeNotice().preview, author: comment().author } },
    { target: { ...likeLocator(), replyId: undefined } },
    { target: { ...likeLocator(), recipient: otherId } },
  ])
    assert.throws(() => decodeRatingLikeNotice({ ...likeNotice(), ...patch }));
  for (const unreadCount of [-1, NaN, 0.5, '0'])
    assert.throws(() =>
      decodeRatingLikeUpdatesPage({ ...likeUpdates(), unreadCount }),
    );
  assert.throws(() =>
    decodeRatingLikeUpdatesPage(
      likeUpdates({ items: [likeNotice(), likeNotice()] }),
    ),
  );
  assert.throws(() =>
    decodeRatingLikeUpdatesPage(
      likeUpdates({
        items: [notice() as unknown as ReturnType<typeof likeNotice>],
      }),
    ),
  );
});

test('R2B receiving routes distinguish root/reply like notices from legacy reply notices', () => {
  for (const value of [
    { ...route, likeNoticeId: noticeId },
    { ...route, replyId, likeNoticeId: noticeId },
  ])
    assert.deepEqual(decodeRatingThreadRoute(value), value);
  assert.deepEqual(decodeRatingThreadRoute({ ...route, replyId, noticeId }), {
    ...route,
    replyId,
    noticeId,
  });
  for (const value of [
    { ...route, noticeId },
    { ...route, likeNoticeId: 'bad' },
    { ...route, replyId, noticeId, likeNoticeId: noticeId },
    { ...route, likeNoticeId: noticeId, recipient: otherId },
    { ...route, likeNoticeId: noticeId, expectedRevision: revision },
  ])
    assert.throws(() => decodeRatingThreadRoute(value));
});

test('R2B native decoders accept the frozen actual AppModule HTTP/PG public golden without changing legacy DTOs', () => {
  const golden = JSON.parse(
    readFileSync(
      join(__dirname, '../../../packages/fixtures/ratings-r2b.json'),
      'utf8',
    ),
  );
  for (const key of ['rootLikeState', 'replyLikeState', 'unavailableLikeState'])
    assert.deepEqual(decodeRatingLikeState(golden[key]), golden[key]);
  for (const key of ['rootLikeReceipt', 'replyLikeReceipt']) {
    assert.deepEqual(decodeRatingLikeReceipt(golden[key]), golden[key]);
    assert.throws(() => decodeRatingReceipt(golden[key]));
    assert.throws(() => decodeRatingReplyReceipt(golden[key]));
  }
  assert.deepEqual(
    decodeRatingLikeUpdatesPage(golden.likeUpdatesPage),
    golden.likeUpdatesPage,
  );
  for (const key of ['rootLikeNoticeTarget', 'replyLikeNoticeTarget'])
    assert.deepEqual(decodeRatingLikeNoticeTarget(golden[key]), golden[key]);
  assert.deepEqual(
    decodeRatingCommentPage(golden.sortedCommentPage),
    golden.sortedCommentPage,
  );
  for (const item of golden.likeUpdatesPage.items)
    if (item.status === 'available')
      assert.throws(() => decodeRatingNotice(item));
});
