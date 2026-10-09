import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeRatingTargetCreationIntent,
  decodeRatingTargetCreationReceipt,
  decodeRatingTargetPreparation,
} from '../src/ratings/management-contract';
import { PendingRatingStore, type PendingRating } from '../src/ratings/pending';
import { MemoryStorage } from './helpers';
import { wireCredentials } from './identity-helpers';
import { intent, receipt, otherId } from './ratings-helpers';
import { replyIntent, replyReceipt } from './ratings-r2a-helpers';
import { subscriptionIntent, subscriptionReceipt } from './ratings-r2c-helpers';
import { adminIntent, adminReceipt } from './ratings-r3a-helpers';
import {
  creationIntent,
  creationReceipt,
  preparation,
} from './ratings-management-helpers';
const accountId = wireCredentials().accountId;
test('creation contracts normalize Unicode and reject injected authority/assets and unsupported receipts', () => {
  const raw = creationIntent();
  const valid = decodeRatingTargetCreationIntent({
    ...raw,
    payload: { ...raw.payload, name: ' 🌊\r\n鲸 ', description: ' ' },
  });
  assert.equal(valid.payload.name, '🌊\n鲸');
  for (const patch of [
    { creatorId: accountId },
    { accepted: true },
    { source: 'new_native' },
    { assetIds: [otherId] },
    { name: '🌊'.repeat(101) },
    { name: '\ud800' },
    { description: 'a'.repeat(501) },
  ])
    assert.throws(() =>
      decodeRatingTargetCreationIntent({
        ...raw,
        payload: { ...raw.payload, ...patch },
      }),
    );
  assert.deepEqual(decodeRatingTargetPreparation(preparation()), preparation());
  assert.throws(() =>
    decodeRatingTargetPreparation({ ...preparation(), name: 'private' }),
  );
  assert.deepEqual(
    decodeRatingTargetCreationReceipt(creationReceipt()),
    creationReceipt(),
  );
  assert.throws(() =>
    decodeRatingTargetCreationReceipt({
      ...creationReceipt(),
      outcome: 'noop',
    }),
  );
  assert.throws(() =>
    decodeRatingTargetCreationReceipt({
      requestId: raw.payload.clientRequestId,
      operation: 'create_target',
      outcome: 'rejected',
      code: 'RATING_UNAVAILABLE',
    }),
  );
});
test('v5 shares original slot with v1–v4 without changing their stored payloads', () => {
  const old: Array<
    [
      PendingRating,
      (
        | ReturnType<typeof receipt>
        | ReturnType<typeof replyReceipt>
        | ReturnType<typeof subscriptionReceipt>
        | ReturnType<typeof adminReceipt>
      ),
    ]
  > = [
    [{ version: 1, accountId, intent: intent() }, receipt()],
    [{ version: 2, accountId, intent: replyIntent() }, replyReceipt()],
    [
      { version: 3, accountId, intent: subscriptionIntent() },
      subscriptionReceipt(),
    ],
    [{ version: 4, accountId, intent: adminIntent() }, adminReceipt()],
  ];
  for (const [attempt, result] of old) {
    const storage = new MemoryStorage(),
      store = new PendingRatingStore(storage, 'origin');
    const fresh = { version: 5 as const, accountId, intent: creationIntent() };
    store.freeze(attempt);
    assert.deepEqual(store.load(accountId), attempt);
    assert.throws(() => store.freeze(fresh));
    store.settle(attempt, result);
    store.freeze(fresh);
    assert.throws(() => store.freeze(attempt));
    assert.deepEqual(store.load(accountId), fresh);
    assert.throws(() =>
      store.settle(fresh, { ...creationReceipt(), requestId: otherId }),
    );
    assert.deepEqual(store.load(accountId), fresh);
    store.settle(fresh, creationReceipt());
    assert.equal(store.load(accountId), null);
  }
});

test('durable rejected receipts are closed, minimal and exact-key matched before releasing v5', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'origin');
  const attempt = { version: 5 as const, accountId, intent: creationIntent() };
  for (const code of [
    'RATING_CREATION_CONTEXT_CHANGED',
    'CONTENT_REJECTED',
    'RATING_CREATION_CANCELLED',
  ] as const) {
    const result = {
      requestId: attempt.intent.payload.clientRequestId,
      operation: 'create_target' as const,
      outcome: 'rejected' as const,
      code,
    };
    assert.deepEqual(decodeRatingTargetCreationReceipt(result), result);
    assert.throws(() =>
      decodeRatingTargetCreationReceipt({ ...result, targetId: otherId }),
    );
    store.freeze(attempt);
    assert.throws(() =>
      store.settle(attempt, { ...result, requestId: otherId }),
    );
    assert.deepEqual(store.load(accountId), attempt);
    store.settle(attempt, result);
    assert.equal(store.load(accountId), null);
  }
});
