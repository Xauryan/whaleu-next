import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeRatingTargetOwnerEditingContext,
  decodeRatingTargetOwnerEditingIntent,
  decodeRatingTargetOwnerEditingLocator,
  decodeRatingTargetOwnerEditingPreparation,
  decodeRatingTargetOwnerEditingReceipt,
  matchRatingTargetOwnerEditingPreparation,
  matchRatingTargetOwnerEditingReceipt,
  ratingTargetOwnerEditingRejections,
} from '../src/ratings/target-owner-editing-contract';
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
import { likeIntent, likeReceipt } from './ratings-r2b-helpers';
import { subscriptionIntent, subscriptionReceipt } from './ratings-r2c-helpers';
import { adminIntent, adminReceipt } from './ratings-r3a-helpers';
import { creationIntent, creationReceipt } from './ratings-management-helpers';
import { ownerIntent, ownerReceipt } from './rating-owner-management-helpers';
import {
  cancelledEditingReceipt,
  definitionRevision,
  editingContext,
  editingIntent,
  editingPreparation,
  editingReceipt,
} from './rating-owner-editing-helpers';

const accountId = wireCredentials().accountId;
const fresh = () => ({
  version: 7 as const,
  accountId,
  intent: editingIntent(),
});
const journalKey = `whaleu.ratings.pending.v7:origin:${accountId}`;

test('editing locator and current context are exact; canonical text is authorized only by the full current tuple', () => {
  assert.deepEqual(decodeRatingTargetOwnerEditingLocator({ targetId }), {
    targetId,
  });
  assert.deepEqual(
    decodeRatingTargetOwnerEditingContext(editingContext()),
    editingContext(),
  );
  for (const raw of [
    null,
    {},
    { targetId: 'invalid' },
    { targetId, regionId: null },
  ])
    assert.throws(() => decodeRatingTargetOwnerEditingLocator(raw));
  for (const key of [
    'creatorId',
    'ownerId',
    'source',
    'origin',
    'campusId',
    'review',
    'accepted',
    'assetIds',
    'deletion',
    'expectedContextRevision',
  ])
    assert.throws(() =>
      decodeRatingTargetOwnerEditingContext({
        ...editingContext(),
        [key]: 'private',
      }),
    );
  for (const key of [
    'targetId',
    'revision',
    'definitionRevision',
    'regionId',
    'categoryId',
    'categoryRevision',
    'catalogRevision',
  ])
    assert.throws(() =>
      decodeRatingTargetOwnerEditingContext({
        ...editingContext(),
        [key]: 'invalid',
      }),
    );
  for (const contentVersion of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '3',
  ])
    assert.throws(() =>
      decodeRatingTargetOwnerEditingContext({
        ...editingContext(),
        contentVersion,
      }),
    );
  for (const patch of [
    { name: ' Current authorized target' },
    { description: ' Current authorized description ' },
    { description: 'first\r\nsecond' },
    { name: '' },
    { name: '\ud800' },
    { name: 'a'.repeat(101) },
    { description: 'a'.repeat(501) },
  ])
    assert.throws(() =>
      decodeRatingTargetOwnerEditingContext({ ...editingContext(), ...patch }),
    );
  assert.equal(
    decodeRatingTargetOwnerEditingContext({
      ...editingContext(),
      contentVersion: 1,
      description: '',
    }).contentVersion,
    1,
  );
});

