import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PendingSavedStore,
  type PendingSaved,
} from '../src/community/saved-pending';
import type { SavedReceipt } from '../src/community/saved-contract';
import { PendingAttemptStore } from '../src/community/pending-attempt';
import { PendingBallotStore } from '../src/community/poll-pending';
import { PendingDiscussionStore } from '../src/community/discussion-pending';
import { PendingTradingStore } from '../src/community/trading-pending';
import { MemoryStorage } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  commentId,
  intent,
  otherId,
  postId,
  requestId,
} from './community-helpers';

const accountId = wireCredentials().accountId;
const attempt = (overrides: Partial<PendingSaved> = {}): PendingSaved => ({
  version: 1,
  accountId,
  operation: 'set_post_saved',
  postId,
  desired: true,
  channel: null,
  clientRequestId: requestId,
  ...overrides,
});
const receipt = (value = attempt()): SavedReceipt => ({
  requestId: value.clientRequestId,
  operation: value.operation,
  postId: value.postId,
  desired: value.desired,
  channel: value.channel,
  outcome: 'applied',
});

test('Saved pending journal is immutable, account/origin scoped, nonexpiring and independent of earlier mutation namespaces', () => {
  const storage = new MemoryStorage(),
    store = new PendingSavedStore(storage, 'origin');
  const frozen = store.freeze(attempt());
  assert.ok(Object.isFrozen(frozen));
  assert.deepEqual(store.freeze(attempt()), frozen);
  assert.deepEqual(
    new PendingSavedStore(storage, 'origin').load(accountId),
    frozen,
  );
  assert.equal(
    new PendingSavedStore(storage, 'other-origin').load(accountId),
    null,
  );
  assert.equal(store.load(otherId), null);
  new PendingAttemptStore(storage, 'origin').freeze({
    version: 1,
    accountId,
    operation: 'publish_post',
    payload: intent(),
  });
  new PendingBallotStore(storage, 'origin').freeze({
    version: 1,
    accountId,
    postId,
    payload: { clientRequestId: requestId, optionIds: [otherId] },
  });
  new PendingDiscussionStore(storage, 'origin').freeze({
    version: 1,
    accountId,
    operation: 'set_comment_like',
    postId,
    rootCommentId: commentId,
    targetId: commentId,
    desired: true,
    clientRequestId: requestId,
  });
  new PendingTradingStore(storage, 'origin').freeze({
    version: 1,
    accountId,
    postId,
    resolution: 'resolved',
    clientRequestId: requestId,
  });
  assert.equal(storage.data.size, 5);
  store.settle(frozen, receipt());
  assert.equal(store.load(accountId), null);
  assert.equal(storage.data.size, 4);
  assert.ok(new PendingAttemptStore(storage, 'origin').load(accountId));
  assert.ok(new PendingBallotStore(storage, 'origin').load(accountId));
  assert.ok(new PendingDiscussionStore(storage, 'origin').load(accountId));
  assert.ok(new PendingTradingStore(storage, 'origin').load(accountId));
});

test('one unresolved account journal blocks opposite, other post and either preference channel without replacing original bytes', () => {
  const storage = new MemoryStorage(),
    store = new PendingSavedStore(storage, 'origin');
  const original = store.freeze(attempt());
  for (const changed of [
    attempt({ desired: false }),
    attempt({ postId: otherId }),
    attempt({ clientRequestId: otherId }),
    attempt({ operation: 'set_post_update_preference', channel: 'saved' }),
    attempt({ operation: 'set_post_update_preference', channel: 'external' }),
  ]) {
    assert.throws(() => store.freeze(changed), { kind: 'storage' });
    assert.deepEqual(store.load(accountId), original);
  }
  const anotherAccount = store.freeze(
    attempt({ accountId: otherId, desired: false }),
  );
  assert.equal(anotherAccount.accountId, otherId);
  assert.deepEqual(store.load(accountId), original);
});

test('both applied and rejected receipts require full frozen target identity before releasing the journal', () => {
  for (const outcome of ['applied', 'rejected'] as const) {
    const storage = new MemoryStorage(),
      store = new PendingSavedStore(storage, 'origin');
    const frozen = store.freeze(
      attempt({ operation: 'set_post_update_preference', channel: 'saved' }),
    );
    const result: SavedReceipt =
      outcome === 'applied'
        ? receipt(frozen)
        : { ...receipt(frozen), outcome, code: 'POST_NOT_FOUND' };
    for (const bad of [
      { ...result, requestId: otherId },
      { ...result, postId: otherId },
      { ...result, desired: false },
      { ...result, channel: 'external' as const },
      { ...result, operation: 'set_post_saved' as const, channel: null },
      { ...result, saveCount: 3 },
    ]) {
      assert.throws(() => store.settle(frozen, bad), { kind: 'protocol' });
      assert.deepEqual(store.load(accountId), frozen);
    }
    assert.deepEqual(store.settle(frozen, result), result);
    assert.equal(store.load(accountId), null);
  }
});

