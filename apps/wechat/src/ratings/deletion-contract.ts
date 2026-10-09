import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import { invalidRating, ratingId, type RatingIntent } from './contract';
import {
  ratingNullableId,
  ratingTimestamp,
  type RatingReplyIntent,
} from './discussion-contract';

export type RatingDeletionAuthority = 'owner' | 'admin';
export interface RatingDeletionLocator {
  readonly subjectKind: 'comment' | 'reply';
  readonly targetId: string;
  readonly rootId: string;
  readonly subjectId: string;
}
export interface RatingDeletionContext extends RatingDeletionLocator {
  readonly regionId: string | null;
  readonly targetRevision: string;
  readonly rootRevision: string;
  readonly revision: string;
  readonly deleted: boolean;
}
export interface RatingAdminDeletionContext extends RatingDeletionContext {
  readonly contextRevision: string;
}
const contextRevision = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export function decodeRatingDeletionLocator(
  value: unknown,
): RatingDeletionLocator {
  exact(value, ['subjectKind', 'targetId', 'rootId', 'subjectId']);
  if (
    !['comment', 'reply'].includes(String(value.subjectKind)) ||
    !ratingId(value.targetId) ||
    !ratingId(value.rootId) ||
    !ratingId(value.subjectId) ||
    (value.subjectKind === 'comment' && value.rootId !== value.subjectId)
  )
    invalidRating();
  return Object.freeze({
    subjectKind: value.subjectKind as 'comment' | 'reply',
    targetId: value.targetId,
    rootId: value.rootId,
    subjectId: value.subjectId,
  });
}
export function decodeRatingDeletionContext(
  value: unknown,
): RatingDeletionContext {
  return decodeContext(value, false);
}
export function decodeRatingAdminDeletionContext(
  value: unknown,
): RatingAdminDeletionContext {
  return decodeContext(value, true) as RatingAdminDeletionContext;
}
function decodeContext(
  value: unknown,
  admin: boolean,
): RatingDeletionContext | RatingAdminDeletionContext {
  exact(value, [
    'subjectKind',
    'targetId',
    'rootId',
    'subjectId',
    'regionId',
    'targetRevision',
    'rootRevision',
    'revision',
    'deleted',
    ...(admin ? ['contextRevision'] : []),
  ]);
  const locator = decodeRatingDeletionLocator({
    subjectKind: value.subjectKind,
    targetId: value.targetId,
    rootId: value.rootId,
    subjectId: value.subjectId,
  });
  if (
    !ratingNullableId(value.regionId) ||
    !ratingId(value.targetRevision) ||
    !ratingId(value.rootRevision) ||
    !ratingId(value.revision) ||
    typeof value.deleted !== 'boolean' ||
    (locator.subjectKind === 'comment' &&
      value.rootRevision !== value.revision) ||
    (admin && !contextRevision(value.contextRevision))
  )
    invalidRating();
  return Object.freeze({
    ...locator,
    regionId: value.regionId,
    targetRevision: value.targetRevision,
    rootRevision: value.rootRevision,
    revision: value.revision,
    deleted: value.deleted,
    ...(admin ? { contextRevision: value.contextRevision as string } : {}),
  });
}
export function matchRatingDeletionContext(
  locator: RatingDeletionLocator,
  context: RatingDeletionContext,
): void {
  if (
    locator.subjectKind !== context.subjectKind ||
    locator.targetId !== context.targetId ||
    locator.rootId !== context.rootId ||
    locator.subjectId !== context.subjectId
  )
    invalidRating();
}
interface AdminPayload {
  readonly clientRequestId: string;
  readonly targetId: string;
  readonly expectedTargetRevision: string;
  readonly expectedRevision: string;
  readonly expectedContextRevision: string;
}
export type RatingAdminDeletionIntent =
  | {
      readonly operation: 'admin_delete_comment';
      readonly subjectId: string;
      readonly payload: AdminPayload;
    }
  | {
      readonly operation: 'admin_delete_reply';
      readonly subjectId: string;
      readonly payload: AdminPayload & {
        readonly rootId: string;
        readonly expectedRootRevision: string;
      };
    };
export function decodeRatingAdminDeletionIntent(
  value: unknown,
): RatingAdminDeletionIntent {
  exact(value, ['operation', 'subjectId', 'payload']);
  const reply = value.operation === 'admin_delete_reply';
  if (
    (!reply && value.operation !== 'admin_delete_comment') ||
    !ratingId(value.subjectId)
  )
    invalidRating();
  exact(value.payload, [
    'clientRequestId',
    'targetId',
    'expectedTargetRevision',
    'expectedRevision',
    'expectedContextRevision',
    ...(reply ? ['rootId', 'expectedRootRevision'] : []),
  ]);
  const p = value.payload;
  if (
    !ratingId(p.clientRequestId) ||
    !ratingId(p.targetId) ||
    !ratingId(p.expectedTargetRevision) ||
    !ratingId(p.expectedRevision) ||
    !contextRevision(p.expectedContextRevision)
  )
    invalidRating();
  const payload = {
    clientRequestId: p.clientRequestId,
    targetId: p.targetId,
    expectedTargetRevision: p.expectedTargetRevision,
    expectedRevision: p.expectedRevision,
    expectedContextRevision: p.expectedContextRevision,
  };
  if (!reply)
    return Object.freeze({
      operation: 'admin_delete_comment',
      subjectId: value.subjectId,
      payload: Object.freeze(payload),
    });
  if (!ratingId(p.rootId) || !ratingId(p.expectedRootRevision)) invalidRating();
  return Object.freeze({
    operation: 'admin_delete_reply',
    subjectId: value.subjectId,
    payload: Object.freeze({
      ...payload,
      rootId: p.rootId,
      expectedRootRevision: p.expectedRootRevision,
    }),
  });
}
const adminRejections = [
  'RATING_NOT_FOUND',
  'RATING_REVISION_CONFLICT',
  'PHONE_VERIFICATION_REQUIRED',
  'SAFETY_ACTION_RESTRICTED',
] as const;
export type RatingAdminDeletionReceipt =
  | {
      readonly requestId: string;
      readonly operation: RatingAdminDeletionIntent['operation'];
      readonly outcome: 'applied' | 'noop';
      readonly targetId: string;
      readonly rootId: string;
      readonly subjectId: string;
      readonly revision: string;
      readonly occurredAt: string;
    }
  | {
      readonly requestId: string;
      readonly operation: RatingAdminDeletionIntent['operation'];
      readonly outcome: 'rejected';
      readonly code: (typeof adminRejections)[number];
    };
