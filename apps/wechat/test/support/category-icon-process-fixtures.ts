import { accountId } from '../identity-helpers';
import { managementIntent } from '../category-scoped-helpers';
import { iconId, iconReceipt, mediaSnapshot } from '../category-icon-helpers';
import {
  categoryIconDraftSlots,
  sealCategoryIconDraft,
} from '../../src/ratings/category-icon-draft';
import {
  categoryIconPrepareForScope,
  categoryIconScopeRequestHash,
  decodeCategoryIconScopeInput,
} from '../../src/ratings/category-icon-upload-scope';
import {
  categoryIconPrepareHash,
  type CategoryIconMediaStatus,
} from '../../src/ratings/category-icon-media-contract';
import {
  ratingCategoryIconUploadIdentityHash,
  type PendingRatingCategoryIconUploads,
  type RatingCategoryIconUploadMember,
} from '../../src/ratings/category-icon-pending';
export function categoryIconProcessFixture() {
  const actor = accountId,
    text = managementIntent();
  if (text.operation !== 'edit_category_base_scoped')
    throw new Error('fixture');
  const slots = categoryIconDraftSlots(
      text,
      new Map([[`base:${text.payload.categoryId}`, 'replace']]),
    ),
    identity = {
      textIntent: text,
      mediaSnapshot,
      draftRevision: iconId(51),
      slots,
    };
  const initial: PendingRatingCategoryIconUploads = {
    version: 13,
    phase: 'uploads',
    accountId: actor,
    identity,
    identityHash: ratingCategoryIconUploadIdentityHash(actor, identity),
    members: [],
  };
  const scopeInput = decodeCategoryIconScopeInput({
    ...text,
    protocolVersion: 5,
    mediaSnapshot,
    clientRequestId: iconId(52),
    draftRevision: identity.draftRevision,
    slot: { kind: 'base', categoryId: text.payload.categoryId },
    declaration: { mime: 'image/png', bytes: 1000, sha256: 'a'.repeat(64) },
  });
  const pending: RatingCategoryIconUploadMember = {
    memberId: iconId(53),
    slotKey: slots[0]!.key,
    scopeInput,
    scope: null,
    prepare: null,
    status: null,
    state: 'pending',
    assetId: null,
  };
  const scope = {
      editScopeId: iconId(54),
      scopeRevision: 'b'.repeat(64),
      categoryId: text.payload.categoryId,
      identityId: iconId(55),
      expiresAt: '2026-10-10T23:59:00.000Z',
    },
    prepare = categoryIconPrepareForScope(scopeInput, scope),
    assetId = iconId(56),
    requestHash = categoryIconPrepareHash(actor, prepare);
  const common = {
    protocol: 'ratings-category-icon-media-v1' as const,
    editScopeId: scope.editScopeId,
    intentId: iconId(57),
    requestId: scopeInput.clientRequestId,
    requestHash,
    serverNow: 1791674400000,
  };
  const status: CategoryIconMediaStatus = {
    ...common,
    status: 'ready_unbound',
    assetId,
    readyRetentionUntil: 1791688000000,
    editExpiresAt: 1791688000000,
    bindBefore: 1791688000000,
    mediaProof: 'current',
  };
  const ready: RatingCategoryIconUploadMember = {
    ...pending,
    scope,
    prepare,
    status,
    state: 'ready',
    assetId,
  };
  const intent = sealCategoryIconDraft(text, mediaSnapshot, slots, [
      { slotKey: slots[0]!.key, assetId, uploadScopeId: scope.editScopeId },
    ]),
    receipt = iconReceipt(intent),
    bound: CategoryIconMediaStatus = {
      ...common,
      status: 'bound_history',
      assetId,
      bindingId: iconId(58),
      appearanceId: iconId(59),
      categoryId: scope.categoryId,
      attachmentState: 'active',
    };
  return {
    actor,
    initial,
    pending,
    ready,
    intent,
    receipt,
    scope,
    prepare,
    common,
    bound,
    scopeRequestHash: categoryIconScopeRequestHash(scopeInput),
  };
}
