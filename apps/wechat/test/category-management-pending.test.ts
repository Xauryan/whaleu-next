import assert from 'node:assert/strict';
import test from 'node:test';
import { ClientError } from '../src/api/errors';
import {
  decodeRatingCommandIntent,
  isRatingCategoryCreationIntent,
  PendingRatingStore,
  ratingIntentTarget,
  type PendingRating,
  type RatingCommandReceipt,
} from '../src/ratings/pending';
import { ratingCategoryRejections } from '../src/ratings/category-management-contract';
import { MemoryStorage } from './helpers';
import { wireCredentials } from './identity-helpers';
import {
  intent,
  receipt,
  otherId,
  regionId,
  revision,
} from './ratings-helpers';
import { replyIntent, replyReceipt } from './ratings-r2a-helpers';
import { likeIntent, likeReceipt } from './ratings-r2b-helpers';
import { subscriptionIntent, subscriptionReceipt } from './ratings-r2c-helpers';
import { adminIntent, adminReceipt } from './ratings-r3a-helpers';
import { creationIntent, creationReceipt } from './ratings-management-helpers';
import { ownerIntent, ownerReceipt } from './rating-owner-management-helpers';
import { editingIntent, editingReceipt } from './rating-owner-editing-helpers';
import {
  cancelledCategoryReceipt,
  categoryCreationIntent,
  categoryCreationReceipt,
  categoryTestId,
  existingCategoryParentId,
  existingCategoryParentRevision,
} from './category-management-helpers';

const accountId = wireCredentials().accountId;
const fresh = () => ({
  version: 8 as const,
  accountId,
  intent: categoryCreationIntent(),
});
const journalKey = `whaleu.ratings.pending.v8:origin:${accountId}`;
const keyFor = (version: number) =>
  `whaleu.ratings.pending.v${version}:origin:${accountId}`;
function olderCommands(): Array<[PendingRating, RatingCommandReceipt]> {
  return [
    [{ version: 1, accountId, intent: intent() }, receipt()],
    [
      { version: 2, accountId, intent: intent('create_comment') },
      receipt(intent('create_comment')),
    ],
    [{ version: 2, accountId, intent: replyIntent() }, replyReceipt()],
    [{ version: 2, accountId, intent: likeIntent() }, likeReceipt()],
    [
      { version: 3, accountId, intent: subscriptionIntent() },
      subscriptionReceipt(),
    ],
    [{ version: 4, accountId, intent: adminIntent() }, adminReceipt()],
    [{ version: 5, accountId, intent: creationIntent() }, creationReceipt()],
    [{ version: 6, accountId, intent: ownerIntent() }, ownerReceipt()],
    [{ version: 7, accountId, intent: editingIntent() }, editingReceipt()],
  ];
}

test('category commands have their own strict dispatch and no preexisting target locator', () => {
  assert.deepEqual(
    decodeRatingCommandIntent(categoryCreationIntent()),
    categoryCreationIntent(),
  );
  assert.equal(isRatingCategoryCreationIntent(categoryCreationIntent()), true);
  assert.equal(ratingIntentTarget(categoryCreationIntent()), '');
  for (const [old] of olderCommands()) {
    assert.equal(isRatingCategoryCreationIntent(old.intent), false);
    assert.deepEqual(decodeRatingCommandIntent(old.intent), old.intent);
  }
  assert.throws(() =>
    decodeRatingCommandIntent({
      ...categoryCreationIntent(),
      payload: {
        ...categoryCreationIntent().payload,
        expectedContextRevision: 'c'.repeat(43),
      },
    }),
  );
});

test('v8 shares one original command slot with every unchanged v1–v7 operation and preserves old bytes', () => {
  for (const [old, result] of olderCommands()) {
    const storage = new MemoryStorage(),
      store = new PendingRatingStore(storage, 'origin');
    store.freeze(old);
    const originalBytes = JSON.stringify(storage.get(keyFor(old.version)));
    assert.throws(() => store.freeze(fresh()), { kind: 'storage' });
    assert.equal(storage.get(journalKey), undefined);
    assert.deepEqual(store.load(accountId), old);
    assert.equal(
      JSON.stringify(storage.get(keyFor(old.version))),
      originalBytes,
    );
    assert.deepEqual(store.settle(old, result), result);
    store.freeze(fresh());
    const categoryBytes = JSON.stringify(storage.get(journalKey));
    assert.throws(() => store.freeze(old), { kind: 'storage' });
    assert.equal(storage.get(keyFor(old.version)), undefined);
    assert.deepEqual(store.load(accountId), fresh());
    assert.equal(JSON.stringify(storage.get(journalKey)), categoryBytes);
    assert.deepEqual(
      store.settle(fresh(), categoryCreationReceipt()),
      categoryCreationReceipt(),
    );
    assert.equal(store.load(accountId), null);
  }
});

