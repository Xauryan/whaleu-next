import { sha256 } from 'js-sha256';
import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import { invalidRating, ratingId } from './contract';
import { ratingTimestamp } from './discussion-contract';
import {
  canonicalRatingScopedJson,
  ratingScopedDigest,
} from './scoped-contract';
import {
  decodeRatingCategoryScopedIntent,
  type RatingCategoryScopedIntent,
} from './category-scoped-contract';
import {
  decodeCategoryIconDeclaration,
  decodeCategoryIconRecovery,
  type CategoryIconPrepare,
  type CategoryIconRecovery,
} from './category-icon-media-contract';
import type { UploadDeclaration } from '../media/upload-contracts';
export type CategoryIconSlot =
  | { readonly kind: 'new'; readonly key: string }
  | { readonly kind: 'base'; readonly categoryId: string }
  | {
      readonly kind: 'override';
      readonly categoryId: string;
      readonly campusId: string;
    };
export type CategoryIconScopeInput = Omit<
  RatingCategoryScopedIntent,
  'protocolVersion'
> & {
  readonly protocolVersion: 5;
  readonly mediaSnapshot: string;
  readonly clientRequestId: string;
  readonly draftRevision: string;
  readonly slot: CategoryIconSlot;
  readonly declaration: UploadDeclaration;
};
export interface CategoryIconScope {
  readonly editScopeId: string;
  readonly scopeRevision: string;
  readonly categoryId: string;
  readonly identityId: string;
  readonly expiresAt: string;
}
export interface CategoryIconScopeRecovery {
  readonly state: 'known' | 'unknown' | 'cancelled';
  readonly scope: CategoryIconScope | null;
  readonly recovery: CategoryIconRecovery | null;
}
export function decodeCategoryIconScopeInput(
  value: unknown,
): CategoryIconScopeInput {
  exact(value, [
    'protocolVersion',
    'context',
    'operation',
    'payload',
    'mediaSnapshot',
    'clientRequestId',
    'draftRevision',
    'slot',
    'declaration',
  ]);
  if (
    value.protocolVersion !== 5 ||
    !ratingScopedDigest(value.mediaSnapshot) ||
    !ratingId(value.clientRequestId) ||
    !ratingId(value.draftRevision) ||
    !isRecord(value.slot)
  )
    invalidRating();
  const text = decodeRatingCategoryScopedIntent({
    protocolVersion: 2,
    context: value.context,
    operation: value.operation,
    payload: value.payload,
  });
  if (text.payload.clientRequestId === value.clientRequestId) invalidRating();
  let slot: CategoryIconSlot;
  if (value.slot.kind === 'new') {
    exact(value.slot, ['kind', 'key']);
    if (
      typeof value.slot.key !== 'string' ||
      !/^[a-z][a-z0-9_]{0,31}$/.test(value.slot.key)
    )
      invalidRating();
    const keys =
      text.operation === 'create_categories_scoped'
        ? text.payload.nodes.map((n) => n.key)
        : text.operation === 'batch_update_subcategories_scoped'
          ? text.payload.addNodes.map((n) => n.key)
          : text.operation === 'create_system_category_scoped'
            ? ['root']
            : [];
    if (!keys.includes(value.slot.key)) invalidRating();
    slot = Object.freeze({ kind: 'new', key: value.slot.key });
  } else if (value.slot.kind === 'base') {
    exact(value.slot, ['kind', 'categoryId']);
    if (
      !ratingId(value.slot.categoryId) ||
      text.operation !== 'edit_category_base_scoped' ||
      text.payload.categoryId !== value.slot.categoryId
    )
      invalidRating();
    slot = Object.freeze({ kind: 'base', categoryId: value.slot.categoryId });
  } else {
    exact(value.slot, ['kind', 'categoryId', 'campusId']);
    if (
      value.slot.kind !== 'override' ||
      !ratingId(value.slot.categoryId) ||
      !ratingId(value.slot.campusId) ||
      text.operation !== 'set_category_override_scoped' ||
      text.payload.categoryId !== value.slot.categoryId ||
      text.context.selector.kind !== 'campus' ||
      text.context.selector.campusId !== value.slot.campusId
    )
      invalidRating();
    slot = Object.freeze({
      kind: 'override',
      categoryId: value.slot.categoryId,
      campusId: value.slot.campusId,
    });
  }
  return Object.freeze({
    ...text,
    protocolVersion: 5,
    mediaSnapshot: value.mediaSnapshot,
    clientRequestId: value.clientRequestId,
    draftRevision: value.draftRevision,
    slot,
    declaration: decodeCategoryIconDeclaration(value.declaration),
  }) as CategoryIconScopeInput;
}
export function categoryIconScopeRequestHash(
  input: CategoryIconScopeInput,
): string {
  return sha256(
    'ratings-category-icon-upload-scope:v1:' +
      canonicalRatingScopedJson(decodeCategoryIconScopeInput(input)),
  );
}
export function decodeCategoryIconScope(value: unknown): CategoryIconScope {
  exact(value, [
    'editScopeId',
    'scopeRevision',
    'categoryId',
    'identityId',
    'expiresAt',
  ]);
  if (
    !ratingId(value.editScopeId) ||
    !ratingScopedDigest(value.scopeRevision) ||
    !ratingId(value.categoryId) ||
    !ratingId(value.identityId) ||
    !ratingTimestamp(value.expiresAt)
  )
    invalidRating();
  return Object.freeze({ ...value }) as unknown as CategoryIconScope;
}
export function categoryIconPrepareForScope(
  input: CategoryIconScopeInput,
  scope: CategoryIconScope,
): CategoryIconPrepare {
  if (input.slot.kind !== 'new' && input.slot.categoryId !== scope.categoryId)
    invalidRating();
  return Object.freeze({
    protocol: 'ratings-category-icon-media-v1',
    clientRequestId: input.clientRequestId,
    editScopeId: scope.editScopeId,
    scopeRevision: scope.scopeRevision,
    slot: 'icon',
    declaration: input.declaration,
  });
}
export function decodeCategoryIconScopeRecovery(
  value: unknown,
): CategoryIconScopeRecovery {
  exact(value, ['state', 'scope', 'recovery']);
  if (
    value.state !== 'known' &&
    value.state !== 'unknown' &&
    value.state !== 'cancelled'
  )
    invalidRating();
  const scope =
      value.scope === null ? null : decodeCategoryIconScope(value.scope),
    recovery =
      value.recovery === null
        ? null
        : decodeCategoryIconRecovery(value.recovery);
  if (
    (value.state === 'known' && !scope) ||
    (value.state === 'unknown' && (scope !== null || recovery !== null))
  )
    invalidRating();
  if (
    scope &&
    recovery?.state === 'recorded' &&
    recovery.status.editScopeId !== scope.editScopeId
  )
    invalidRating();
  return Object.freeze({ state: value.state, scope, recovery });
}
