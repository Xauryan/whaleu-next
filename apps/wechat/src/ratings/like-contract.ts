import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import { invalidRating, ratingId, ratingRejections } from './contract';
import { ratingNullableId, ratingTimestamp } from './discussion-contract';

export interface RatingLikeSubject {
  readonly targetId: string;
  readonly rootId: string;
  readonly replyId: string | null;
}
export type RatingLikeState =
  | { readonly status: 'unavailable' }
  | (RatingLikeSubject & {
      readonly status: 'known';
      readonly count: number;
      readonly liked: boolean;
      readonly revision: string;
      readonly allowedActions: { readonly setLike: true };
    });
export function decodeRatingLikeState(value: unknown): RatingLikeState {
  if (!isRecord(value)) invalidRating();
  if (value.status === 'unavailable') {
    exact(value, ['status']);
    return Object.freeze({ status: 'unavailable' });
  }
  exact(value, [
    'status',
    'targetId',
    'rootId',
    'replyId',
    'count',
    'liked',
    'revision',
    'allowedActions',
  ]);
  exact(value.allowedActions, ['setLike']);
  if (
    value.status !== 'known' ||
    !ratingId(value.targetId) ||
    !ratingId(value.rootId) ||
    !ratingNullableId(value.replyId) ||
    !Number.isSafeInteger(value.count) ||
    (value.count as number) < 0 ||
    (value.count as number) > 2147483647 ||
    typeof value.liked !== 'boolean' ||
    !ratingId(value.revision) ||
    value.allowedActions.setLike !== true
  )
    invalidRating();
  return Object.freeze({
    status: 'known',
    targetId: value.targetId,
    rootId: value.rootId,
    replyId: value.replyId,
    count: value.count as number,
    liked: value.liked,
    revision: value.revision,
    allowedActions: Object.freeze({ setLike: true }),
  });
}
interface LikePayload {
  readonly clientRequestId: string;
  readonly regionId: string | null;
  readonly targetId: string;
  readonly expectedTargetRevision: string;
  readonly expectedRevision: string;
  readonly expectedLikeRevision: string;
  readonly liked: boolean;
}
export type RatingLikeIntent =
  | {
      readonly operation: 'set_comment_like';
      readonly rootId: string;
      readonly payload: LikePayload;
    }
  | {
      readonly operation: 'set_reply_like';
      readonly replyId: string;
      readonly payload: LikePayload & {
        readonly rootId: string;
        readonly expectedRootRevision: string;
      };
    };
export function decodeRatingLikeIntent(value: unknown): RatingLikeIntent {
  if (!isRecord(value)) invalidRating();
  const root = value.operation === 'set_comment_like';
  exact(value, ['operation', root ? 'rootId' : 'replyId', 'payload']);
  if (
    (!root && value.operation !== 'set_reply_like') ||
    !ratingId(root ? value.rootId : value.replyId)
  )
    invalidRating();
  exact(value.payload, [
    'clientRequestId',
    'regionId',
    'targetId',
    'expectedTargetRevision',
    'expectedRevision',
    'expectedLikeRevision',
    'liked',
    ...(!root ? ['rootId', 'expectedRootRevision'] : []),
  ]);
  const p = value.payload;
  if (
    !ratingId(p.clientRequestId) ||
    !ratingNullableId(p.regionId) ||
    !ratingId(p.targetId) ||
    !ratingId(p.expectedTargetRevision) ||
    !ratingId(p.expectedRevision) ||
    !ratingId(p.expectedLikeRevision) ||
    typeof p.liked !== 'boolean'
  )
    invalidRating();
  const payload = {
    clientRequestId: p.clientRequestId,
    regionId: p.regionId,
    targetId: p.targetId,
    expectedTargetRevision: p.expectedTargetRevision,
    expectedRevision: p.expectedRevision,
    expectedLikeRevision: p.expectedLikeRevision,
    liked: p.liked,
  };
  if (root)
    return Object.freeze({
      operation: 'set_comment_like',
      rootId: value.rootId as string,
      payload: Object.freeze(payload),
    });
  if (!ratingId(p.rootId) || !ratingId(p.expectedRootRevision)) invalidRating();
  return Object.freeze({
    operation: 'set_reply_like',
    replyId: value.replyId as string,
    payload: Object.freeze({
      ...payload,
      rootId: p.rootId,
      expectedRootRevision: p.expectedRootRevision,
    }),
  });
}
export type RatingLikeReceipt =
  | (RatingLikeSubject & {
      readonly requestId: string;
      readonly operation: RatingLikeIntent['operation'];
      readonly outcome: 'applied' | 'noop';
      readonly liked: boolean;
      readonly revision: string;
      readonly occurredAt: string;
    })
  | {
      readonly requestId: string;
      readonly operation: RatingLikeIntent['operation'];
      readonly outcome: 'rejected';
      readonly code: (typeof ratingRejections)[number];
    };
export function decodeRatingLikeReceipt(value: unknown): RatingLikeReceipt {
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
          'replyId',
          'liked',
          'revision',
          'occurredAt',
        ],
  );
  if (
    !ratingId(value.requestId) ||
    !['set_comment_like', 'set_reply_like'].includes(String(value.operation))
  )
    invalidRating();
  const operation = value.operation as RatingLikeIntent['operation'];
  if (value.outcome === 'rejected') {
    if (!(ratingRejections as readonly unknown[]).includes(value.code))
      invalidRating();
    return Object.freeze({
      requestId: value.requestId,
      operation,
      outcome: 'rejected',
      code: value.code as (typeof ratingRejections)[number],
    });
  }
  if (
    !['applied', 'noop'].includes(String(value.outcome)) ||
    !ratingId(value.targetId) ||
    !ratingId(value.rootId) ||
    (operation === 'set_comment_like'
      ? value.replyId !== null
      : !ratingId(value.replyId)) ||
    typeof value.liked !== 'boolean' ||
    !ratingId(value.revision) ||
    !ratingTimestamp(value.occurredAt)
  )
    invalidRating();
  return Object.freeze({
    requestId: value.requestId,
    operation,
    outcome: value.outcome as 'applied' | 'noop',
    targetId: value.targetId,
    rootId: value.rootId,
    replyId: value.replyId as string | null,
    liked: value.liked,
    revision: value.revision,
    occurredAt: value.occurredAt,
  });
}
export function matchRatingLikeReceipt(
  intent: RatingLikeIntent,
  receipt: RatingLikeReceipt,
): void {
  if (
    receipt.operation !== intent.operation ||
    receipt.requestId !== intent.payload.clientRequestId ||
    (receipt.outcome !== 'rejected' &&
      (receipt.targetId !== intent.payload.targetId ||
        receipt.rootId !==
          (intent.operation === 'set_comment_like'
            ? intent.rootId
            : intent.payload.rootId) ||
        receipt.replyId !==
          (intent.operation === 'set_comment_like' ? null : intent.replyId) ||
        receipt.liked !== intent.payload.liked))
  )
    invalidRating();
}
export function matchRatingLikeState(
  subject: RatingLikeSubject,
  state: RatingLikeState,
): void {
  if (
    state.status === 'known' &&
    (state.targetId !== subject.targetId ||
      state.rootId !== subject.rootId ||
      state.replyId !== subject.replyId)
  )
    invalidRating();
}
