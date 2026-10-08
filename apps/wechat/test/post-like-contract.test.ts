import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodePostLikeIntent,
  decodePostLikeReceipt,
  matchPostLikeReceipt,
  type PostLikeIntent,
  type PostLikeReceipt,
} from '../src/community/post-like-contract';
import { otherId, postId, requestId } from './community-helpers';
const intent: PostLikeIntent = {
  requestId,
  operation: 'set_post_like',
  postId,
  liked: true,
};
const receipt: PostLikeReceipt = { ...intent, outcome: 'applied' };

test('post-like intent and historical applied/rejected receipt are exact frozen discriminated DTOs', () => {
  assert.deepEqual(decodePostLikeIntent(intent), intent);
  assert.ok(Object.isFrozen(decodePostLikeIntent(intent)));
  assert.deepEqual(decodePostLikeReceipt(receipt), receipt);
  for (const code of [
    'POST_NOT_FOUND',
    'COMMUNITY_SCOPE_UNAVAILABLE',
    'PHONE_VERIFICATION_REQUIRED',
    'COMMUNITY_ACTION_RESTRICTED',
  ] as const) {
    const value = { ...intent, outcome: 'rejected' as const, code };
    assert.deepEqual(decodePostLikeReceipt(value), value);
    assert.ok(Object.isFrozen(decodePostLikeReceipt(value)));
  }
});
test('post-like decoder rejects coercion, noncanonical IDs and live/private authority fields', () => {
  for (const patch of [
    { requestId: 'bad' },
    { postId: 'bad' },
    { operation: 'set_comment_like' },
    { requestId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
    { postId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
    { requestId: 'aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa' },
    { liked: 1 },
    { liked: 'true' },
    { liked: null },
    { operation: ['set_post_like'] },
  ]) {
    assert.throws(() => decodePostLikeIntent({ ...intent, ...patch }), {
      kind: 'protocol',
    });
    assert.throws(() => decodePostLikeReceipt({ ...receipt, ...patch }), {
      kind: 'protocol',
    });
  }
  for (const extra of [
    { likeCount: 1 },
    { isLiked: true },
    { accountId: otherId },
    { experience: 3 },
    { code: 'POST_NOT_FOUND' },
    { resourceId: postId },
  ]) {
    assert.throws(() => decodePostLikeReceipt({ ...receipt, ...extra }), {
      kind: 'protocol',
    });
  }
  for (const value of [
    null,
    {},
    { ...receipt, outcome: ['applied'] },
    { ...receipt, outcome: 'rejected' },
    { ...receipt, outcome: 'rejected', code: 'COMMUNITY_UNAVAILABLE' },
  ])
    assert.throws(() => decodePostLikeReceipt(value), { kind: 'protocol' });
  for (const key of Object.keys(receipt)) {
    const value: Record<string, unknown> = { ...receipt };
    delete value[key];
    assert.throws(() => decodePostLikeReceipt(value), { kind: 'protocol' });
  }
});
test('both terminal outcomes must match request, operation, post and original liked intent', () => {
  for (const outcome of ['applied', 'rejected'] as const) {
    const value =
      outcome === 'applied'
        ? receipt
        : { ...intent, outcome, code: 'POST_NOT_FOUND' as const };
    matchPostLikeReceipt(intent, value);
    for (const patch of [
      { requestId: otherId },
      { postId: otherId },
      { liked: false },
      { operation: 'set_comment_like' },
    ])
      assert.throws(
        () =>
          matchPostLikeReceipt(intent, {
            ...value,
            ...patch,
          } as PostLikeReceipt),
        { kind: 'protocol' },
      );
  }
});
