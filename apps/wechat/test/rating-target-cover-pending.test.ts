import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PendingRatingStore,
  type PendingRating,
  type RatingCommandReceipt,
} from '../src/ratings/pending';
import { decodeRatingTargetCoverIntent } from '../src/ratings/target-cover-contract';
import { MemoryStorage } from './helpers';
import { accountId } from './identity-helpers';
import { intent, receipt } from './ratings-helpers';
import { replyIntent, replyReceipt } from './ratings-r2a-helpers';
import { subscriptionIntent, subscriptionReceipt } from './ratings-r2c-helpers';
import { adminIntent, adminReceipt } from './ratings-r3a-helpers';
import { creationIntent, creationReceipt } from './ratings-management-helpers';
import { ownerIntent, ownerReceipt } from './rating-owner-management-helpers';
import { editingIntent, editingReceipt } from './rating-owner-editing-helpers';
import {
  categoryCreationIntent,
  categoryCreationReceipt,
} from './category-management-helpers';
import { scopedIntent, scopedReceipt } from './rating-scoped-helpers';
import { managementIntent, managementReceipt } from './category-scoped-helpers';
function oldVersions(): readonly [PendingRating, RatingCommandReceipt][] {
  return [
    [{ version: 1, accountId, intent: intent() }, receipt()],
    [{ version: 2, accountId, intent: replyIntent() }, replyReceipt()],
    [
      { version: 3, accountId, intent: subscriptionIntent() },
      subscriptionReceipt(),
    ],
    [{ version: 4, accountId, intent: adminIntent() }, adminReceipt()],
    [{ version: 5, accountId, intent: creationIntent() }, creationReceipt()],
    [{ version: 6, accountId, intent: ownerIntent() }, ownerReceipt()],
    [{ version: 7, accountId, intent: editingIntent() }, editingReceipt()],
    [
      { version: 8, accountId, intent: categoryCreationIntent() },
      categoryCreationReceipt(),
    ],
    [{ version: 9, accountId, intent: scopedIntent() }, scopedReceipt()],
    [
      { version: 10, accountId, intent: managementIntent() },
      managementReceipt(),
    ],
  ];
}
function current(): PendingRating {
  const previous = scopedIntent('create_target_scoped');
  return {
    version: 11,
    accountId,
    intent: decodeRatingTargetCoverIntent({
      protocolVersion: 3,
      operation: previous.operation,
      context: previous.context,
      payload: {
        clientRequestId: previous.payload.clientRequestId,
        categoryId: previous.payload.categoryId,
        expectedCategoryRevision: previous.payload.expectedCategoryRevision,
        name: 'Cover target',
        description: '',
        cover: { action: 'clear' },
      },
    }),
  };
}
test('journal 1–10 original bytes and receipt recovery stay prior to journal 11 admission', () => {
  for (const [old, result] of oldVersions()) {
    const storage = new MemoryStorage(),
      store = new PendingRatingStore(storage, 'cover');
    const key = `whaleu.ratings.pending.v${old.version}:cover:${accountId}`;
    store.freeze(old);
    const bytes = JSON.stringify(storage.get(key));
    assert.throws(() => store.freeze(current()), { kind: 'storage' });
    assert.equal(JSON.stringify(storage.get(key)), bytes);
    assert.deepEqual(store.settle(old, result), result);
    const fresh = store.freeze(current());
    assert.throws(() => store.freeze(old), { kind: 'storage' });
    assert.deepEqual(store.load(accountId), fresh);
  }
});
test('original legacy receipt remains recoverable ahead of a corrupt later slot; new admission still checks every slot', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'cover');
  const [old, result] = oldVersions()[0]!;
  store.freeze(old);
  storage.set(`whaleu.ratings.pending.v11:cover:${accountId}`, {
    invalid: true,
  });
  assert.deepEqual(store.load(accountId), old);
  assert.throws(() => store.freeze(old), { kind: 'storage' });
  assert.deepEqual(store.settle(old, result), result);
  assert.throws(() => store.load(accountId), { kind: 'storage' });
});
