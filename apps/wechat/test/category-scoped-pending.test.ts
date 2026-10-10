import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PendingRatingStore,
  type PendingRating,
  type RatingCommandReceipt,
} from '../src/ratings/pending';
import { runRatingCommand } from '../src/ratings/commands';
import { Cancellation } from '../src/platform/contracts';
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
import {
  categoryScopedHarness,
  managementIntent,
  managementReceipt,
} from './category-scoped-helpers';
const key = (version: number) =>
  `whaleu.ratings.pending.v${version}:management:${accountId}`;
const current = (): PendingRating => ({
  version: 10,
  accountId,
  intent: managementIntent(),
});
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
  ];
}
test('every original v1–v9 journal retains exact bytes and blocks v10; v10 blocks every older writer', () => {
  for (const [old, result] of oldVersions()) {
    const storage = new MemoryStorage(),
      store = new PendingRatingStore(storage, 'management');
    store.freeze(old);
    const bytes = JSON.stringify(storage.get(key(old.version)));
    assert.throws(() => store.freeze(current()), { kind: 'storage' });
    assert.equal(JSON.stringify(storage.get(key(old.version))), bytes);
    assert.equal(storage.get(key(10)), undefined);
    assert.deepEqual(store.settle(old, result), result);
    store.freeze(current());
    const currentBytes = JSON.stringify(storage.get(key(10)));
    assert.throws(() => store.freeze(old), { kind: 'storage' });
    assert.equal(JSON.stringify(storage.get(key(10))), currentBytes);
    assert.deepEqual(
      store.settle(current(), managementReceipt()),
      managementReceipt(),
    );
    assert.equal(store.load(accountId), null);
  }
});
test('v10 never reinterprets v9, silently canonicalizes a journal or allows hidden later-slot corruption', () => {
  for (const invalid of [
    { ...current(), version: 9 },
    { ...current(), intent: scopedIntent() },
    { ...current(), accepted: true },
    {
      ...current(),
      intent: {
        ...managementIntent(),
        payload: { ...managementIntent().payload, expectedSnapshot: 'invalid' },
      },
    },
  ]) {
    const storage = new MemoryStorage(),
      store = new PendingRatingStore(storage, 'management');
    storage.set(key(10), invalid);
    const bytes = JSON.stringify(storage.get(key(10)));
    assert.throws(() => store.load(accountId), { kind: 'storage' });
    assert.throws(() => store.freeze(current()), { kind: 'storage' });
    assert.equal(JSON.stringify(storage.get(key(10))), bytes);
  }
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'management'),
    old = oldVersions()[0]![0];
  storage.set(key(1), old);
  storage.set(key(10), { corrupt: true });
  assert.deepEqual(store.load(accountId), old);
  const bytes = JSON.stringify([...storage.data]);
  assert.throws(() => store.freeze(old), { kind: 'storage' });
  assert.equal(JSON.stringify([...storage.data]), bytes);
});
test('wrong operation, request or hash cannot settle v10; terminal cancellation is allowed without current context', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'management');
  store.freeze(current());
  const bytes = JSON.stringify(storage.get(key(10)));
  for (const result of [
    scopedReceipt(),
    managementReceipt(managementIntent('set_category_visibility_scoped')),
    { ...managementReceipt(), intentHash: 'f'.repeat(64) },
  ]) {
    assert.throws(() => store.settle(current(), result), { kind: 'protocol' });
    assert.equal(JSON.stringify(storage.get(key(10))), bytes);
  }
  store.settle(current(), managementReceipt(undefined, 'closed'));
  assert.equal(store.load(accountId), null);
});
test('remove/readback failure restores exactly the immutable v10 original', () => {
  class ReadbackFailure extends MemoryStorage {
    fail = false;
    override remove(key: string): void {
      super.remove(key);
      this.fail = true;
    }
    override get(key: string): unknown {
      if (this.fail) {
        this.fail = false;
        throw new Error('readback failure');
      }
      return super.get(key);
    }
  }
  for (const result of [
    managementReceipt(),
    managementReceipt(undefined, 'closed'),
  ]) {
    const storage = new ReadbackFailure(),
      store = new PendingRatingStore(storage, 'management');
    store.freeze(current());
    const bytes = JSON.stringify(storage.get(key(10)));
    assert.throws(() => store.settle(current(), result), { kind: 'storage' });
    assert.equal(JSON.stringify(storage.get(key(10))), bytes);
    assert.deepEqual(store.load(accountId), current());
  }
});
test('generic shared recovery retry only queries v10 receipts and cannot silently prepare or commit', async () => {
  const s = categoryScopedHarness(),
    attempt = s.runtime.pendingRatings!.freeze(current());
  s.gateway.receipt = async () => {
    s.calls.push('receipt');
    return managementReceipt();
  };
  await runRatingCommand(s.runtime, attempt, new Cancellation(), true);
  assert.deepEqual(s.calls, ['receipt']);
  assert.equal(s.prepared.length, 0);
  assert.equal(s.committed.length, 0);
  s.controller.dispose();
});
