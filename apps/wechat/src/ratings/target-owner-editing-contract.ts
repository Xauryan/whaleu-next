import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import {
  canonicalRatingText,
  invalidRating,
  ratingCursor,
  ratingId,
} from './contract';
import { ratingNullableId, ratingTimestamp } from './discussion-contract';

export interface RatingTargetOwnerEditingLocator {
  readonly targetId: string;
}
export interface RatingTargetOwnerEditingContext {
  readonly targetId: string;
  readonly revision: string;
  readonly definitionRevision: string;
  readonly contentVersion: number;
  readonly regionId: string | null;
  readonly categoryId: string;
  readonly categoryRevision: string;
  readonly catalogRevision: string;
  readonly name: string;
  readonly description: string;
}
export interface RatingTargetOwnerEditingInput {
  readonly clientRequestId: string;
  readonly targetId: string;
  readonly regionId: string | null;
  readonly expectedTargetRevision: string;
  readonly expectedDefinitionRevision: string;
  readonly expectedContentVersion: number;
  readonly categoryId: string;
  readonly expectedCategoryRevision: string;
  readonly expectedCatalogRevision: string;
  readonly name: string;
  readonly description: string;
  readonly assetIds: readonly [];
}
export interface RatingTargetOwnerEditingIntent {
  readonly operation: 'edit_target';
  readonly payload: RatingTargetOwnerEditingInput;
}
export interface RatingTargetOwnerEditingPreparation {
  readonly requestId: string;
  readonly targetId: string;
  readonly revision: string;
  readonly definitionRevision: string;
  readonly contentVersion: number;
  readonly contextRevision: string;
}
export const ratingTargetOwnerEditingRejections = [
  'RATING_EDIT_CONTEXT_CHANGED',
  'CONTENT_REJECTED',
  'RATING_EDIT_CANCELLED',
  'RATING_NOT_FOUND',
  'PHONE_VERIFICATION_REQUIRED',
  'AFFILIATION_VERIFICATION_REQUIRED',
  'IDENTITY_CAMPUS_REQUIRED',
  'SAFETY_ACTION_RESTRICTED',
] as const;
export type RatingTargetOwnerEditingReceipt =
  | {
      readonly requestId: string;
      readonly operation: 'edit_target';
      readonly outcome: 'applied' | 'noop';
      readonly targetId: string;
      readonly revision: string;
      readonly definitionRevision: string;
      readonly contentVersion: number;
      readonly occurredAt: string;
    }
  | {
      readonly requestId: string;
      readonly operation: 'edit_target';
      readonly outcome: 'rejected';
      readonly code: (typeof ratingTargetOwnerEditingRejections)[number];
    };
export type RatingTargetOwnerEditingPrepared =
  | RatingTargetOwnerEditingPreparation
  | Extract<RatingTargetOwnerEditingReceipt, { outcome: 'rejected' }>;
const version = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 1 &&
  value <= 2147483647;