export function decodeRatingAdminDeletionReceipt(
  value: unknown,
): RatingAdminDeletionReceipt {
  if (!isRecord(value)) invalidRating();
  exact(
    value,
    value.outcome === 'rejected'
      ? ['requestId', 'operation', 'outcome', 'code']
      : [
          'requestId',
          'operation',
          'outcome',
          'targetId',
          'rootId',
          'subjectId',
          'revision',
          'occurredAt',
        ],
  );
  if (
    !ratingId(value.requestId) ||
    !['admin_delete_comment', 'admin_delete_reply'].includes(
      String(value.operation),
    )
  )
    invalidRating();
  const operation = value.operation as RatingAdminDeletionIntent['operation'];
  if (value.outcome === 'rejected') {
    if (!(adminRejections as readonly unknown[]).includes(value.code))
      invalidRating();
    return Object.freeze({
      requestId: value.requestId,
      operation,
      outcome: 'rejected',
      code: value.code as (typeof adminRejections)[number],
    });
  }
  if (
    !['applied', 'noop'].includes(String(value.outcome)) ||
    !ratingId(value.targetId) ||
    !ratingId(value.rootId) ||
    !ratingId(value.subjectId) ||
    !ratingId(value.revision) ||
    !ratingTimestamp(value.occurredAt) ||
    (operation === 'admin_delete_comment' && value.rootId !== value.subjectId)
  )
    invalidRating();
  return Object.freeze({
    requestId: value.requestId,
    operation,
    outcome: value.outcome as 'applied' | 'noop',
    targetId: value.targetId,
    rootId: value.rootId,
    subjectId: value.subjectId,
    revision: value.revision,
    occurredAt: value.occurredAt,
  });
}
export function matchRatingAdminDeletionReceipt(
  intent: RatingAdminDeletionIntent,
  receipt: RatingAdminDeletionReceipt,
): void {
  if (
    intent.operation !== receipt.operation ||
    intent.payload.clientRequestId !== receipt.requestId ||
    (receipt.outcome !== 'rejected' &&
      (receipt.subjectId !== intent.subjectId ||
        receipt.targetId !== intent.payload.targetId ||
        receipt.rootId !==
          (intent.operation === 'admin_delete_comment'
            ? intent.subjectId
            : intent.payload.rootId) ||
        (receipt.outcome === 'noop' &&
          receipt.revision !== intent.payload.expectedRevision)))
  )
    invalidRating();
}
/** Uses the server's minimal metadata and preserves the original owner wire contract. */
export function ratingOwnerDeletionIntent(
  context: RatingDeletionContext,
  clientRequestId: string,
): RatingIntent | RatingReplyIntent {
  const payload = {
    clientRequestId,
    regionId: context.regionId,
    targetId: context.targetId,
    expectedTargetRevision: context.targetRevision,
    expectedRevision: context.revision,
  };
  return context.subjectKind === 'comment'
    ? { operation: 'delete_comment', commentId: context.subjectId, payload }
    : {
        operation: 'delete_reply',
        replyId: context.subjectId,
        payload: {
          ...payload,
          rootId: context.rootId,
          expectedRootRevision: context.rootRevision,
        },
      };
}
export function ratingAdminDeletionIntent(
  context: RatingAdminDeletionContext,
  clientRequestId: string,
): RatingAdminDeletionIntent {
  const payload = {
    clientRequestId,
    targetId: context.targetId,
    expectedTargetRevision: context.targetRevision,
    expectedRevision: context.revision,
    expectedContextRevision: context.contextRevision,
  };
  return decodeRatingAdminDeletionIntent(
    context.subjectKind === 'comment'
      ? {
          operation: 'admin_delete_comment',
          subjectId: context.subjectId,
          payload,
        }
      : {
          operation: 'admin_delete_reply',
          subjectId: context.subjectId,
          payload: {
            ...payload,
            rootId: context.rootId,
            expectedRootRevision: context.rootRevision,
          },
        },
  );
}

export function ratingDeletionPath(raw: RatingDeletionLocator): string {
  const locator = decodeRatingDeletionLocator(raw);
  return `/pages/rating-deletion/rating-deletion?subjectKind=${locator.subjectKind}&targetId=${locator.targetId}&rootId=${locator.rootId}&subjectId=${locator.subjectId}`;
}