test('recovery keeps the exact v1-through-v8 order and cannot settle a later slot ahead of the original', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'origin');
  const entries = olderCommands().filter(
    ([old], index, all) =>
      all.findIndex(([candidate]) => candidate.version === old.version) ===
      index,
  );
  entries.push([fresh(), categoryCreationReceipt()]);
  for (const [entry] of [...entries].reverse())
    storage.set(keyFor(entry.version), entry);
  const originalBytes = new Map(
    entries.map(([entry]) => [
      entry.version,
      JSON.stringify(storage.get(keyFor(entry.version))),
    ]),
  );
  assert.throws(() => store.settle(fresh(), categoryCreationReceipt()), {
    kind: 'storage',
  });
  assert.equal(JSON.stringify(storage.get(journalKey)), originalBytes.get(8));
  for (const [entry, result] of entries) {
    assert.deepEqual(store.load(accountId), entry);
    assert.equal(
      JSON.stringify(storage.get(keyFor(entry.version))),
      originalBytes.get(entry.version),
    );
    assert.deepEqual(store.settle(entry, result), result);
  }
  assert.equal(store.load(accountId), null);
  assert.equal(storage.data.size, 0);
});

test('freeze reads every journal version even when an earlier valid record masks later corruption', () => {
  for (const [old] of olderCommands()) {
    const storage = new MemoryStorage(),
      store = new PendingRatingStore(storage, 'origin');
    storage.set(keyFor(old.version), old);
    storage.set(journalKey, { corrupt: true });
    const before = JSON.stringify([...storage.data]);
    assert.deepEqual(store.load(accountId), old);
    assert.throws(() => store.freeze(old), { kind: 'storage' });
    assert.throws(() => store.freeze(fresh()), { kind: 'storage' });
    assert.equal(JSON.stringify([...storage.data]), before);
  }
  for (const version of [1, 2, 3, 4, 5, 6, 7]) {
    const storage = new MemoryStorage(),
      store = new PendingRatingStore(storage, 'origin');
    storage.set(keyFor(version), { corrupt: true });
    const bytes = JSON.stringify(storage.get(keyFor(version)));
    assert.throws(() => store.freeze(fresh()), { kind: 'storage' });
    assert.throws(() => store.load(accountId), { kind: 'storage' });
    assert.equal(storage.get(journalKey), undefined);
    assert.equal(JSON.stringify(storage.get(keyFor(version))), bytes);
  }
});

test('v8 freeze is idempotent and preserves the canonical original without preparation data', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'origin');
  const original = fresh(),
    originalBytes = JSON.stringify(original);
  const frozen = store.freeze(original);
  assert.deepEqual(store.freeze(fresh()), frozen);
  store.assertOriginal(frozen);
  assert.deepEqual(store.load(accountId), original);
  assert.equal(storage.data.size, 1);
  assert.equal(JSON.stringify(storage.get(journalKey)), originalBytes);
  assert.equal(
    JSON.stringify(storage.get(journalKey)).includes('contextRevision'),
    false,
  );
  assert.equal(
    JSON.stringify(storage.get(journalKey)).includes('releaseId'),
    false,
  );
  for (const value of [frozen, frozen.intent, frozen.intent.payload])
    assert.equal(Object.isFrozen(value), true);
  const payload = categoryCreationIntent().payload;
  const raw = {
    version: 8 as const,
    accountId,
    intent: {
      operation: 'create_categories' as const,
      payload: {
        ...payload,
        nodes: payload.nodes.map((node) => ({ ...node })),
      },
    },
  };
  const secondStorage = new MemoryStorage(),
    second = new PendingRatingStore(secondStorage, 'origin');
  second.freeze(raw);
  raw.intent.payload.nodes[0]!.name = 'Caller mutation';
  raw.intent.payload.nodes.reverse();
  raw.intent.payload.regionId = otherId;
  assert.deepEqual(second.load(accountId), fresh());
  assert.equal(JSON.stringify(secondStorage.get(journalKey)), originalBytes);
});

