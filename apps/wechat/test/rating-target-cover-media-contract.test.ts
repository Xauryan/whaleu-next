import {
  decodeRatingTargetCoverDetail,
  decodeRatingTargetCoverPage,
} from '../src/ratings/target-cover-gateway';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RATINGS_MEDIA_PROTOCOL,
  decodeRatingCoverDescriptor,
  decodeRatingCoverPrepare,
  decodeRatingCoverRecovery,
  decodeRatingCoverMediaStatus,
  ratingCoverPrepareHash,
} from '../src/ratings/target-cover-media-contract';
import { PendingRatingStore } from '../src/ratings/pending';
import {
  decodeRatingCoverScopeInput,
  decodeRatingCoverScopeCancellation,
  ratingCoverScopeIdentity,
} from '../src/ratings/target-cover-upload-scope';
import { ratingScopedCommandContext } from '../src/ratings/scoped-contract';
import { MemoryStorage } from './helpers';
import {
  scopedContext,
  scopedIntent,
  scopedPageContext,
} from './rating-scoped-helpers';
import { accountId } from './identity-helpers';
import {
  requestId,
  otherId,
  targetId,
  categoryId,
  revision,
  target,
} from './ratings-helpers';
const declaration = {
  mime: 'image/jpeg' as const,
  bytes: 1234,
  sha256: 'a'.repeat(64),
};
const prepare = () =>
  decodeRatingCoverPrepare({
    protocol: RATINGS_MEDIA_PROTOCOL,
    clientRequestId: requestId,
    editScopeId: otherId,
    scopeRevision: 'b'.repeat(64),
    slot: 'cover',
    declaration,
  });
const scopeInput = () =>
  decodeRatingCoverScopeInput({
    protocolVersion: 3,
    context: ratingScopedCommandContext(scopedContext()),
    clientRequestId: requestId,
    commandRequestId: targetId,
    draftRevision: revision,
    categoryId,
    expectedCategoryRevision: revision,
    target: null,
    declaration,
  });
test('Ratings descriptor is exact authenticated owner identity, never Profile guest or Community', () => {
  const value = {
    protocol: RATINGS_MEDIA_PROTOCOL,
    kind: 'ratings-target-media',
    contextId: requestId,
    contextToken: 't'.repeat(43),
    targetId,
    appearanceId: otherId,
    bindingId: requestId,
    width: 2048,
    height: 1024,
    variants: ['thumb-v1', 'display-v1'],
  };
  assert.deepEqual(decodeRatingCoverDescriptor(value), value);
  for (const change of [
    { protocol: 'profile-avatar-media-v1' },
    { kind: 'authenticated-media' },
    { url: 'https://provider.invalid/image' },
    { guest: true },
    { assetId: otherId },
  ])
    assert.throws(() => decodeRatingCoverDescriptor({ ...value, ...change }));
});
test('media request hash binds actor, upload scope, exact declaration and slot', () => {
  assert.notEqual(
    ratingCoverPrepareHash(accountId, prepare()),
    ratingCoverPrepareHash(otherId, prepare()),
  );
  for (const change of [
    { slot: 'avatar' },
    { protocol: 'profile-avatar-media-v1' },
    { ordinal: 0 },
    { declaration: { ...declaration, approved: true } },
  ])
    assert.throws(() => decodeRatingCoverPrepare({ ...prepare(), ...change }));
});
test('not recorded cannot release upload journal; old pending and upload admission exclude each other', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'cover');
  const original = store.freezeCoverUpload({
    version: 11,
    phase: 'upload',
    accountId,
    scopeInput: scopeInput(),
    scope: null,
    status: null,
  });
  assert.throws(
    () => store.freeze({ version: 9, accountId, intent: scopedIntent() }),
    { kind: 'storage' },
  );
  assert.throws(() => store.load(accountId), { kind: 'storage' });
  const unknown = decodeRatingCoverRecovery({
    protocol: RATINGS_MEDIA_PROTOCOL,
    requestId,
    serverNow: 1000,
    state: 'not_recorded',
    requestHash: null,
  });
  assert.throws(() => store.settleCoverUploadCancellation(original, unknown), {
    kind: 'storage',
  });
  assert.deepEqual(store.loadCoverUpload(accountId), original);
  assert.equal(
    JSON.stringify(
      storage.get(`whaleu.ratings.pending.v11:cover:${accountId}`),
    ).includes('filePath'),
    false,
  );
});
test('status unknown is not ready and malformed same-status extra fields fail closed', () => {
  const status = {
    protocol: RATINGS_MEDIA_PROTOCOL,
    editScopeId: otherId,
    intentId: categoryId,
    requestId,
    requestHash: ratingCoverPrepareHash(accountId, prepare()),
    serverNow: 1000,
    status: 'unavailable',
    reason: 'MEDIA_UNAVAILABLE',
    retryable: true,
  };
  assert.equal(decodeRatingCoverMediaStatus(status).status, 'unavailable');
  assert.throws(() =>
    decodeRatingCoverMediaStatus({ ...status, assetId: targetId }),
  );
  assert.throws(() =>
    decodeRatingCoverRecovery({
      protocol: RATINGS_MEDIA_PROTOCOL,
      requestId: otherId,
      serverNow: 1000,
      state: 'recorded',
      requestHash: status.requestHash,
      status,
    }),
  );
});

