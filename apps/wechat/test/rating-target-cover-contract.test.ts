import { decodeRatingTargetCoverContext } from '../src/ratings/target-cover-context';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeRatingScopedIntent,
  ratingScopedIntentHash,
} from '../src/ratings/scoped-contract';
import {
  decodeRatingTargetCoverIntent,
  decodeRatingTargetCoverReceipt,
  matchRatingTargetCoverReceipt,
  ratingTargetCoverContext,
  ratingTargetCoverIntentHash,
} from '../src/ratings/target-cover-contract';
import {
  decodeRatingCommandIntent,
  isRatingScopedIntent,
  PendingRatingStore,
} from '../src/ratings/pending';
import { MemoryStorage } from './helpers';
import { accountId } from './identity-helpers';
import { otherId, requestId } from './ratings-helpers';
import { scopedContext, scopedIntent } from './rating-scoped-helpers';
import { managementIntent } from './category-scoped-helpers';
function coverIntent(edit = false) {
  const legacy = scopedIntent(
    edit ? 'edit_target_scoped' : 'create_target_scoped',
  );
  const { assetIds, ...payload } = legacy.payload as typeof legacy.payload & {
    assetIds: unknown;
  };
  assert.deepEqual(assetIds, []);
  return decodeRatingTargetCoverIntent({
    ...legacy,
    protocolVersion: 3,
    payload: { ...payload, cover: { action: 'clear' } },
  });
}
test('cover v3 never widens old v2 codecs or hash domain', () => {
  const legacy = scopedIntent('create_target_scoped'),
    current = coverIntent();
  assert.throws(() => decodeRatingScopedIntent(current));
  assert.throws(() => decodeRatingTargetCoverIntent(legacy));
  assert.notEqual(
    ratingScopedIntentHash(legacy),
    ratingTargetCoverIntentHash(current),
  );
  assert.deepEqual(decodeRatingCommandIntent(current), current);
  assert.equal(isRatingScopedIntent(current), false);
  for (const cover of [
    { action: 'keep' },
    { action: 'replace', assetId: otherId },
    { action: 'clear', url: 'https://untrusted.invalid/image' },
    {
      action: 'replace',
      assetId: otherId,
      uploadScopeId: requestId,
      approved: true,
    },
  ])
    assert.throws(() =>
      decodeRatingTargetCoverIntent({
        ...current,
        payload: { ...current.payload, cover },
      }),
    );
  assert.throws(() =>
    decodeRatingTargetCoverIntent({
      ...current,
      payload: { ...current.payload, name: '' },
    }),
  );
  assert.throws(() =>
    decodeRatingTargetCoverIntent({
      ...current,
      payload: { ...current.payload, assetIds: [] },
    }),
  );
});
test('cover keep is edit-only and capability is explicit', () => {
  const edit = coverIntent(true);
  assert.equal(
    decodeRatingTargetCoverIntent({
      ...edit,
      payload: { ...edit.payload, cover: { action: 'keep' } },
    }).payload.cover.action,
    'keep',
  );
  const context = scopedContext({
    selector: { kind: 'global' },
    purpose: 'edit_target',
    mode: 'public',
  });
  assert.throws(() => decodeRatingTargetCoverContext(context));
  assert.throws(() =>
    ratingTargetCoverContext({ ...context, protocolVersion: 3 }),
  );
  assert.doesNotThrow(() =>
    ratingTargetCoverContext({
      ...context,
      protocolVersion: 3,
      capabilities: [...context.capabilities, 'target_cover'],
    }),
  );
});
test('cover receipts bind original v3 hash and operation without descriptors', () => {
  const intent = coverIntent();
  const receipt = decodeRatingTargetCoverReceipt({
    protocolVersion: 3,
    requestId: intent.payload.clientRequestId,
    operation: intent.operation,
    intentHash: ratingTargetCoverIntentHash(intent),
    outcome: 'closed',
    code: 'RATING_CREATION_CANCELLED',
  });
  matchRatingTargetCoverReceipt(intent, receipt);
  assert.throws(() =>
    decodeRatingTargetCoverReceipt({ ...receipt, protocolVersion: 2 }),
  );
  assert.throws(() =>
    decodeRatingTargetCoverReceipt({ ...receipt, descriptor: null }),
  );
  assert.throws(() =>
    matchRatingTargetCoverReceipt(intent, {
      ...receipt,
      intentHash: '0'.repeat(64),
    }),
  );
});
test('journal 11 and old or corrupt journal slots exclude each other without rewriting old bytes', () => {
  for (const old of [
    { version: 9 as const, accountId, intent: scopedIntent() },
    { version: 10 as const, accountId, intent: managementIntent() },
  ]) {
    const storage = new MemoryStorage(),
      store = new PendingRatingStore(storage, 'cover');
    const fresh = { version: 11 as const, accountId, intent: coverIntent() };
    store.freeze(old);
    const key = `whaleu.ratings.pending.v${old.version}:cover:${accountId}`;
    const bytes = JSON.stringify(storage.get(key));
    assert.throws(() => store.freeze(fresh), { kind: 'storage' });
    assert.equal(JSON.stringify(storage.get(key)), bytes);
    storage.remove(key);
    store.freeze(fresh);
    assert.throws(() => store.freeze(old), { kind: 'storage' });
  }
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'cover');
  storage.set(`whaleu.ratings.pending.v11:cover:${accountId}`, {
    version: 11,
    accountId,
    intent: {},
  });
  assert.throws(
    () => store.freeze({ version: 9, accountId, intent: scopedIntent() }),
    { kind: 'storage' },
  );
});
