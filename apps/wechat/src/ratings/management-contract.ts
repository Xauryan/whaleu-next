import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import {
  canonicalRatingText,
  invalidRating,
  ratingId,
  ratingCursor,
} from './contract';
import { ratingNullableId, ratingTimestamp } from './discussion-contract';

export interface RatingTargetCreationInput {
  readonly clientRequestId: string;
  readonly regionId: string | null;
  readonly categoryId: string;
  readonly expectedCategoryRevision: string;
  readonly expectedCatalogRevision: string;
  readonly name: string;
  readonly description: string;
  readonly assetIds: readonly [];
}
export interface RatingTargetCreationIntent {
  readonly operation: 'create_target';
  readonly payload: RatingTargetCreationInput;
}
export interface RatingTargetPreparation {
  readonly requestId: string;
  readonly targetId: string;
  readonly revision: string;
  readonly contextRevision: string;
}
export const ratingCreationRejections = [
  'RATING_CREATION_CONTEXT_CHANGED',
  'CONTENT_REJECTED',
  'RATING_CREATION_CANCELLED',
] as const;
export type RatingTargetCreationReceipt =
  | {
      readonly requestId: string;
      readonly operation: 'create_target';
      readonly outcome: 'rejected';
      readonly code: (typeof ratingCreationRejections)[number];
    }
  | {
      readonly requestId: string;
      readonly operation: 'create_target';
      readonly outcome: 'applied';
      readonly targetId: string;
      readonly revision: string;
      readonly catalogRevision: string;
      readonly occurredAt: string;
    };
export function decodeRatingTargetCreationInput(
  value: unknown,
): RatingTargetCreationInput {
  exact(value, [
    'clientRequestId',
    'regionId',
    'categoryId',
    'expectedCategoryRevision',
    'expectedCatalogRevision',
    'name',
    'description',
    'assetIds',
  ]);
  if (
    !ratingId(value.clientRequestId) ||
    !ratingNullableId(value.regionId) ||
    !ratingId(value.categoryId) ||
    !ratingId(value.expectedCategoryRevision) ||
    !ratingId(value.expectedCatalogRevision) ||
    !Array.isArray(value.assetIds) ||
    value.assetIds.length !== 0
  )
    invalidRating();
  return Object.freeze({
    clientRequestId: value.clientRequestId,
    regionId: value.regionId,
    categoryId: value.categoryId,
    expectedCategoryRevision: value.expectedCategoryRevision,
    expectedCatalogRevision: value.expectedCatalogRevision,
    name: canonicalRatingText(value.name, 100),
    description: canonicalRatingText(value.description, 500, false),
    assetIds: Object.freeze([]) as readonly [],
  });
}
export function decodeRatingTargetCreationIntent(
  value: unknown,
): RatingTargetCreationIntent {
  exact(value, ['operation', 'payload']);
  if (value.operation !== 'create_target') invalidRating();
  return Object.freeze({
    operation: 'create_target',
    payload: decodeRatingTargetCreationInput(value.payload),
  });
}
export function decodeRatingTargetPreparation(
  value: unknown,
): RatingTargetPreparation {
  exact(value, ['requestId', 'targetId', 'revision', 'contextRevision']);
  if (
    !ratingId(value.requestId) ||
    !ratingId(value.targetId) ||
    !ratingId(value.revision) ||
    !ratingCursor(value.contextRevision)
  )
    invalidRating();
  return Object.freeze({
    requestId: value.requestId,
    targetId: value.targetId,
    revision: value.revision,
    contextRevision: value.contextRevision,
  });
}
export function decodeRatingTargetCreationReceipt(
  value: unknown,
): RatingTargetCreationReceipt {
  if (!isRecord(value)) invalidRating();
  if (value.outcome === 'rejected') {
    exact(value, ['requestId', 'operation', 'outcome', 'code']);
    if (
      !ratingId(value.requestId) ||
      value.operation !== 'create_target' ||
      !(ratingCreationRejections as readonly unknown[]).includes(value.code)
    )
      invalidRating();
    return Object.freeze({
      requestId: value.requestId,
      operation: 'create_target',
      outcome: 'rejected',
      code: value.code as (typeof ratingCreationRejections)[number],
    });
  }
  exact(value, [
    'requestId',
    'operation',
    'outcome',
    'targetId',
    'revision',
    'catalogRevision',
    'occurredAt',
  ]);
  if (
    !ratingId(value.requestId) ||
    value.operation !== 'create_target' ||
    value.outcome !== 'applied' ||
    !ratingId(value.targetId) ||
    !ratingId(value.revision) ||
    !ratingId(value.catalogRevision) ||
    !ratingTimestamp(value.occurredAt)
  )
    invalidRating();
  return Object.freeze({
    requestId: value.requestId,
    operation: 'create_target',
    outcome: 'applied',
    targetId: value.targetId,
    revision: value.revision,
    catalogRevision: value.catalogRevision,
    occurredAt: value.occurredAt,
  });
}
export function matchRatingTargetCreationReceipt(
  intent: RatingTargetCreationIntent,
  receipt: RatingTargetCreationReceipt,
): void {
  if (
    receipt.requestId !== intent.payload.clientRequestId ||
    receipt.operation !== intent.operation
  )
    invalidRating();
}
