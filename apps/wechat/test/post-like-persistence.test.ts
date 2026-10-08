import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PendingPostLikeStore,
  type PendingPostLike,
} from '../src/community/post-like-pending';
import type { PostLikeReceipt } from '../src/community/post-like-contract';
import { PendingSavedStore } from '../src/community/saved-pending';
import { MemoryStorage } from './helpers';
import { wireCredentials } from './identity-helpers';
import { otherId, postId, requestId } from './community-helpers';
const accountId = wireCredentials().accountId;
const attempt = (
  overrides: Partial<PendingPostLike> = {},
): PendingPostLike => ({
  version: 1,
  accountId,
  requestId,
  operation: 'set_post_like',
  postId,
  liked: true,
  ...overrides,
});
const receipt = (value = attempt()): PostLikeReceipt => ({
  requestId: value.requestId,
  operation: value.operation,
  postId: value.postId,
  liked: value.liked,
  outcome: 'applied',
});
test('post-like journal is immutable, account/API-origin scoped, nonexpiring and independent of saves', () => {
  const storage = new MemoryStorage(),
    store = new PendingPostLikeStore(storage, 'origin');
  const a = store.freeze(attempt());
  assert.ok(Object.isFrozen(a));
  assert.deepEqual(store.freeze(a), a);
  assert.deepEqual(
    new PendingPostLikeStore(storage, 'origin').load(accountId),
    a,
  );
  assert.equal(
    new PendingPostLikeStore(storage, 'other').load(accountId),
    null,
  );
  assert.equal(store.load(otherId), null);
  for (const patch of [
    { liked: false },
    { postId: otherId },
    { requestId: otherId },
  ]) {
    assert.throws(() => store.freeze(attempt(patch)), { kind: 'storage' });
    assert.deepEqual(store.load(accountId), a);
  }
  store.freeze(attempt({ accountId: otherId }));
  new PendingSavedStore(storage, 'origin').freeze({
    version: 1,
    accountId,
    clientRequestId: requestId,
    operation: 'set_post_saved',
    postId,
    desired: true,
    channel: null,
  });
  assert.equal(storage.data.size, 3);
  store.settle(a, receipt());
  assert.equal(storage.data.size, 2);
});
test('only exact terminal receipt releases original journal; stale settlement cannot erase newer unlike', () => {
  for (const outcome of ['applied', 'rejected'] as const) {
    const storage = new MemoryStorage(),
      first = new PendingPostLikeStore(storage, 'origin');
    const a = first.freeze(attempt());
    const result: PostLikeReceipt =
      outcome === 'applied'
        ? receipt()
        : { ...receipt(), outcome, code: 'POST_NOT_FOUND' };
    for (const patch of [
      { requestId: otherId },
      { postId: otherId },
      { liked: false },
      { operation: 'set_comment_like' },
      { likeCount: 1 },
    ]) {
      assert.throws(
        () => first.settle(a, { ...result, ...patch } as PostLikeReceipt),
        { kind: 'protocol' },
      );
      assert.deepEqual(first.load(accountId), a);
    }
    first.settle(a, result);
    const second = new PendingPostLikeStore(storage, 'origin');
    const b = second.freeze(attempt({ requestId: otherId, liked: false }));
    assert.throws(() => first.settle(a, result), { kind: 'storage' });
    assert.deepEqual(second.load(accountId), b);
    assert.throws(() => second.settle(b, result), { kind: 'protocol' });
    second.settle(b, receipt(b));
    assert.equal(first.load(accountId), null);
  }
});
test('corrupt/dishonest persistence and removal preserve the barrier instead of replacing intent', () => {
  for (const patch of [
    { version: 2 },
    { accountId: otherId },
    { requestId: 'bad' },
    { postId: 'bad' },
    { liked: 'true' },
    { operation: 'set_post_saved' },
    { expiresAt: 0 },
  ]) {
    const storage = new MemoryStorage(),
      store = new PendingPostLikeStore(storage, 'origin');
    store.freeze(attempt());
    const key = [...storage.data.keys()][0]!;
    const bad = { ...attempt(), ...patch };
    storage.data.set(key, bad);
    assert.throws(() => store.load(accountId), { kind: 'storage' });
    assert.throws(() => store.freeze(attempt()), { kind: 'storage' });
    assert.deepEqual(storage.data.get(key), bad);
  }
  const storage = new MemoryStorage(),
    store = new PendingPostLikeStore(storage, 'origin');
  storage.failWrite = true;
  assert.throws(() => store.freeze(attempt()), { kind: 'storage' });
  assert.equal(store.load(accountId), null);
  storage.failWrite = false;
  const a = store.freeze(attempt());
  storage.failRemove = true;
  assert.throws(() => store.settle(a, receipt()), { kind: 'storage' });
  assert.deepEqual(store.load(accountId), a);
  const dishonest = new PendingPostLikeStore(
    {
      get: (k) => storage.get(k),
      set: (k, v) => storage.set(k, v),
      remove: () => undefined,
    },
    'origin',
  );
  assert.throws(() => dishonest.settle(a, receipt()), { kind: 'storage' });
  assert.throws(
    () =>
      new PendingPostLikeStore(
        { get: () => undefined, set: () => undefined, remove: () => undefined },
        'origin',
      ).freeze(attempt()),
    { kind: 'storage' },
  );
});