test('intent normalizes only editable text, freezes every original field and rejects injected authority or changed shape', () => {
  const raw = editingIntent();
  assert.equal(ratingIntentTarget(raw), targetId);
  const normalized = decodeRatingTargetOwnerEditingIntent({
    ...raw,
    payload: { ...raw.payload, name: ' 🌊\r\n鲸 ', description: ' \t ' },
  });
  assert.equal(normalized.payload.name, '🌊\n鲸');
  assert.equal(normalized.payload.description, '');
  assert.equal(Object.isFrozen(normalized), true);
  assert.equal(Object.isFrozen(normalized.payload), true);
  assert.equal(Object.isFrozen(normalized.payload.assetIds), true);
  assert.equal(
    decodeRatingTargetOwnerEditingIntent({
      ...raw,
      payload: {
        ...raw.payload,
        name: '🌊'.repeat(100),
        description: '🌊'.repeat(500),
      },
    }).payload.name,
    '🌊'.repeat(100),
  );
  for (const patch of [
    { creatorId: accountId },
    { ownerId: accountId },
    { accepted: true },
    { source: 'new_native' },
    { expectedContextRevision: 'x'.repeat(43) },
    { assetIds: [otherId] },
    { assetIds: null },
    { name: '🌊'.repeat(101) },
    { name: '' },
    { name: ' \t\n ' },
    { name: '\ud800' },
    { name: 'bad\u0000text' },
    { description: '\u007f' },
    { description: 'a'.repeat(501) },
    { expectedContentVersion: 0 },
    { expectedContentVersion: 1.5 },
    { expectedContentVersion: Number.MAX_SAFE_INTEGER + 1 },
    { expectedDefinitionRevision: 'invalid' },
    { regionId: undefined },
  ])
    assert.throws(() =>
      decodeRatingTargetOwnerEditingIntent({
        ...raw,
        payload: { ...raw.payload, ...patch },
      }),
    );
  for (const key of Object.keys(raw.payload)) {
    const payload: Record<string, unknown> = { ...raw.payload };
    delete payload[key];
    assert.throws(() =>
      decodeRatingTargetOwnerEditingIntent({ ...raw, payload }),
    );
  }
  for (const patch of [
    { operation: 'create_target' },
    { targetId },
    { accepted: true },
  ])
    assert.throws(() =>
      decodeRatingTargetOwnerEditingIntent({ ...raw, ...patch }),
    );
});

test('preparation reserves distinct next lifecycle and definition revisions, exact key/target and exactly one next version', () => {
  const value = editingPreparation();
  assert.deepEqual(decodeRatingTargetOwnerEditingPreparation(value), value);
  matchRatingTargetOwnerEditingPreparation(editingIntent(), value);
  for (const patch of [
    { requestId: otherId },
    { targetId: otherId },
    { revision },
    { definitionRevision },
    { contentVersion: 3 },
    { contentVersion: 5 },
  ])
    assert.throws(() =>
      matchRatingTargetOwnerEditingPreparation(editingIntent(), {
        ...value,
        ...patch,
      }),
    );
  for (const patch of [
    { name: 'private' },
    { expectedContextRevision: value.contextRevision },
    { contextRevision: '' },
    { contextRevision: 'x'.repeat(42) },
    { definitionRevision: 'invalid' },
    { contentVersion: 1 },
    { contentVersion: 2.5 },
  ])
    assert.throws(() =>
      decodeRatingTargetOwnerEditingPreparation({ ...value, ...patch }),
    );
});

test('applied receipts change both revisions and increment once; noop receipts preserve the entire expected tuple', () => {
  for (const outcome of ['applied', 'noop'] as const) {
    const value = editingReceipt(outcome);
    assert.deepEqual(decodeRatingTargetOwnerEditingReceipt(value), value);
    matchRatingTargetOwnerEditingReceipt(editingIntent(), value);
    for (const patch of [
      { targetId: otherId },
      { requestId: otherId },
      { revision: outcome === 'applied' ? revision : otherId },
      {
        definitionRevision:
          outcome === 'applied' ? definitionRevision : otherId,
      },
      { contentVersion: outcome === 'applied' ? 3 : 4 },
      { contentVersion: outcome === 'applied' ? 5 : 2 },
    ])
      assert.throws(() =>
        matchRatingTargetOwnerEditingReceipt(editingIntent(), {
          ...value,
          ...patch,
        }),
      );
    for (const patch of [
      { name: 'private' },
      { description: 'private' },
      { catalogRevision: revision },
      { operation: 'create_target' },
      { occurredAt: 'not a timestamp' },
      { contentVersion: 0 },
      { contentVersion: 1.5 },
      { contentVersion: Number.MAX_SAFE_INTEGER + 1 },
    ])
      assert.throws(() =>
        decodeRatingTargetOwnerEditingReceipt({ ...value, ...patch }),
      );
  }
});

