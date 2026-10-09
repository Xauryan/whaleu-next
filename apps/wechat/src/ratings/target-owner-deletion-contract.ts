import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import { invalidRating, ratingId } from './contract';
import { ratingTimestamp } from './discussion-contract';

export interface RatingTargetOwnerDeletionLocator {
  readonly targetId: string;
}
export interface RatingTargetOwnerDeletionContext {
  readonly targetId: string;
  readonly revision: string;
  readonly deletion: { readonly kind: 'not_owner_deleted' | 'owner_deleted' };
}
export interface RatingTargetOwnerDeletionIntent {
  readonly operation: 'delete_target';
  readonly payload: {
    readonly clientRequestId: string;
    readonly targetId: string;
    readonly expectedTargetRevision: string;
  };
}
export const ratingTargetOwnerDeletionRejections = [
  'RATING_NOT_FOUND',
  'RATING_REVISION_CONFLICT',
  'PHONE_VERIFICATION_REQUIRED',
  'SAFETY_ACTION_RESTRICTED',
  'RATING_TARGET_DELETION_CANCELLED',
] as const;
export type RatingTargetOwnerDeletionReceipt =
  | {
      readonly requestId: string;
      readonly operation: 'delete_target';
      readonly outcome: 'applied' | 'noop';
      readonly targetId: string;
      readonly revision: string;
      readonly occurredAt: string;
    }
  | {
      readonly requestId: string;
      readonly operation: 'delete_target';
      readonly outcome: 'rejected';
      readonly code: (typeof ratingTargetOwnerDeletionRejections)[number];
    };
export function decodeRatingTargetOwnerDeletionLocator(
  value: unknown,
): RatingTargetOwnerDeletionLocator {
  exact(value, ['targetId']);
  if (!ratingId(value.targetId)) invalidRating();
  return Object.freeze({ targetId: value.targetId });
}
export function ratingTargetOwnerDeletionPath(targetId: string): string {
  if (!ratingId(targetId)) invalidRating();
  return `/pages/target-owner-delete/target-owner-delete?targetId=${targetId}`;
}
export function decodeRatingTargetOwnerDeletionContext(
  value: unknown,
): RatingTargetOwnerDeletionContext {
  exact(value, ['targetId', 'revision', 'deletion']);
  exact(value.deletion, ['kind']);
  if (
    !ratingId(value.targetId) ||
    !ratingId(value.revision) ||
    (value.deletion.kind !== 'not_owner_deleted' &&
      value.deletion.kind !== 'owner_deleted')
  )
    invalidRating();
  return Object.freeze({
    targetId: value.targetId,
    revision: value.revision,
    deletion: Object.freeze({ kind: value.deletion.kind }),
  });
}
export function decodeRatingTargetOwnerDeletionIntent(
  value: unknown,
): RatingTargetOwnerDeletionIntent {
  exact(value, ['operation', 'payload']);
  exact(value.payload, [
    'clientRequestId',
    'targetId',
    'expectedTargetRevision',
  ]);
  const payload = value.payload;
  if (
    value.operation !== 'delete_target' ||
    !ratingId(payload.clientRequestId) ||
    !ratingId(payload.targetId) ||
    !ratingId(payload.expectedTargetRevision)
  )
    invalidRating();
  return Object.freeze({
    operation: 'delete_target',
    payload: Object.freeze({
      clientRequestId: payload.clientRequestId,
      targetId: payload.targetId,
      expectedTargetRevision: payload.expectedTargetRevision,
    }),
  });
}
export function decodeRatingTargetOwnerDeletionReceipt(
  value: unknown,
): RatingTargetOwnerDeletionReceipt {
  if (!isRecord(value)) invalidRating();
  if (value.outcome === 'rejected') {
    exact(value, ['requestId', 'operation', 'outcome', 'code']);
    if (
      !ratingId(value.requestId) ||
      value.operation !== 'delete_target' ||
      !(ratingTargetOwnerDeletionRejections as readonly unknown[]).includes(
        value.code,
      )
    )
      invalidRating();
    return Object.freeze({
      requestId: value.requestId,
      operation: 'delete_target',
      outcome: 'rejected',
      code: value.code as (typeof ratingTargetOwnerDeletionRejections)[number],
    });
  }
  exact(value, [
    'requestId',
    'operation',
    'outcome',
    'targetId',
    'revision',
    'occurredAt',
  ]);
  if (
    !ratingId(value.requestId) ||
    value.operation !== 'delete_target' ||
    (value.outcome !== 'applied' && value.outcome !== 'noop') ||
    !ratingId(value.targetId) ||
    !ratingId(value.revision) ||
    !ratingTimestamp(value.occurredAt)
  )
    invalidRating();
  return Object.freeze({
    requestId: value.requestId,
    operation: 'delete_target',
    outcome: value.outcome,
    targetId: value.targetId,
    revision: value.revision,
    occurredAt: value.occurredAt,
  });
}
export function matchRatingTargetOwnerDeletionReceipt(
  intent: RatingTargetOwnerDeletionIntent,
  receipt: RatingTargetOwnerDeletionReceipt,
): void {
  if (
    receipt.requestId !== intent.payload.clientRequestId ||
    receipt.operation !== intent.operation ||
    (receipt.outcome !== 'rejected' &&
      (receipt.targetId !== intent.payload.targetId ||
        (receipt.outcome === 'noop'
          ? receipt.revision !== intent.payload.expectedTargetRevision
          : receipt.revision === intent.payload.expectedTargetRevision)))
  )
    invalidRating();
}