test('v3 target projections keep body and exact cover together and reject an unknown cover', () => {
  const context = scopedPageContext(
    scopedContext({
      purpose: 'read',
      mode: 'public',
      selector: { kind: 'global' },
    }),
  );
  const descriptor = {
    protocol: RATINGS_MEDIA_PROTOCOL,
    kind: 'ratings-target-media',
    contextId: requestId,
    contextToken: 't'.repeat(43),
    targetId,
    appearanceId: otherId,
    bindingId: requestId,
    width: 80,
    height: 60,
    variants: ['thumb-v1', 'display-v1'],
  };
  const detail = { context, target: target(), cover: descriptor };
  assert.equal(decodeRatingTargetCoverDetail(detail).cover?.targetId, targetId);
  assert.throws(() =>
    decodeRatingTargetCoverDetail({ ...detail, cover: undefined }),
  );
  assert.throws(() =>
    decodeRatingTargetCoverDetail({
      ...detail,
      cover: { ...descriptor, targetId: otherId },
    }),
  );
  const page = {
    context: { ...context, categoryId },
    items: [{ ...target(), cover: null }],
    nextCursor: null,
    continuation: 'end',
  };
  assert.equal(decodeRatingTargetCoverPage(page).items[0]!.cover, null);
  assert.throws(() =>
    decodeRatingTargetCoverPage({ ...page, items: [target()] }),
  );
});

test('cancel-before-scope fences the original request without requiring its expired context or inventing a new scope', () => {
  const storage = new MemoryStorage(),
    store = new PendingRatingStore(storage, 'cover-cancel');
  const original = store.freezeCoverUpload({
    version: 11,
    phase: 'upload',
    accountId,
    scopeInput: scopeInput(),
    scope: null,
    status: null,
  });
  const identity = ratingCoverScopeIdentity(accountId, original.scopeInput);
  const originalPrepare = decodeRatingCoverPrepare({
    protocol: RATINGS_MEDIA_PROTOCOL,
    clientRequestId: requestId,
    editScopeId: identity.scopeId,
    scopeRevision: identity.scopeRevision,
    slot: 'cover',
    declaration,
  });
  const response = {
    protocolVersion: 3,
    clientRequestId: requestId,
    ...identity,
    prepare: originalPrepare,
    recovery: {
      protocol: RATINGS_MEDIA_PROTOCOL,
      requestId,
      serverNow: 1000,
      state: 'cancelled_before_prepare',
      requestHash: ratingCoverPrepareHash(accountId, originalPrepare),
      reason: 'cancelled',
    },
  };
  const decoded = decodeRatingCoverScopeCancellation(
    response,
    accountId,
    original.scopeInput,
  );
  assert.throws(() =>
    decodeRatingCoverScopeCancellation(
      { ...response, scopeId: otherId },
      accountId,
      original.scopeInput,
    ),
  );
  assert.throws(
    () =>
      store.settleCoverScopeCancellation(original, {
        ...decoded,
        recovery: {
          protocol: RATINGS_MEDIA_PROTOCOL,
          requestId,
          serverNow: 1000,
          state: 'not_recorded',
          requestHash: null,
        },
      }),
    { kind: 'storage' },
  );
  assert.deepEqual(store.loadCoverUpload(accountId), original);
  store.settleCoverScopeCancellation(original, decoded);
  assert.equal(store.load(accountId), null);
});
