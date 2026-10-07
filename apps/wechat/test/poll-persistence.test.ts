import assert from 'node:assert/strict';
import test from 'node:test';
import { PendingBallotStore } from '../src/community/poll-pending';
import { PendingAttemptStore } from '../src/community/pending-attempt';
import { MemoryStorage } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  ballotReceipt,
  intent,
  optionOne,
  optionTwo,
  otherId,
  postId,
  requestId,
} from './community-helpers';
const accountId = wireCredentials().accountId;
const attempt = () => ({
  version: 1 as const,
  accountId,
  postId,
  payload: { clientRequestId: requestId, optionIds: [optionTwo, optionOne] },
});
test('ballot pending namespace is origin/account isolated and independent of publication recovery', () => {
  const storage = new MemoryStorage(),
    store = new PendingBallotStore(storage, 'origin');
  const frozen = store.freeze(attempt());
  assert.deepEqual(frozen.payload.optionIds, [optionOne, optionTwo]);
  assert.equal(Object.isFrozen(frozen.payload.optionIds), true);
  new PendingAttemptStore(storage, 'origin').freeze({
    version: 1,
    accountId,
    operation: 'publish_post',
    payload: intent(),
  });
  assert.equal(storage.data.size, 2);
  assert.equal(
    new PendingBallotStore(storage, 'elsewhere').load(accountId),
    null,
  );
  assert.equal(store.load(otherId), null);
  assert.throws(() => store.freeze({ ...attempt(), postId: otherId }));
  assert.throws(() =>
    store.freeze({
      ...attempt(),
      payload: { clientRequestId: requestId, optionIds: [optionOne] },
    }),
  );
  assert.throws(() =>
    store.settle(frozen, ballotReceipt({ requestId: otherId })),
  );
  assert.ok(store.load(accountId));
  store.settle(frozen, ballotReceipt());
  assert.equal(store.load(accountId), null);
  assert.ok(new PendingAttemptStore(storage, 'origin').load(accountId));
});
test('corrupt, unverified readback and removal failures retain barriers and never overwrite uncertain intent', () => {
  const storage = new MemoryStorage(),
    store = new PendingBallotStore(storage, 'origin');
  const frozen = store.freeze(attempt());
  storage.failRemove = true;
  assert.throws(() => store.settle(frozen, ballotReceipt()));
  assert.ok(store.load(accountId));
  storage.failRemove = false;
  const key = [...storage.data.keys()][0]!;
  storage.data.set(key, { ...frozen, accountId: otherId });
  assert.throws(() => store.load(accountId));
  assert.throws(() => store.freeze(attempt()));
  assert.equal(storage.data.has(key), true);
  const drops = new PendingBallotStore(
    { get: () => undefined, set: () => undefined, remove: () => undefined },
    'origin',
  );
  assert.throws(() => drops.freeze(attempt()));
});
