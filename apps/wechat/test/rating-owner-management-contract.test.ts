import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeRatingTargetOwnerDeletionContext,
  decodeRatingTargetOwnerDeletionIntent,
  decodeRatingTargetOwnerDeletionLocator,
  decodeRatingTargetOwnerDeletionReceipt,
  matchRatingTargetOwnerDeletionReceipt,
  ratingTargetOwnerDeletionRejections,
} from '../src/ratings/target-owner-deletion-contract';
import {
  PendingRatingStore,
  type PendingRating,
  type RatingCommandReceipt,
  ratingIntentTarget,
} from '../src/ratings/pending';
import { MemoryStorage } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  intent,
  receipt,
  otherId,
  targetId,
  revision,
} from './ratings-helpers';
import { replyIntent, replyReceipt } from './ratings-r2a-helpers';
import { subscriptionIntent, subscriptionReceipt } from './ratings-r2c-helpers';
import { adminIntent, adminReceipt } from './ratings-r3a-helpers';
import { creationIntent, creationReceipt } from './ratings-management-helpers';
import {
  ownerContext,
  ownerIntent,
  ownerReceipt,
  cancelledReceipt,
} from './rating-owner-management-helpers';
const accountId = wireCredentials().accountId;
const fresh = () => ({ version: 6 as const, accountId, intent: ownerIntent() });
test('owner deletion context, locator and intent are exact and contain no identity, region or hidden text', () => {
  assert.deepEqual(
    decodeRatingTargetOwnerDeletionContext(ownerContext()),
    ownerContext(),
  );
  assert.deepEqual(decodeRatingTargetOwnerDeletionLocator({ targetId }), {
    targetId,
  });
  assert.deepEqual(
    decodeRatingTargetOwnerDeletionIntent(ownerIntent()),
    ownerIntent(),
  );
  assert.equal(ratingIntentTarget(ownerIntent()), targetId);
  for (const key of [
    'name',
    'description',
    'creatorId',
    'regionId',
    'source',
    'origin',
    'campusId',
    'review',
    'count',
    'parentId',
    'descendants',
    'active',
  ]) {
    assert.throws(() =>
      decodeRatingTargetOwnerDeletionContext({
        ...ownerContext(),
        [key]: 'private',
      }),
    );
    assert.throws(() =>
      decodeRatingTargetOwnerDeletionIntent({
        ...ownerIntent(),
        payload: { ...ownerIntent().payload, [key]: 'private' },
      }),
    );
    assert.throws(() =>
      decodeRatingTargetOwnerDeletionLocator({ targetId, [key]: 'private' }),
    );
  }
  for (const deletion of [
    { kind: 'hidden' },
    { kind: 'owner_deleted', name: 'private' },
    true,
    null,
  ])
    assert.throws(() =>
      decodeRatingTargetOwnerDeletionContext({ ...ownerContext(), deletion }),
    );
  for (const payload of [
    { ...ownerIntent().payload, targetId: 'invalid' },
    { targetId, expectedTargetRevision: revision },
  ])
    assert.throws(() =>
      decodeRatingTargetOwnerDeletionIntent({
        operation: 'delete_target',
        payload,
      }),
    );
  assert.throws(() =>
    decodeRatingTargetOwnerDeletionIntent({
      ...ownerIntent(),
      operation: 'admin_delete_target',
    }),
  );
});
test('receipts permit only durable outcomes and bind request, operation, target and CAS semantics', () => {
  for (const outcome of ['applied', 'noop'] as const) {
    const value = ownerReceipt(outcome);
    assert.deepEqual(decodeRatingTargetOwnerDeletionReceipt(value), value);
    matchRatingTargetOwnerDeletionReceipt(ownerIntent(), value);
    for (const patch of [
      { targetId: otherId },
      { requestId: otherId },
      { revision: outcome === 'applied' ? revision : otherId },
    ])
      assert.throws(() =>
        matchRatingTargetOwnerDeletionReceipt(ownerIntent(), {
          ...value,
          ...patch,
        }),
      );
  }
  for (const code of ratingTargetOwnerDeletionRejections) {
    const value = {
      requestId: ownerIntent().payload.clientRequestId,
      operation: 'delete_target',
      outcome: 'rejected',
      code,
    };
    assert.deepEqual(decodeRatingTargetOwnerDeletionReceipt(value), value);
    for (const extra of [{ targetId }, { name: 'private' }, { regionId: null }])
      assert.throws(() =>
        decodeRatingTargetOwnerDeletionReceipt({ ...value, ...extra }),
      );
  }
  for (const code of [
    'RATING_UNAVAILABLE',
    'CONTENT_REVIEW_UNAVAILABLE',
    'SAFETY_UNAVAILABLE',
    'REQUEST_NOT_FOUND',
  ])
    assert.throws(() =>
      decodeRatingTargetOwnerDeletionReceipt({ ...cancelledReceipt(), code }),
    );
  assert.throws(() =>
    decodeRatingTargetOwnerDeletionReceipt({
      ...ownerReceipt(),
      operation: 'create_target',
    }),
  );
  assert.throws(() =>
    decodeRatingTargetOwnerDeletionReceipt({
      ...ownerReceipt(),
      name: 'private',
    }),
  );
});
test('v6 shares the original slot with every unchanged v1–v5 journal and preserves original bytes', () => {
  const older: Array<[PendingRating, RatingCommandReceipt]> = [
    [{ version: 1, accountId, intent: intent() }, receipt()],
    [{ version: 2, accountId, intent: replyIntent() }, replyReceipt()],
    [
      { version: 3, accountId, intent: subscriptionIntent() },
      subscriptionReceipt(),
    ],
    [{ version: 4, accountId, intent: adminIntent() }, adminReceipt()],
    [{ version: 5, accountId, intent: creationIntent() }, creationReceipt()],
  ];
  for (const [old, result] of older) {
    const storage = new MemoryStorage(),
      store = new PendingRatingStore(storage, 'origin');
    const key = `whaleu.ratings.pending.v${old.version}:origin:${accountId}`;
    store.freeze(old);
    const bytes = JSON.stringify(storage.get(key));
    assert.throws(() => store.freeze(fresh()));
    assert.deepEqual(store.load(accountId), old);
    assert.equal(JSON.stringify(storage.get(key)), bytes);
    store.settle(old, result);
    store.freeze(fresh());
    assert.throws(() => store.freeze(old));
    assert.deepEqual(store.load(accountId), fresh());
    store.settle(fresh(), ownerReceipt());
    assert.equal(store.load(accountId), null);
  }
});
test('corrupt journals, changed intent and wrong receipts cannot free or replace v6', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'origin');
  store.freeze(fresh());
  assert.throws(() =>
    store.freeze({
      ...fresh(),
      intent: {
        ...ownerIntent(),
        payload: { ...ownerIntent().payload, expectedTargetRevision: otherId },
      },
    }),
  );
  assert.throws(() =>
    store.settle(fresh(), { ...ownerReceipt(), requestId: otherId }),
  );
  assert.throws(() => store.settle(fresh(), creationReceipt()));
  assert.deepEqual(store.load(accountId), fresh());
  storage.set(`whaleu.ratings.pending.v6:origin:${accountId}`, {
    ...fresh(),
    version: 5,
  });
  assert.throws(() => store.load(accountId));
  assert.throws(() =>
    store.freeze({ version: 1, accountId, intent: intent() }),
  );
});
test('v6 failed removal or settle readback restores the only immutable recovery key', () => {
  class ReadbackFailure extends MemoryStorage {
    failNextRead = false;
    override remove(key: string) {
      super.remove(key);
      this.failNextRead = true;
    }
    override get(key: string): unknown {
      if (this.failNextRead) {
        this.failNextRead = false;
        throw new Error('readback failed');
      }
      return super.get(key);
    }
  }
  for (const storage of [new MemoryStorage(), new ReadbackFailure()]) {
    const store = new PendingRatingStore(storage, 'origin');
    store.freeze(fresh());
    if (!(storage instanceof ReadbackFailure)) storage.failRemove = true;
    assert.throws(() => store.settle(fresh(), ownerReceipt()));
    assert.deepEqual(store.load(accountId), fresh());
  }
});
