import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DraftStore,
  PendingAttemptStore,
  type PendingAttempt,
} from '../src/community/pending-attempt';
import { MemoryStorage } from './helpers';
import { wireCredentials } from './identity-helpers';
import { intent, otherId, receipt } from './community-helpers';
const accountId = wireCredentials().accountId;
const attempt = (): PendingAttempt => ({
  version: 1,
  accountId,
  operation: 'publish_post',
  payload: intent(),
});
test('pending attempts persist separately from drafts and cannot be replaced across operation or payload', () => {
  const storage = new MemoryStorage(),
    store = new PendingAttemptStore(storage, 'origin'),
    drafts = new DraftStore(storage, 'origin');
  drafts.save(accountId, `post:${intent().spaceId}:discussion`, {
    version: 1,
    text: 'editable draft',
    authorMode: 'named',
    commentsPolicy: 'open',
  });
  const frozen = store.freeze(attempt());
  assert.equal(Object.isFrozen(frozen.payload), true);
  assert.equal(storage.data.size, 2);
  assert.deepEqual(store.load(accountId), attempt());
  assert.throws(() =>
    store.freeze({ ...attempt(), payload: intent({ text: 'changed' }) }),
  );
  assert.throws(() =>
    store.freeze({
      version: 1,
      accountId,
      operation: 'publish_comment',
      postId: otherId,
      payload: {
        clientRequestId: intent().clientRequestId,
        text: 'comment',
        imageAssetIds: [],
        authorMode: 'named',
      },
    }),
  );
  assert.deepEqual(store.freeze(attempt()), attempt());
  assert.equal(
    new PendingAttemptStore(storage, 'different-origin').load(accountId),
    null,
  );
  assert.equal(store.load(otherId), null);
});
test('pending storage readback failures or corruption block dispatch without discarding uncertain data', () => {
  const storage = new MemoryStorage(),
    store = new PendingAttemptStore(storage, 'origin');
  storage.failWrite = true;
  assert.throws(() => store.freeze(attempt()));
  storage.failWrite = false;
  store.freeze(attempt());
  const key = [...storage.data.keys()][0]!;
  storage.data.set(key, { ...attempt(), accountId: otherId });
  assert.throws(() => store.load(accountId));
  assert.equal(storage.data.has(key), true);
  const drops = new PendingAttemptStore(
    { get: () => undefined, set: () => undefined, remove: () => undefined },
    'origin',
  );
  assert.throws(() => drops.freeze(attempt()));
});
test('only exact terminal receipt removes pending; storage removal failures keep recovery protection', () => {
  const storage = new MemoryStorage(),
    store = new PendingAttemptStore(storage, 'origin'),
    frozen = store.freeze(attempt());
  assert.throws(() =>
    store.settle(frozen, receipt({ operation: 'publish_comment' })),
  );
  assert.ok(store.load(accountId));
  storage.failRemove = true;
  assert.throws(() => store.settle(frozen, receipt()));
  assert.ok(store.load(accountId));
  storage.failRemove = false;
  store.settle(frozen, receipt());
  assert.equal(store.load(accountId), null);
});
test('all categories, including deep_sea, have separate valid account-scoped draft keys', () => {
  const storage = new MemoryStorage(),
    drafts = new DraftStore(storage, 'origin');
  for (const category of [
    'discussion',
    'confession',
    'companions',
    'pets',
    'internships',
    'scenery',
    'dorms',
    'research',
    'deep_sea',
  ]) {
    const target = `post:${intent().spaceId}:${category}`;
    drafts.save(accountId, target, {
      version: 1,
      text: category,
      authorMode: 'anonymous',
      commentsPolicy: 'open',
    });
    assert.equal(drafts.load(accountId, target)?.text, category);
  }
  assert.equal(storage.data.size, 9);
});
