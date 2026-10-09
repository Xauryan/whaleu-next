import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decodeRatingSubscriptionState,
  decodeRatingSubscriptionIntent,
  decodeRatingSubscriptionReceipt,
  decodeRatingSubscriptionBatch,
  matchRatingSubscriptionReceipt,
} from '../src/ratings/subscription-contract';
import {
  decodeRatingSubscriptionNotice,
  decodeRatingSubscriptionNoticeLocator,
  decodeRatingSubscriptionNoticeTarget,
  decodeRatingSubscriptionUpdatesPage,
} from '../src/ratings/subscription-updates-contract';
import { decodeRatingThreadRoute } from '../src/ratings/discussion-controller';
import {
  decodeRatingIntent,
  decodeRatingReceipt,
  decodeRatingTarget,
  ratingRejections,
} from '../src/ratings/contract';
import { decodeRatingReplyReceipt } from '../src/ratings/discussion-contract';
import { decodeRatingLikeReceipt } from '../src/ratings/like-contract';
import { decodeRatingNotice } from '../src/ratings/updates-contract';
import { decodeRatingLikeNotice } from '../src/ratings/like-updates-contract';
import { comment, otherId, target, targetId } from './ratings-helpers';
import { notice, noticeId, replyId, route } from './ratings-r2a-helpers';
import { likeNotice } from './ratings-r2b-helpers';
import {
  subscriptionState,
  subscriptionIntent,
  subscriptionReceipt,
  subscriptionBatch,
  subscriptionLocator,
  subscriptionNotice,
  subscriptionNoticeTarget,
  subscriptionUpdates,
} from './ratings-r2c-helpers';

test('R2C independent current state is strict immutable known or unavailable without synthetic false/zero', () => {
  for (const raw of [
    subscriptionState(),
    subscriptionState({ count: 13, subscribed: false }),
    { status: 'unavailable' },
  ])
    assert.deepEqual(decodeRatingSubscriptionState(raw), raw);
  const decoded = decodeRatingSubscriptionState(subscriptionState());
  assert.ok(Object.isFrozen(decoded));
  if (decoded.status === 'known')
    assert.ok(Object.isFrozen(decoded.allowedActions));
  for (const patch of [
    { targetId: 'bad' },
    { revision: null },
    { count: -1 },
    { count: 1.5 },
    { count: 2147483648 },
    { count: '0' },
    { count: NaN },
    { subscribed: 'false' },
    { subscribed: undefined },
    { allowedActions: { setSubscription: false } },
    { allowedActions: { setSubscription: true, setScore: true } },
    { author: comment().author },
    { accountId: otherId },
    { points: 1 },
    { rootId: otherId },
    { status: 'unavailable' },
  ])
    assert.throws(() =>
      decodeRatingSubscriptionState({ ...subscriptionState(), ...patch }),
    );
  for (const patch of [{ count: 0 }, { subscribed: false }, { targetId }])
    assert.throws(() =>
      decodeRatingSubscriptionState({ status: 'unavailable', ...patch }),
    );
  assert.deepEqual(decodeRatingTarget(target()), target());
  assert.throws(() => decodeRatingTarget({ ...target(), subscribed: false }));
  assert.throws(() =>
    decodeRatingTarget({ ...target(), subscriptionCount: 0 }),
  );
});
for (const subscribed of [false, true])
  test(`R2C desired ${subscribed} intent excludes counter, identities, XP and alternate target`, () => {
    const raw = subscriptionIntent(subscribed),
      decoded = decodeRatingSubscriptionIntent(raw);
    assert.deepEqual(decoded, raw);
    assert.ok(Object.isFrozen(decoded));
    assert.ok(Object.isFrozen(decoded.payload));
    for (const patch of [
      { clientRequestId: 'bad' },
      { regionId: undefined },
      { expectedTargetRevision: null },
      { expectedSubscriptionRevision: null },
      { subscribed: 1 },
      { targetId },
      { rootId: otherId },
      { actorId: otherId },
      { recipient: otherId },
      { authorMode: 'anonymous' },
      { count: 1 },
      { points: 2 },
      { quotaDay: '2026-10-09' },
    ])
      assert.throws(() =>
        decodeRatingSubscriptionIntent({
          ...raw,
          payload: { ...raw.payload, ...patch },
        }),
      );
    for (const patch of [
      { targetId: 'bad' },
      { operation: 'set_comment_like' },
      { extra: true },
    ])
      assert.throws(() => decodeRatingSubscriptionIntent({ ...raw, ...patch }));
    assert.throws(() => decodeRatingIntent(raw));
  });
