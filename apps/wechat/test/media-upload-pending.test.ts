import assert from 'node:assert/strict';
import test from 'node:test';
import { PendingMediaStore } from '../src/media/pending';
import { MemoryStorage } from './helpers';
import {
  bound,
  hash,
  ids,
  notRecorded,
  origin,
  prepare,
  prepared,
  recovery,
  terminal,
} from './support/media-upload-fixtures';

test('journal is normalized-origin/original-actor scoped with exact byte identity and no plaintext content/path/credential', () => {
  const storage = new MemoryStorage(),
    a = new PendingMediaStore(storage, 'HTTPS://MEDIA-UPLOAD.INVALID/');
  const record = a.freeze(ids.actor, prepare, 1000);
  const serialized = JSON.stringify(record);
  for (const forbidden of [
    'filePath',
    'localId',
    'accessToken',
    'refreshToken',
    'grantId',
    'imageBytes',
    'base64',
    'text',
    'url',
  ])
    assert.equal(serialized.includes(`"${forbidden}"`), false);
  assert.equal(record.requestHash, hash);
  assert.equal(
    new PendingMediaStore(storage, origin).load(ids.actor)?.clientRequestId,
    ids.request,
  );
  assert.equal(a.load(ids.other), null);
  assert.equal(
    new PendingMediaStore(storage, 'https://other.invalid').load(ids.actor),
    null,
  );
  assert.throws(() =>
    a.freeze(ids.actor, { ...prepare, clientRequestId: ids.other }, 1000),
  );
  assert.equal(a.load(ids.actor)?.clientRequestId, ids.request);
});
test('write failure/readback mismatch/corruption keep the original unresolved key and fail closed', () => {
  const storage = new MemoryStorage(),
    store = new PendingMediaStore(storage, origin);
  storage.failWrite = true;
  assert.throws(() => store.freeze(ids.actor, prepare, 1000));
  assert.equal(storage.data.size, 0);
  storage.failWrite = false;
  const record = store.freeze(ids.actor, prepare, 1000),
    key = [...storage.data.keys()][0]!;
  storage.data.set(key, { ...record, filePath: 'wxfile://tmp/forbidden' });
  assert.throws(() => store.load(ids.actor));
  assert.throws(() => store.freeze(ids.actor, prepare, 1000));
  assert.equal(storage.data.size, 1);
  storage.data.set(key, '');
  assert.throws(() => store.load(ids.actor));
  const dishonest = new MemoryStorage();
  dishonest.set = () => undefined;
  assert.throws(() =>
    new PendingMediaStore(dishonest, origin).freeze(ids.actor, prepare, 1000),
  );
});
test('full-value revision CAS blocks stale callbacks, changed hash, scope and actor', () => {
  const storage = new MemoryStorage(),
    store = new PendingMediaStore(storage, origin),
    first = store.freeze(ids.actor, prepare, 1000);
  const next = store.update(first, {
    intentId: ids.intent,
    phase: 'prepared',
    lastObservedAt: 1001,
  });
  assert.equal(next.revision, 2);
  assert.throws(() => store.update(first, { phase: 'cancel_uncertain' }));
  assert.throws(() => store.update(next, { intentId: ids.other }));
  assert.throws(() =>
    store.assertStored({ ...next, requestHash: 'b'.repeat(64) }),
  );
  assert.equal(store.load(ids.actor)?.revision, 2);
});
test('not_recorded, active and elapsed hints never settle; server terminal or bound history can', () => {
  const storage = new MemoryStorage(),
    store = new PendingMediaStore(storage, origin);
  const record = store.freeze(ids.actor, prepare, 1000);
  assert.throws(() => store.settle(record, notRecorded));
  assert.throws(() => store.settle(record, recovery(prepared())));
  assert.throws(() =>
    store.settle(record, { ...terminal(), requestHash: 'b'.repeat(64) }),
  );
  storage.failRemove = true;
  assert.throws(() => store.settle(record, terminal()));
  assert.ok(store.load(ids.actor));
  storage.failRemove = false;
  store.settle(record, terminal());
  assert.equal(store.load(ids.actor), null);
  const again = store.freeze(ids.actor, prepare, 1000);
  store.settle(again, bound());
  assert.equal(store.load(ids.actor), null);
});
test('only durable publication pointer is accepted, and no publication content is copied', () => {
  const store = new PendingMediaStore(new MemoryStorage(), origin);
  const first = store.freeze(ids.actor, prepare, 1000);
  assert.throws(() => store.update(first, { phase: 'publication_uncertain' }));
  const ready = store.update(first, {
    intentId: ids.intent,
    assetId: ids.asset,
    phase: 'ready_hint',
  });
  const linked = store.update(ready, {
    phase: 'publication_uncertain',
    publication: {
      clientRequestId: ids.publication,
      operation: 'publish_post',
      intentHash: 'b'.repeat(64),
    },
  });
  assert.deepEqual(Object.keys(linked.publication!), [
    'clientRequestId',
    'operation',
    'intentHash',
  ]);
  assert.throws(() =>
    store.update(linked, {
      publication: {
        clientRequestId: ids.other,
        operation: 'publish_post',
        intentHash: 'b'.repeat(64),
      },
    }),
  );
});