test('original accounts and origins remain isolated with no cross-owner settlement', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'origin');
  store.freeze(fresh());
  const bytes = JSON.stringify(storage.get(journalKey));
  assert.equal(
    new PendingRatingStore(storage, 'other-origin').load(accountId),
    null,
  );
  assert.equal(store.load(otherId), null);
  assert.throws(
    () =>
      store.settle(
        { ...fresh(), accountId: otherId },
        categoryCreationReceipt(),
      ),
    { kind: 'storage' },
  );
  assert.throws(
    () =>
      new PendingRatingStore(storage, 'other-origin').settle(
        fresh(),
        categoryCreationReceipt(),
      ),
    { kind: 'storage' },
  );
  assert.equal(JSON.stringify(storage.get(journalKey)), bytes);
  assert.equal(storage.data.size, 1);
  for (const badId of ['invalid', '', '1']) {
    assert.throws(() => store.load(badId), { kind: 'storage' });
    assert.throws(() => store.freeze({ ...fresh(), accountId: badId }), {
      kind: 'storage',
    });
  }
});

test('every original scope, parent and ordered-node field is immutable once v8 is frozen', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'origin');
  store.freeze(fresh());
  const originalBytes = JSON.stringify(storage.get(journalKey)),
    payload = categoryCreationIntent().payload;
  for (const patch of [
    { clientRequestId: otherId },
    { regionId },
    { expectedCatalogRevision: otherId },
    { expectedCatalogRevision: null },
    { expectedScopeRevision: 'z'.repeat(43) },
    {
      parentId: existingCategoryParentId,
      expectedParentRevision: existingCategoryParentRevision,
      nodes: payload.nodes.slice(0, 2),
    },
    {
      nodes: [
        { ...payload.nodes[0]!, name: 'Changed canonical text' },
        ...payload.nodes.slice(1),
      ],
    },
    {
      nodes: [
        { ...payload.nodes[0]!, description: 'Changed canonical description' },
        ...payload.nodes.slice(1),
      ],
    },
    {
      nodes: [
        payload.nodes[0]!,
        { ...payload.nodes[1]!, key: 'renamed' },
        { ...payload.nodes[2]!, parentKey: 'renamed' },
      ],
    },
    {
      nodes: [
        payload.nodes[0]!,
        payload.nodes[1]!,
        { ...payload.nodes[2]!, parentKey: 'root' },
      ],
    },
    { nodes: payload.nodes.slice(0, 2) },
    {
      nodes: [
        ...payload.nodes,
        {
          key: 'new_child',
          parentKey: 'root',
          name: 'New child',
          description: '',
        },
      ],
    },
  ]) {
    const changed = { ...fresh(), intent: categoryCreationIntent(patch) };
    assert.throws(() => store.freeze(changed), { kind: 'storage' });
    assert.throws(() => store.assertOriginal(changed), { kind: 'storage' });
    assert.equal(JSON.stringify(storage.get(journalKey)), originalBytes);
  }
});

test('malformed, cross-version, noncanonical or augmented v8 journals cannot be repaired or overwritten', () => {
  const original = fresh(),
    payload = original.intent.payload;
  const missing = Object.keys(original).map((key) => {
    const value: Record<string, unknown> = { ...original };
    delete value[key];
    return value;
  });
  for (const malformed of [
    ...missing,
    { ...original, version: 7 },
    { ...original, version: '8' },
    { ...original, accountId: otherId },
    { ...original, accountId: 'invalid' },
    { ...original, contextRevision: 'c'.repeat(43) },
    { ...original, intent: editingIntent() },
    { ...original, intent: { ...original.intent, operation: 'create_target' } },
    {
      ...original,
      intent: {
        ...original.intent,
        payload: { ...payload, expectedContextRevision: 'c'.repeat(43) },
      },
    },
    {
      ...original,
      intent: {
        ...original.intent,
        payload: {
          ...payload,
          nodes: [{ ...payload.nodes[0], name: ' leading space' }],
        },
      },
    },
    {
      ...original,
      intent: {
        ...original.intent,
        payload: {
          ...payload,
          nodes: [{ ...payload.nodes[0], description: 'first\r\nsecond' }],
        },
      },
    },
    {
      ...original,
      intent: {
        ...original.intent,
        payload: { ...payload, expectedScopeRevision: 'bad' },
      },
    },
    {
      ...original,
      intent: {
        ...original.intent,
        payload: { ...payload, parentId: existingCategoryParentId },
      },
    },
    {
      ...original,
      intent: {
        ...original.intent,
        payload: { ...payload, nodes: [...payload.nodes].reverse() },
      },
    },
    { broken: true },
    JSON.stringify(original),
    8,
    [],
  ]) {
    const storage = new MemoryStorage(),
      store = new PendingRatingStore(storage, 'origin');
    storage.set(journalKey, malformed);
    const bytes = JSON.stringify(storage.get(journalKey));
    assert.throws(() => store.load(accountId), { kind: 'storage' });
    assert.throws(() => store.freeze(fresh()), { kind: 'storage' });
    for (const [old] of olderCommands())
      assert.throws(() => store.freeze(old), { kind: 'storage' });
    assert.equal(JSON.stringify(storage.get(journalKey)), bytes);
    assert.equal(storage.data.size, 1);
  }
  for (const version of [1, 2, 3, 4, 5, 6, 7]) {
    const storage = new MemoryStorage(),
      store = new PendingRatingStore(storage, 'origin');
    storage.set(keyFor(version), { ...original, version });
    const bytes = JSON.stringify(storage.get(keyFor(version)));
    assert.throws(() => store.load(accountId), { kind: 'storage' });
    assert.throws(() => store.freeze(fresh()), { kind: 'storage' });
    assert.equal(JSON.stringify(storage.get(keyFor(version))), bytes);
  }
});