test('R2C historical receipt matches exact owner request, target and desired state without pretending current or XP', () => {
  const command = subscriptionIntent();
  for (const outcome of ['applied', 'noop'] as const) {
    const raw = subscriptionReceipt(command, {
      outcome,
      ...(outcome === 'noop'
        ? { revision: command.payload.expectedSubscriptionRevision }
        : {}),
    });
    assert.deepEqual(decodeRatingSubscriptionReceipt(raw), raw);
    assert.doesNotThrow(() => matchRatingSubscriptionReceipt(command, raw));
  }
  for (const code of ratingRejections) {
    const raw = {
      requestId: command.payload.clientRequestId,
      operation: command.operation,
      outcome: 'rejected',
      code,
    };
    assert.doesNotThrow(() =>
      matchRatingSubscriptionReceipt(
        command,
        decodeRatingSubscriptionReceipt(raw),
      ),
    );
  }
  for (const patch of [
    { requestId: otherId },
    { targetId: otherId },
    { subscribed: false },
  ])
    assert.throws(() =>
      matchRatingSubscriptionReceipt(
        command,
        decodeRatingSubscriptionReceipt({ ...subscriptionReceipt(), ...patch }),
      ),
    );
  for (const patch of [
    { count: 1 },
    { points: 1 },
    { author: comment().author },
    { recipient: otherId },
    { rootId: otherId },
    { operation: 'set_score' },
    { occurredAt: '2026-10-09T00:00:00+00:00' },
    { revision: 'bad' },
    { outcome: 'rejected', code: 'RATING_UNAVAILABLE' },
  ])
    assert.throws(() =>
      decodeRatingSubscriptionReceipt({ ...subscriptionReceipt(), ...patch }),
    );
  for (const decoder of [
    decodeRatingReceipt,
    decodeRatingReplyReceipt,
    decodeRatingLikeReceipt,
  ])
    assert.throws(() => decoder(subscriptionReceipt()));
});
test('R2C batch states are individually strict and cannot leak an unavailable target membership', () => {
  const raw = subscriptionBatch([targetId, otherId]);
  assert.deepEqual(decodeRatingSubscriptionBatch(raw), raw);
  assert.ok(Object.isFrozen(decodeRatingSubscriptionBatch(raw).items));
  for (const value of [
    { items: [...raw.items, ...raw.items] },
    { ...raw, extra: true },
    { items: [{ targetId, state: subscriptionState({ targetId: otherId }) }] },
    { items: [{ targetId, state: { status: 'unavailable', count: 0 } }] },
    { items: [{ targetId, state: { status: 'unavailable' }, extra: true }] },
  ])
    assert.throws(() => decodeRatingSubscriptionBatch(value));
});
for (const activity of ['root', 'reply'] as const)
  test(`R2C ${activity} subscription notice keeps exact locator and current rating persona preview`, () => {
    const raw = subscriptionNotice({
      activity,
      target: subscriptionLocator({
        replyId: activity === 'reply' ? replyId : null,
      }),
    });
    assert.deepEqual(decodeRatingSubscriptionNotice(raw), raw);
    assert.deepEqual(
      decodeRatingSubscriptionNoticeLocator(raw.target),
      raw.target,
    );
    assert.deepEqual(
      decodeRatingSubscriptionUpdatesPage(
        subscriptionUpdates({ items: [raw] }),
      ),
      subscriptionUpdates({ items: [raw] }),
    );
    assert.throws(() => decodeRatingNotice(raw));
    assert.throws(() => decodeRatingLikeNotice(raw));
    for (const patch of [
      { kind: 'reply' },
      { kind: 'like' },
      { reason: 'direct_root' },
      { activity: activity === 'root' ? 'reply' : 'root' },
      { domain: 'community' },
      { actor: comment().author },
      { recipient: otherId },
      { preview: { ...raw.preview, accountId: otherId } },
      {
        preview: {
          ...raw.preview,
          author: { ...raw.preview.author, accountId: otherId },
        },
      },
      { target: { ...raw.target, replyId: undefined } },
    ])
      assert.throws(() => decodeRatingSubscriptionNotice({ ...raw, ...patch }));
  });
