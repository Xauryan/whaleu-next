import { isRecord } from '../api/errors';
import {
  decodePublicationCancellation,
  type PublicationCancellation,
} from '../media/batch-engine-contracts';
import { batchPublicationReference } from '../media/batch-publication';
import { decodeReceipt, type Receipt } from './contract';
import { exact, invalid, uuid4 } from './contract';
import type { PendingAttempt } from './pending-attempt';

/** Review state is never a terminal publication receipt or publication authority. */
export interface PublicationReview {
  readonly requestId: string;
  readonly operation: PendingAttempt['operation'];
  readonly status:
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'unavailable'
    | 'settled'
    | 'cancelled';
}

export function decodePublicationReview(value: unknown): PublicationReview {
  exact(value, ['requestId', 'operation', 'status']);
  if (
    !uuid4(value.requestId) ||
    !['publish_post', 'publish_comment', 'publish_reply'].includes(
      value.operation as string,
    ) ||
    ![
      'pending',
      'approved',
      'rejected',
      'unavailable',
      'settled',
      'cancelled',
    ].includes(value.status as string)
  )
    invalid();
  return Object.freeze({
    requestId: value.requestId,
    operation: value.operation as PublicationReview['operation'],
    status: value.status as PublicationReview['status'],
  });
}

export function matchPublicationReview(
  attempt: PendingAttempt,
  raw: unknown,
): PublicationReview {
  const result = decodePublicationReview(raw);
  if (
    result.requestId !== attempt.payload.clientRequestId ||
    result.operation !== attempt.operation
  )
    invalid();
  return result;
}

export function supportsTextReview(attempt: PendingAttempt): boolean {
  const payload = attempt.payload;
  if (
    attempt.operation === 'publish_post' &&
    attempt.payload.component?.kind === 'rating_target_link'
  )
    return (
      attempt.version === 5 &&
      attempt.payload.category === 'discussion' &&
      payload.imageAssetIds.length === 0 &&
      attempt.payload.syncToRelatedCampuses !== true &&
      attempt.payload.allowAnonymousDm === undefined &&
      !attempt.payload.feedback &&
      !attempt.payload.trading
    );
  if (
    attempt.operation === 'publish_post' &&
    attempt.payload.syncToRelatedCampuses === true
  )
    return true;
  return (
    ((attempt.operation === 'publish_post' &&
      attempt.payload.category === 'feedback') ||
      attempt.operation !== 'publish_post' ||
      (payload.authorMode === 'named' && payload.imageAssetIds.length === 0)) &&
    (attempt.operation !== 'publish_post' ||
      (attempt.payload.category !== 'trading' &&
        !attempt.payload.trading &&
        (!attempt.payload.component ||
          attempt.payload.component.kind === 'none') &&
        attempt.payload.commentsPolicy === 'open' &&
        attempt.payload.allowAnonymousDm !== true))
  );
}

/** Cancellation has its own exact fence, never an extension of Receipt. */
export type ReviewCancellationResult = Receipt | PublicationCancellation;
export function decodeReviewCancellationResult(
  raw: unknown,
): ReviewCancellationResult {
  return isRecord(raw) && raw.outcome === 'cancelled'
    ? decodePublicationCancellation(raw)
    : decodeReceipt(raw);
}
export function matchReviewCancellation(
  attempt: PendingAttempt,
  raw: unknown,
): ReviewCancellationResult {
  const result = decodeReviewCancellationResult(raw);
  if (
    result.requestId !== attempt.payload.clientRequestId ||
    result.operation !== attempt.operation ||
    (result.outcome === 'cancelled' &&
      result.intentHash !== batchPublicationReference(attempt).intentHash)
  )
    invalid();
  return result;
}