test('settled A cannot clear or overwrite newer opposite B across process restarts', () => {
  const storage = new MemoryStorage(),
    first = new PendingSavedStore(storage, 'origin');
  const a = first.freeze(attempt());
  new PendingSavedStore(storage, 'origin').settle(a, receipt(a));
  const restarted = new PendingSavedStore(storage, 'origin');
  const b = restarted.freeze(
    attempt({ desired: false, clientRequestId: otherId }),
  );
  assert.throws(() => first.settle(a, receipt(a)), { kind: 'storage' });
  assert.deepEqual(restarted.load(accountId), b);
  assert.throws(() => restarted.settle(b, receipt(a)), { kind: 'protocol' });
  assert.deepEqual(restarted.load(accountId), b);
  restarted.settle(b, receipt(b));
  assert.equal(first.load(accountId), null);
});

test('corruption and failed or dishonest persistence fail closed without deleting unconfirmed state', () => {
  for (const patch of [
    { accountId: otherId },
    { version: 2 },
    { postId: 'invalid' },
    { desired: 'true' },
    { channel: 'saved' },
    { expiresAt: 0 },
    { operation: 'publish_post' },
    { clientRequestId: 'bad' },
  ]) {
    const storage = new MemoryStorage(),
      store = new PendingSavedStore(storage, 'origin');
    store.freeze(attempt());
    const key = [...storage.data.keys()][0]!;
    const corrupted = { ...attempt(), ...patch };
    storage.data.set(key, corrupted);
    assert.throws(() => store.load(accountId), { kind: 'storage' });
    assert.throws(() => store.freeze(attempt()), { kind: 'storage' });
    assert.deepEqual(storage.data.get(key), corrupted);
  }
  const storage = new MemoryStorage(),
    store = new PendingSavedStore(storage, 'origin');
  storage.failWrite = true;
  assert.throws(() => store.freeze(attempt()), { kind: 'storage' });
  assert.equal(store.load(accountId), null);
  const dropped = new PendingSavedStore(
    { get: () => undefined, set: () => undefined, remove: () => undefined },
    'origin',
  );
  assert.throws(() => dropped.freeze(attempt()), { kind: 'storage' });
  assert.throws(() => store.load('invalid'), { kind: 'storage' });
});

test('failed removal or a stale settler retains the recovery barrier and never frees a different intent', () => {
  const storage = new MemoryStorage(),
    store = new PendingSavedStore(storage, 'origin');
  const frozen = store.freeze(attempt());
  storage.failRemove = true;
  assert.throws(() => store.settle(frozen, receipt()), { kind: 'storage' });
  assert.deepEqual(store.load(accountId), frozen);
  const dishonest = new PendingSavedStore(
    {
      get: (key) => storage.get(key),
      set: (key, value) => storage.set(key, value),
      remove: () => undefined,
    },
    'origin',
  );
  assert.throws(() => dishonest.settle(frozen, receipt()), { kind: 'storage' });
  assert.deepEqual(store.load(accountId), frozen);
  storage.failRemove = false;
  store.settle(frozen, receipt());
  assert.throws(() => store.settle(frozen, receipt()), { kind: 'storage' });
});

test('Saved restart journal rejects noncanonical UUID input and malformed terminal coercion cannot settle it', () => {
  const storage = new MemoryStorage(),
    store = new PendingSavedStore(storage, 'origin');
  const lowerPost = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const lowerRequest = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  assert.throws(
    () =>
      store.freeze(
        attempt({
          postId: lowerPost.toUpperCase(),
          clientRequestId: lowerRequest,
        }),
      ),
    { kind: 'storage' },
  );
  assert.throws(
    () =>
      store.freeze(
        attempt({
          postId: lowerPost,
          clientRequestId: lowerRequest.toUpperCase(),
        }),
      ),
    { kind: 'storage' },
  );
  assert.equal(store.load(accountId), null);
  const frozen = store.freeze(
    attempt({ postId: lowerPost, clientRequestId: lowerRequest }),
  );
  const restarted = new PendingSavedStore(storage, 'origin');
  assert.deepEqual(restarted.load(accountId), frozen);
  for (const outcome of [['applied'], { toString: () => 'applied' }]) {
    assert.throws(
      () =>
        restarted.settle(frozen, {
          ...receipt(frozen),
          outcome,
        } as unknown as SavedReceipt),
      { kind: 'protocol' },
    );
    assert.deepEqual(restarted.load(accountId), frozen);
  }
  restarted.settle(frozen, receipt(frozen));
  assert.equal(restarted.load(accountId), null);
});