test('R2C unavailable notices disclose only notice timestamps; foreign categories, duplicate notices and invalid counts reject', () => {
  const raw = {
    noticeId,
    createdAt: subscriptionNotice().createdAt,
    readAt: null,
    status: 'unavailable',
  };
  assert.deepEqual(decodeRatingSubscriptionNotice(raw), raw);
  for (const patch of [
    { target: subscriptionLocator() },
    { preview: subscriptionNotice().preview },
    { kind: 'subscription' },
    { activity: 'root' },
    { reason: 'deleted' },
  ])
    assert.throws(() => decodeRatingSubscriptionNotice({ ...raw, ...patch }));
  assert.deepEqual(
    decodeRatingSubscriptionNoticeTarget(subscriptionNoticeTarget()),
    subscriptionNoticeTarget(),
  );
  assert.deepEqual(
    decodeRatingSubscriptionNoticeTarget({ noticeId, status: 'unavailable' }),
    { noticeId, status: 'unavailable' },
  );
  assert.throws(() =>
    decodeRatingSubscriptionNoticeTarget({
      noticeId,
      status: 'unavailable',
      target: subscriptionLocator(),
    }),
  );
  for (const raw of [notice(), likeNotice()])
    assert.throws(() => decodeRatingSubscriptionNotice(raw));
  assert.throws(() =>
    decodeRatingSubscriptionUpdatesPage(
      subscriptionUpdates({
        items: [subscriptionNotice(), subscriptionNotice()],
      }),
    ),
  );
  for (const unreadCount of [-1, 0.5, NaN, '0'])
    assert.throws(() =>
      decodeRatingSubscriptionUpdatesPage({
        ...subscriptionUpdates(),
        unreadCount,
      }),
    );
});
test('R2C receiving route accepts root/reply subscription locator only as its own mutually exclusive category', () => {
  for (const value of [
    { ...route, subscriptionNoticeId: noticeId },
    { ...route, replyId, subscriptionNoticeId: noticeId },
  ])
    assert.deepEqual(decodeRatingThreadRoute(value), value);
  for (const value of [
    { ...route, subscriptionNoticeId: 'bad' },
    { ...route, subscriptionNoticeId: noticeId, noticeId },
    { ...route, subscriptionNoticeId: noticeId, likeNoticeId: noticeId },
    { ...route, subscriptionNoticeId: noticeId, accountId: otherId },
  ])
    assert.throws(() => decodeRatingThreadRoute(value));
});

test('R2C Native strict decoders accept the frozen actual AppModule HTTP/PostgreSQL public golden while legacy contracts stay closed', () => {
  const golden = JSON.parse(
    readFileSync(
      join(__dirname, '../../../packages/fixtures/ratings-r2c.json'),
      'utf8',
    ),
  );
  assert.deepEqual(
    decodeRatingSubscriptionState(golden.knownSubscription),
    golden.knownSubscription,
  );
  assert.deepEqual(
    decodeRatingSubscriptionBatch(golden.subscriptionBatch),
    golden.subscriptionBatch,
  );
  for (const key of [
    'appliedSubscriptionReceipt',
    'noopSubscriptionReceipt',
    'rejectedSubscriptionReceipt',
  ]) {
    assert.deepEqual(decodeRatingSubscriptionReceipt(golden[key]), golden[key]);
    for (const decoder of [
      decodeRatingReceipt,
      decodeRatingReplyReceipt,
      decodeRatingLikeReceipt,
    ])
      assert.throws(() => decoder(golden[key]));
  }
  const updates = decodeRatingSubscriptionUpdatesPage(
    golden.subscriptionUpdates,
  );
  assert.deepEqual(updates, golden.subscriptionUpdates);
  assert.deepEqual(
    new Set(
      updates.items
        .filter((item) => item.status === 'available')
        .map((item) => item.activity),
    ),
    new Set(['root', 'reply']),
  );
  for (const item of updates.items)
    if (item.status === 'available') {
      assert.throws(() => decodeRatingNotice(item));
      assert.throws(() => decodeRatingLikeNotice(item));
      assert.equal(item.activity === 'root', item.target.replyId === null);
    }
  assert.deepEqual(
    decodeRatingSubscriptionNoticeTarget(golden.subscriptionNoticeTarget),
    golden.subscriptionNoticeTarget,
  );
});