test('freeze refuses malformed originals and storage write/readback failures never acknowledge a frozen command', () => {
  for (const malformed of [
    { ...fresh(), version: 9 },
    { ...fresh(), version: 7 },
    { ...fresh(), accepted: true },
    { ...fresh(), intent: editingIntent() },
    {
      ...fresh(),
      intent: {
        ...categoryCreationIntent(),
        payload: { ...categoryCreationIntent().payload, assetIds: [otherId] },
      },
    },
  ]) {
    const storage = new MemoryStorage(),
      store = new PendingRatingStore(storage, 'origin');
    assert.throws(() => store.freeze(malformed as unknown as PendingRating), {
      kind: 'storage',
    });
    assert.equal(storage.data.size, 0);
  }
  const unwritable = new MemoryStorage();
  unwritable.failWrite = true;
  assert.throws(
    () => new PendingRatingStore(unwritable, 'origin').freeze(fresh()),
    { kind: 'storage' },
  );
  assert.equal(unwritable.data.size, 0);
  class FreezeReadbackFailure extends MemoryStorage {
    failNextRead = false;
    override set(key: string, value: unknown): void {
      super.set(key, value);
      this.failNextRead = true;
    }
    override get(key: string): unknown {
      if (this.failNextRead) {
        this.failNextRead = false;
        throw new Error('write readback failed');
      }
      return super.get(key);
    }
  }
  const storage = new FreezeReadbackFailure(),
    store = new PendingRatingStore(storage, 'origin');
  assert.throws(() => store.freeze(fresh()), { kind: 'storage' });
  assert.deepEqual(store.load(accountId), fresh());
  assert.deepEqual(storage.get(journalKey), fresh());
  assert.throws(
    () => store.freeze({ version: 1, accountId, intent: intent() }),
    { kind: 'storage' },
  );
  assert.deepEqual(store.freeze(fresh()), fresh());
});

test('silent drop or mutation by storage is caught before a new command can be acknowledged', () => {
  class SilentDrop extends MemoryStorage {
    override set(_key: string, _value: unknown): void {}
  }
  class MutatingWrite extends MemoryStorage {
    override set(key: string, value: unknown): void {
      super.set(
        key,
        key.includes('.v8:')
          ? {
              ...fresh(),
              intent: categoryCreationIntent({ clientRequestId: otherId }),
            }
          : value,
      );
    }
  }
  for (const storage of [new SilentDrop(), new MutatingWrite()]) {
    const store = new PendingRatingStore(storage, 'origin');
    assert.throws(() => store.freeze(fresh()), { kind: 'storage' });
  }
});

test('only matching applied or durable rejected receipts settle v8 and permit another command', () => {
  for (const result of [
    categoryCreationReceipt(),
    ...ratingCategoryRejections.map((code) => ({
      ...cancelledCategoryReceipt(),
      code,
    })),
  ]) {
    const storage = new MemoryStorage(),
      store = new PendingRatingStore(storage, 'origin');
    const frozen = store.freeze(fresh());
    assert.deepEqual(store.settle(frozen, result), result);
    assert.equal(store.load(accountId), null);
    assert.equal(storage.get(journalKey), undefined);
    assert.deepEqual(
      store.freeze({ version: 1, accountId, intent: intent() }),
      { version: 1, accountId, intent: intent() },
    );
  }
});

