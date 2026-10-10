import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  decodeRatingNavigationSelector,
  decodeRatingRandomCandidateSelector,
  decodeRatingScopedContext,
  decodeRatingScopedIntent,
  decodeRatingScopedReceipt,
  matchRatingScopedReceipt,
  ratingScopedIntentHash,
  ratingScopedOperations,
  ratingRandomSelector,
  RATING_SCOPED_HASH_DOMAIN,
} from '../src/ratings/scoped-contract';
import { decodeRatingScopedRoute } from '../src/ratings/scoped-controller';
import {
  PendingRatingStore,
  decodeRatingCommandIntent,
  type PendingRating,
  type RatingCommandReceipt,
} from '../src/ratings/pending';
import { MemoryStorage } from './helpers';
import { accountId } from './identity-helpers';
import {
  scopedContext,
  scopedIntent,
  scopedReceipt,
  token,
  tokenDigest,
} from './rating-scoped-helpers';
import { intent, receipt, otherId, requestId } from './ratings-helpers';
import { replyIntent, replyReceipt } from './ratings-r2a-helpers';
import { likeIntent, likeReceipt } from './ratings-r2b-helpers';
import { subscriptionIntent, subscriptionReceipt } from './ratings-r2c-helpers';
import { adminIntent, adminReceipt } from './ratings-r3a-helpers';
import { creationIntent, creationReceipt } from './ratings-management-helpers';
import { ownerIntent, ownerReceipt } from './rating-owner-management-helpers';
import { editingIntent, editingReceipt } from './rating-owner-editing-helpers';
import {
  categoryCreationIntent,
  categoryCreationReceipt,
} from './category-management-helpers';
const key = (version: number) =>
  `whaleu.ratings.pending.v${version}:scoped:${accountId}`;
const current = (): PendingRating => ({
  version: 9,
  accountId,
  intent: scopedIntent(),
});
function legacy(): Array<[PendingRating, RatingCommandReceipt]> {
  return [
    [{ version: 1, accountId, intent: intent() }, receipt()],
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
    [
      { version: 8, accountId, intent: categoryCreationIntent() },
      categoryCreationReceipt(),
    ],
  ];
}