test('rejection allowlist is exact, minimal and durable; unavailable/unknown responses cannot become terminal', () => {
  assert.deepEqual(
    [...ratingTargetOwnerEditingRejections].sort(),
    [
      'RATING_EDIT_CONTEXT_CHANGED',
      'CONTENT_REJECTED',
      'RATING_EDIT_CANCELLED',
      'RATING_NOT_FOUND',
      'PHONE_VERIFICATION_REQUIRED',
      'AFFILIATION_VERIFICATION_REQUIRED',
      'IDENTITY_CAMPUS_REQUIRED',
      'SAFETY_ACTION_RESTRICTED',
    ].sort(),
  );
  for (const code of ratingTargetOwnerEditingRejections) {
    const value = { ...cancelledEditingReceipt(), code };
    assert.deepEqual(decodeRatingTargetOwnerEditingReceipt(value), value);
    matchRatingTargetOwnerEditingReceipt(editingIntent(), value);
    assert.throws(() =>
      matchRatingTargetOwnerEditingReceipt(editingIntent(), {
        ...value,
        requestId: otherId,
      }),
    );
    for (const extra of [
      { targetId },
      { name: 'private' },
      { regionId: null },
      { contentVersion: 3 },
    ])
      assert.throws(() =>
        decodeRatingTargetOwnerEditingReceipt({ ...value, ...extra }),
      );
  }
  for (const code of [
    'RATING_UNAVAILABLE',
    'CONTENT_REVIEW_UNAVAILABLE',
    'VERIFICATION_UNAVAILABLE',
    'SAFETY_UNAVAILABLE',
    'REQUEST_NOT_FOUND',
    'RATING_REVISION_CONFLICT',
    'INTERNAL_ERROR',
  ])
    assert.throws(() =>
      decodeRatingTargetOwnerEditingReceipt({
        ...cancelledEditingReceipt(),
        code,
      }),
    );
});

test('v7 shares one original slot with every unchanged v1–v6 journal and preserves old bytes', () => {
  const older: Array<[PendingRating, RatingCommandReceipt]> = [
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
    const editBytes = JSON.stringify(storage.get(journalKey));
    assert.throws(() => store.freeze(old));
    assert.equal(JSON.stringify(storage.get(journalKey)), editBytes);
    assert.deepEqual(store.load(accountId), fresh());
    store.settle(fresh(), editingReceipt());
    assert.equal(store.load(accountId), null);
  }
});

test('the original account and origin isolate recovery; exact replay cannot add a preparation token', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'origin');
  const attempt = store.freeze(fresh());
  assert.deepEqual(store.freeze(fresh()), attempt);
  assert.equal(storage.data.size, 1);
  assert.deepEqual(storage.get(journalKey), fresh());
  assert.equal(
    JSON.stringify(storage.get(journalKey)).includes('contextRevision'),
    false,
  );
  assert.equal(
    new PendingRatingStore(storage, 'other-origin').load(accountId),
    null,
  );
  assert.equal(store.load(otherId), null);
  assert.throws(() =>
    store.settle({ ...fresh(), accountId: otherId }, editingReceipt()),
  );
  assert.deepEqual(store.load(accountId), fresh());
});

test('every original input field is immutable once v7 is frozen and wrong receipt kinds cannot free it', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'origin');
  store.freeze(fresh());
  for (const patch of [
    { clientRequestId: otherId },
    { targetId: otherId },
    { regionId: otherId },
    { expectedTargetRevision: otherId },
    { expectedDefinitionRevision: otherId },
    { expectedContentVersion: 4 },
    { categoryId: otherId },
    { expectedCategoryRevision: otherId },
    { expectedCatalogRevision: otherId },
    { name: 'Changed text' },
    { description: 'Changed description' },
  ])
    assert.throws(() =>
      store.freeze({
        ...fresh(),
        intent: {
          ...editingIntent(),
          payload: { ...editingIntent().payload, ...patch },
        },
      }),
    );
  for (const result of [
    { ...editingReceipt(), requestId: otherId },
    { ...editingReceipt(), targetId: otherId },
    { ...editingReceipt(), definitionRevision },
    { ...editingReceipt(), contentVersion: 5 },
    creationReceipt(),
    ownerReceipt(),
  ])
    assert.throws(() => store.settle(fresh(), result));
  assert.deepEqual(store.load(accountId), fresh());
});

test('malformed, noncanonical and cross-version journals block load and every fresh command without rewriting evidence', () => {
  for (const malformed of [
    { ...fresh(), version: 6 },
    { ...fresh(), accountId: otherId },
    { ...fresh(), contextRevision: 'x'.repeat(43) },
    {
      ...fresh(),
      intent: {
        ...editingIntent(),
        payload: { ...editingIntent().payload, name: ' leading space' },
      },
    },
    {
      ...fresh(),
      intent: {
        ...editingIntent(),
        payload: { ...editingIntent().payload, expectedContentVersion: 0 },
      },
    },
    { ...fresh(), intent: ownerIntent() },
    { broken: true },
  ]) {
    const storage = new MemoryStorage(),
      store = new PendingRatingStore(storage, 'origin');
    storage.set(journalKey, malformed);
    const bytes = JSON.stringify(storage.get(journalKey));
    assert.throws(() => store.load(accountId));
    assert.throws(() => store.freeze(fresh()));
    assert.throws(() =>
      store.freeze({ version: 1, accountId, intent: intent() }),
    );
    assert.equal(JSON.stringify(storage.get(journalKey)), bytes);
  }
  for (const version of [1, 2, 3, 4, 5, 6]) {
    const storage = new MemoryStorage(),
      store = new PendingRatingStore(storage, 'origin');
    storage.set(`whaleu.ratings.pending.v${version}:origin:${accountId}`, {
      broken: true,
    });
    assert.throws(() => store.freeze(fresh()));
    assert.equal(storage.get(journalKey), undefined);
  }
});