export function decodeRatingTargetOwnerEditingLocator(
  value: unknown,
): RatingTargetOwnerEditingLocator {
  exact(value, ['targetId']);
  if (!ratingId(value.targetId)) invalidRating();
  return Object.freeze({ targetId: value.targetId });
}
export function ratingTargetOwnerEditingPath(targetId: string): string {
  if (!ratingId(targetId)) invalidRating();
  return `/pages/target-owner-edit/target-owner-edit?targetId=${targetId}`;
}
export function decodeRatingTargetOwnerEditingContext(
  value: unknown,
): RatingTargetOwnerEditingContext {
  exact(value, [
    'targetId',
    'revision',
    'definitionRevision',
    'contentVersion',
    'regionId',
    'categoryId',
    'categoryRevision',
    'catalogRevision',
    'name',
    'description',
  ]);
  if (
    !ratingId(value.targetId) ||
    !ratingId(value.revision) ||
    !ratingId(value.definitionRevision) ||
    !version(value.contentVersion) ||
    value.contentVersion > 2147483646 ||
    !ratingNullableId(value.regionId) ||
    !ratingId(value.categoryId) ||
    !ratingId(value.categoryRevision) ||
    !ratingId(value.catalogRevision)
  )
    invalidRating();
  const name = canonicalRatingText(value.name, 100),
    description = canonicalRatingText(value.description, 500, false);
  if (name !== value.name || description !== value.description) invalidRating();
  return Object.freeze({
    targetId: value.targetId,
    revision: value.revision,
    definitionRevision: value.definitionRevision,
    contentVersion: value.contentVersion,
    regionId: value.regionId,
    categoryId: value.categoryId,
    categoryRevision: value.categoryRevision,
    catalogRevision: value.catalogRevision,
    name,
    description,
  });
}
export function decodeRatingTargetOwnerEditingIntent(
  value: unknown,
): RatingTargetOwnerEditingIntent {
  exact(value, ['operation', 'payload']);
  exact(value.payload, [
    'clientRequestId',
    'targetId',
    'regionId',
    'expectedTargetRevision',
    'expectedDefinitionRevision',
    'expectedContentVersion',
    'categoryId',
    'expectedCategoryRevision',
    'expectedCatalogRevision',
    'name',
    'description',
    'assetIds',
  ]);
  const p = value.payload;
  if (
    value.operation !== 'edit_target' ||
    !ratingId(p.clientRequestId) ||
    !ratingId(p.targetId) ||
    !ratingNullableId(p.regionId) ||
    !ratingId(p.expectedTargetRevision) ||
    !ratingId(p.expectedDefinitionRevision) ||
    !version(p.expectedContentVersion) ||
    p.expectedContentVersion > 2147483646 ||
    !ratingId(p.categoryId) ||
    !ratingId(p.expectedCategoryRevision) ||
    !ratingId(p.expectedCatalogRevision) ||
    !Array.isArray(p.assetIds) ||
    p.assetIds.length !== 0
  )
    invalidRating();
  return Object.freeze({
    operation: 'edit_target',
    payload: Object.freeze({
      clientRequestId: p.clientRequestId,
      targetId: p.targetId,
      regionId: p.regionId,
      expectedTargetRevision: p.expectedTargetRevision,
      expectedDefinitionRevision: p.expectedDefinitionRevision,
      expectedContentVersion: p.expectedContentVersion,
      categoryId: p.categoryId,
      expectedCategoryRevision: p.expectedCategoryRevision,
      expectedCatalogRevision: p.expectedCatalogRevision,
      name: canonicalRatingText(p.name, 100),
      description: canonicalRatingText(p.description, 500, false),
      assetIds: Object.freeze([]) as readonly [],
    }),
  });
}
export function decodeRatingTargetOwnerEditingPreparation(
  value: unknown,
): RatingTargetOwnerEditingPreparation {
  exact(value, [
    'requestId',
    'targetId',
    'revision',
    'definitionRevision',
    'contentVersion',
    'contextRevision',
  ]);
  if (
    !ratingId(value.requestId) ||
    !ratingId(value.targetId) ||
    !ratingId(value.revision) ||
    !ratingId(value.definitionRevision) ||
    !version(value.contentVersion) ||
    value.contentVersion < 2 ||
    !ratingCursor(value.contextRevision)
  )
    invalidRating();
  return Object.freeze({
    requestId: value.requestId,
    targetId: value.targetId,
    revision: value.revision,
    definitionRevision: value.definitionRevision,
    contentVersion: value.contentVersion,
    contextRevision: value.contextRevision,
  });
}
export function matchRatingTargetOwnerEditingPreparation(
  intent: RatingTargetOwnerEditingIntent,
  preparation: RatingTargetOwnerEditingPreparation,
): void {
  const p = intent.payload;
  if (
    preparation.requestId !== p.clientRequestId ||
    preparation.targetId !== p.targetId ||
    preparation.revision === p.expectedTargetRevision ||
    preparation.definitionRevision === p.expectedDefinitionRevision ||
    preparation.contentVersion !== p.expectedContentVersion + 1
  )
    invalidRating();
}
export function decodeRatingTargetOwnerEditingReceipt(
  value: unknown,
): RatingTargetOwnerEditingReceipt {
  if (!isRecord(value)) invalidRating();
  if (value.outcome === 'rejected') {
    exact(value, ['requestId', 'operation', 'outcome', 'code']);
    if (
      !ratingId(value.requestId) ||
      value.operation !== 'edit_target' ||
      !(ratingTargetOwnerEditingRejections as readonly unknown[]).includes(
        value.code,
      )
    )
      invalidRating();
    return Object.freeze({
      requestId: value.requestId,
      operation: 'edit_target',
      outcome: 'rejected',
      code: value.code as (typeof ratingTargetOwnerEditingRejections)[number],
    });
  }
  exact(value, [
    'requestId',
    'operation',
    'outcome',
    'targetId',
    'revision',
    'definitionRevision',
    'contentVersion',
    'occurredAt',
  ]);
  if (
    !ratingId(value.requestId) ||
    value.operation !== 'edit_target' ||
    (value.outcome !== 'applied' && value.outcome !== 'noop') ||
    !ratingId(value.targetId) ||
    !ratingId(value.revision) ||
    !ratingId(value.definitionRevision) ||
    !version(value.contentVersion) ||
    !ratingTimestamp(value.occurredAt)
  )
    invalidRating();
  return Object.freeze({
    requestId: value.requestId,
    operation: 'edit_target',
    outcome: value.outcome,
    targetId: value.targetId,
    revision: value.revision,
    definitionRevision: value.definitionRevision,
    contentVersion: value.contentVersion,
    occurredAt: value.occurredAt,
  });
}
export function decodeRatingTargetOwnerEditingPrepared(
  value: unknown,
): RatingTargetOwnerEditingPrepared {
  if (isRecord(value) && value.outcome === 'rejected') {
    const receipt = decodeRatingTargetOwnerEditingReceipt(value);
    if (receipt.outcome !== 'rejected') invalidRating();
    return receipt;
  }
  return decodeRatingTargetOwnerEditingPreparation(value);
}
export function matchRatingTargetOwnerEditingReceipt(
  intent: RatingTargetOwnerEditingIntent,
  receipt: RatingTargetOwnerEditingReceipt,
): void {
  const p = intent.payload;
  if (
    receipt.requestId !== p.clientRequestId ||
    receipt.operation !== intent.operation
  )
    invalidRating();
  if (receipt.outcome === 'rejected') return;
  if (
    receipt.targetId !== p.targetId ||
    (receipt.outcome === 'noop'
      ? receipt.revision !== p.expectedTargetRevision ||
        receipt.definitionRevision !== p.expectedDefinitionRevision ||
        receipt.contentVersion !== p.expectedContentVersion
      : receipt.revision === p.expectedTargetRevision ||
        receipt.definitionRevision === p.expectedDefinitionRevision ||
        receipt.contentVersion !== p.expectedContentVersion + 1)
  )
    invalidRating();
}