test('navigation and random selectors are disjoint strict unions; selected campus means institution plus global', () => {
  assert.deepEqual(
    ratingRandomSelector({ kind: 'campus', campusId: otherId }),
    { kind: 'institution_with_global', anchorCampusId: otherId },
  );
  for (const value of [
    { kind: 'region_compat', regionId: otherId },
    { kind: 'campus', campusId: otherId, includeGlobal: false },
    { kind: 'global', campusId: otherId },
  ])
    assert.throws(() => decodeRatingNavigationSelector(value));
  assert.throws(() =>
    decodeRatingRandomCandidateSelector({ kind: 'campus', campusId: otherId }),
  );
  assert.throws(() =>
    decodeRatingNavigationSelector({
      kind: 'institution_with_global',
      anchorCampusId: otherId,
    }),
  );
  assert.throws(() =>
    decodeRatingScopedRoute({ mode: 'catalog', regionId: otherId }),
  );
  assert.throws(() =>
    decodeRatingScopedRoute({
      mode: 'catalog',
      scope: 'global',
      campusId: otherId,
    }),
  );
});
test('immutable context verifies actor/session proof shape, token digest, full heads and maximum five-minute lifetime', () => {
  const context = scopedContext();
  assert.deepEqual(decodeRatingScopedContext(context), context);
  for (const patch of [
    { tokenDigest: '0'.repeat(64) },
    { sessionGeneration: 'unknown' },
    { protocolGeneration: 1 },
    {
      expiresAt: new Date(Date.parse(context.issuedAt) + 300_001).toISOString(),
    },
    { heads: [] },
    { heads: [...context.heads, ...context.heads] },
    { selector: { kind: 'campus', campusId: otherId } },
    { additional: true },
  ])
    assert.throws(() => decodeRatingScopedContext({ ...context, ...patch }));
  const random = scopedContext({
    purpose: 'random',
    mode: 'public',
    selector: { kind: 'institution_with_global', anchorCampusId: otherId },
  });
  assert.deepEqual(decodeRatingScopedContext(random), random);
  assert.notEqual(random.protocolGeneration, random.id);
  assert.deepEqual(
    decodeRatingScopedContext({ ...random, protocolGeneration: otherId }),
    { ...random, protocolGeneration: otherId },
  );
  assert.throws(() =>
    decodeRatingScopedContext({ ...random, heads: random.heads.slice(0, 1) }),
  );
});
test('all eight intents and receipts are strict, immutable, independently hashed and exactly matched', () => {
  for (const operation of ratingScopedOperations) {
    const original = scopedIntent(operation),
      result = scopedReceipt(original);
    assert.deepEqual(decodeRatingCommandIntent(original), original);
    assert.equal(Object.isFrozen(original.payload), true);
    assert.deepEqual(decodeRatingScopedReceipt(result), result);
    matchRatingScopedReceipt(original, result);
    assert.throws(() =>
      decodeRatingScopedIntent({ ...original, protocolVersion: 9 }),
    );
    assert.throws(() =>
      decodeRatingScopedIntent({
        ...original,
        payload: { ...original.payload, regionId: null },
      }),
    );
    assert.throws(() =>
      decodeRatingScopedIntent({
        ...original,
        payload: { ...original.payload, expectedCategoryRevision: undefined },
      }),
    );
    assert.throws(() =>
      matchRatingScopedReceipt(original, {
        ...result,
        intentHash: '0'.repeat(64),
      }),
    );
    assert.throws(() =>
      decodeRatingScopedReceipt({
        protocolVersion: 2,
        requestId,
        operation,
        intentHash: ratingScopedIntentHash(original),
        outcome: 'closed',
        code: 'RATING_SCOPE_UNAVAILABLE',
      }),
    );
    matchRatingScopedReceipt(original, scopedReceipt(original, 'closed'));
  }
  const original = scopedIntent('create_comment_scoped');
  assert.throws(() =>
    decodeRatingScopedIntent({
      ...original,
      payload: { ...original.payload, body: ' padded ' },
    }),
  );
  assert.throws(() =>
    decodeRatingScopedIntent({
      ...original,
      payload: { ...original.payload, assetIds: [otherId] },
    }),
  );
});
test('SHA-256 golden command uses exact version/domain and object key ordering without rewriting array order', () => {
  const original = scopedIntent();
  // Deliberately independent literal serialization, not the implementation canonicalizer.
  const literal = `{"intent":{"context":{"catalogRevision":"44444444-4444-4444-8444-444444444444","headRevision":"55555555-5555-4555-8555-555555555555","id":"eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee","protocolGeneration":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","scopeRevision":"${'b'.repeat(64)}","selector":{"kind":"global"},"sourceDigest":"${'c'.repeat(64)}","token":"${token}","tokenDigest":"${tokenDigest}"},"payload":{"categoryId":"22222222-2222-4222-8222-222222222222","clientRequestId":"66666666-6666-4666-8666-666666666666","expectedCategoryRevision":"44444444-4444-4444-8444-444444444444","expectedRevision":"44444444-4444-4444-8444-444444444444","expectedTargetRevision":"44444444-4444-4444-8444-444444444444","score":5,"targetId":"11111111-1111-4111-8111-111111111111"}},"operation":"set_score_scoped","protocolVersion":2}`;
  const expected = createHash('sha256')
    .update(RATING_SCOPED_HASH_DOMAIN + literal, 'utf8')
    .digest('hex');
  assert.equal(ratingScopedIntentHash(original), expected);
  assert.notEqual(expected, createHash('sha256').update(literal).digest('hex'));
  const changed = decodeRatingScopedIntent({
    ...original,
    context: {
      ...original.context,
      selector: { kind: 'campus', campusId: otherId },
    },
  });
  assert.notEqual(ratingScopedIntentHash(changed), expected);
});
test('v9 shares one immutable slot with every v1–v8 branch and leaves old stored bytes unchanged', () => {
  for (const [old, result] of legacy()) {
    const storage = new MemoryStorage(),
      store = new PendingRatingStore(storage, 'scoped');
    const frozen = store.freeze(old),
      bytes = JSON.stringify(storage.get(key(old.version)));
    assert.throws(() => store.freeze(current()));
    assert.equal(JSON.stringify(storage.get(key(old.version))), bytes);
    assert.deepEqual(store.load(accountId), frozen);
    store.settle(frozen, result);
    store.freeze(current());
    assert.throws(() => store.freeze(old));
    assert.equal(store.load(accountId)?.version, 9);
    store.settle(current(), scopedReceipt());
    assert.equal(store.load(accountId), null);
  }
});
test('original expired v9 intent survives unavailable reads and cannot refresh token, head or key in place', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'scoped'),
    frozen = store.freeze(current());
  const bytes = JSON.stringify(storage.get(key(9))),
    original = scopedIntent();
  for (const changed of [
    decodeRatingScopedIntent({
      ...original,
      payload: { ...original.payload, clientRequestId: otherId },
    }),
    decodeRatingScopedIntent({
      ...original,
      context: { ...original.context, headRevision: otherId },
    }),
  ])
    assert.throws(() =>
      store.freeze({ version: 9, accountId, intent: changed }),
    );
  assert.throws(() =>
    store.settle(frozen, { ...scopedReceipt(), intentHash: 'd'.repeat(64) }),
  );
  assert.equal(JSON.stringify(storage.get(key(9))), bytes);
  storage.data.set(key(9), {
    ...frozen,
    preparationContextRevision: 'p'.repeat(43),
  });
  assert.throws(() => store.load(accountId));
});
test('v9 failed settlement read-back restores the exact original recovery key', () => {
  const storage = new MemoryStorage();
  let afterRemove = false;
  const failing = {
    get: (key: string) => {
      if (afterRemove) {
        afterRemove = false;
        throw new Error('read-back failed');
      }
      return storage.get(key);
    },
    set: (key: string, value: unknown) => storage.set(key, value),
    remove: (key: string) => {
      storage.remove(key);
      afterRemove = true;
    },
  };
  const store = new PendingRatingStore(failing, 'scoped'),
    frozen = store.freeze(current()),
    bytes = JSON.stringify(storage.get(key(9)));
  assert.throws(() => store.settle(frozen, scopedReceipt()));
  assert.equal(JSON.stringify(storage.get(key(9))), bytes);
});