test('wrong receipt operation, key, tree, catalog or unavailable outcome preserves the only original journal', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'origin');
  store.freeze(fresh());
  const before = JSON.stringify(storage.get(journalKey)),
    result = categoryCreationReceipt();
  for (const invalid of [
    ...olderCommands().map(([, oldReceipt]) => oldReceipt),
    { ...result, requestId: otherId },
    { ...result, outcome: 'noop' },
    { ...result, categories: result.categories.slice(0, 2) },
    { ...result, categories: [...result.categories].reverse() },
    {
      ...result,
      categories: [
        { ...result.categories[0], parentId: otherId },
        ...result.categories.slice(1),
      ],
    },
    { ...result, catalogs: [{ regionId: null, catalogRevision: revision }] },
    {
      ...result,
      catalogs: [{ regionId, catalogRevision: categoryTestId(450) }],
    },
    { ...cancelledCategoryReceipt(), requestId: otherId },
    { ...cancelledCategoryReceipt(), code: 'REQUEST_NOT_FOUND' },
    { ...cancelledCategoryReceipt(), code: 'RATING_UNAVAILABLE' },
    { ...cancelledCategoryReceipt(), code: 'CONTENT_REVIEW_UNAVAILABLE' },
    { ...cancelledCategoryReceipt(), code: 'VERIFICATION_UNAVAILABLE' },
    {
      requestId: result.requestId,
      operation: 'create_categories',
      outcome: 'pending',
    },
  ]) {
    assert.throws(
      () => store.settle(fresh(), invalid as RatingCommandReceipt),
      { kind: 'protocol' },
    );
    assert.equal(JSON.stringify(storage.get(journalKey)), before);
    assert.deepEqual(store.load(accountId), fresh());
  }
});

test('v8 settle remove/readback failures restore exact original bytes and never report success', () => {
  class ReadbackFailure extends MemoryStorage {
    failNextRead = false;
    override remove(key: string): void {
      super.remove(key);
      this.failNextRead = true;
    }
    override get(key: string): unknown {
      if (this.failNextRead) {
        this.failNextRead = false;
        throw new Error('settle readback failed');
      }
      return super.get(key);
    }
  }
  class SilentRemoveFailure extends MemoryStorage {
    override remove(_key: string): void {}
  }
  class RemoveThenThrow extends MemoryStorage {
    override remove(key: string): void {
      super.remove(key);
      throw new Error('remove result lost');
    }
  }
  for (const result of [categoryCreationReceipt(), cancelledCategoryReceipt()])
    for (const storage of [
      new MemoryStorage(),
      new ReadbackFailure(),
      new SilentRemoveFailure(),
      new RemoveThenThrow(),
    ]) {
      const store = new PendingRatingStore(storage, 'origin');
      store.freeze(fresh());
      const bytes = JSON.stringify(storage.get(journalKey));
      if (storage.constructor === MemoryStorage) storage.failRemove = true;
      assert.throws(() => store.settle(fresh(), result), { kind: 'storage' });
      assert.deepEqual(store.load(accountId), fresh());
      assert.equal(JSON.stringify(storage.get(journalKey)), bytes);
      assert.throws(
        () => store.freeze({ version: 1, accountId, intent: intent() }),
        { kind: 'storage' },
      );
    }
});

test('failed settlement before removal never overwrites a different or corrupt original journal', () => {
  for (const replacement of [
    {
      ...fresh(),
      intent: categoryCreationIntent({ clientRequestId: otherId }),
    },
    { broken: true },
  ]) {
    const storage = new MemoryStorage(),
      store = new PendingRatingStore(storage, 'origin');
    store.freeze(fresh());
    storage.set(journalKey, replacement);
    const bytes = JSON.stringify(storage.get(journalKey));
    assert.throws(() => store.settle(fresh(), categoryCreationReceipt()), {
      kind: 'storage',
    });
    assert.equal(JSON.stringify(storage.get(journalKey)), bytes);
  }
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'origin');
  assert.throws(() => store.settle(fresh(), categoryCreationReceipt()), {
    kind: 'storage',
  });
  assert.equal(storage.get(journalKey), undefined);
});

test('category context errors do not use the old admin rollback escape hatch or discard pending intent', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'origin');
  store.freeze(fresh());
  const before = JSON.stringify(storage.get(journalKey));
  for (const code of [
    'RATING_CATEGORY_CONTEXT_CHANGED',
    'RATING_DELETION_CONTEXT_CHANGED',
  ])
    assert.throws(
      () =>
        store.releaseChangedAdminContext(
          fresh(),
          new ClientError('http', 'Conflict', {
            httpStatus: 409,
            serverCode: code,
          }),
        ),
      { kind: 'protocol' },
    );
  assert.equal(JSON.stringify(storage.get(journalKey)), before);
  assert.deepEqual(store.load(accountId), fresh());
});