test('v7 settle removal/readback failure restores the exact original journal and never reports success', () => {
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
    const bytes = JSON.stringify(storage.get(journalKey));
    if (!(storage instanceof ReadbackFailure)) storage.failRemove = true;
    assert.throws(() => store.settle(fresh(), editingReceipt()));
    assert.deepEqual(store.load(accountId), fresh());
    assert.equal(JSON.stringify(storage.get(journalKey)), bytes);
  }
});

test('missing mandatory fields in context, preparation and receipts are rejected rather than defaulted', () => {
  for (const [value, decode] of [
    [editingContext(), decodeRatingTargetOwnerEditingContext],
    [editingPreparation(), decodeRatingTargetOwnerEditingPreparation],
    [editingReceipt(), decodeRatingTargetOwnerEditingReceipt],
    [cancelledEditingReceipt(), decodeRatingTargetOwnerEditingReceipt],
  ] as const) {
    for (const key of Object.keys(value)) {
      const incomplete: Record<string, unknown> = { ...value };
      delete incomplete[key];
      assert.throws(() => decode(incomplete));
    }
  }
  assert.throws(() =>
    decodeRatingTargetOwnerEditingIntent({
      ...editingIntent(),
      payload: {
        ...editingIntent().payload,
        expectedContentVersion: Number.MAX_SAFE_INTEGER,
      },
    }),
  );
});

test('freeze readback failure cannot be mistaken for an acknowledged original journal', () => {
  class FreezeReadbackFailure extends MemoryStorage {
    failNextRead = false;
    override set(key: string, value: unknown) {
      super.set(key, value);
      this.failNextRead = true;
    }
    override get(key: string): unknown {
      if (this.failNextRead) {
        this.failNextRead = false;
        throw new Error('original write readback failed');
      }
      return super.get(key);
    }
  }
  const storage = new FreezeReadbackFailure(),
    store = new PendingRatingStore(storage, 'origin');
  assert.throws(() => store.freeze(fresh()));
  assert.deepEqual(store.load(accountId), fresh());
  assert.deepEqual(storage.get(journalKey), fresh());
  assert.throws(() =>
    store.freeze({ version: 1, accountId, intent: intent() }),
  );
});

test('definition version bounds match the SQL integer next-version capacity', () => {
  const before = 2147483646,
    after = 2147483647;
  assert.equal(
    decodeRatingTargetOwnerEditingContext({
      ...editingContext(),
      contentVersion: before,
    }).contentVersion,
    before,
  );
  const intent = decodeRatingTargetOwnerEditingIntent({
    ...editingIntent(),
    payload: { ...editingIntent().payload, expectedContentVersion: before },
  });
  const prepared = decodeRatingTargetOwnerEditingPreparation({
    ...editingPreparation(),
    contentVersion: after,
  });
  matchRatingTargetOwnerEditingPreparation(intent, prepared);
  const applied = decodeRatingTargetOwnerEditingReceipt({
    ...editingReceipt(),
    contentVersion: after,
  });
  matchRatingTargetOwnerEditingReceipt(intent, applied);
  for (const contentVersion of [after, after + 1, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() =>
      decodeRatingTargetOwnerEditingContext({
        ...editingContext(),
        contentVersion,
      }),
    );
    assert.throws(() =>
      decodeRatingTargetOwnerEditingIntent({
        ...editingIntent(),
        payload: {
          ...editingIntent().payload,
          expectedContentVersion: contentVersion,
        },
      }),
    );
  }
  for (const contentVersion of [after + 1, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() =>
      decodeRatingTargetOwnerEditingPreparation({
        ...editingPreparation(),
        contentVersion,
      }),
    );
    assert.throws(() =>
      decodeRatingTargetOwnerEditingReceipt({
        ...editingReceipt(),
        contentVersion,
      }),
    );
  }
});
