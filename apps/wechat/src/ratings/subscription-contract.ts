import { isRecord } from '../api/errors';
import { exact } from '../community/contract';
import { invalidRating, ratingId, ratingRejections } from './contract';
import { ratingNullableId, ratingTimestamp } from './discussion-contract';

export type RatingSubscriptionState =
  | { readonly status: 'unavailable' }
  | {
      readonly status: 'known';
      readonly targetId: string;
      readonly subscribed: boolean;
      readonly count: number;
      readonly revision: string;
      readonly allowedActions: { readonly setSubscription: true };
    };
export function decodeRatingSubscriptionState(
  value: unknown,
): RatingSubscriptionState {
  if (!isRecord(value)) invalidRating();
  if (value.status === 'unavailable') {
    exact(value, ['status']);
    return Object.freeze({ status: 'unavailable' });
  }
  exact(value, [
    'status',
    'targetId',
    'subscribed',
    'count',
    'revision',
    'allowedActions',
  ]);
  exact(value.allowedActions, ['setSubscription']);
  if (
    value.status !== 'known' ||
    !ratingId(value.targetId) ||
    typeof value.subscribed !== 'boolean' ||
    !Number.isSafeInteger(value.count) ||
    (value.count as number) < 0 ||
    (value.count as number) > 2147483647 ||
    !ratingId(value.revision) ||
    value.allowedActions.setSubscription !== true
  )
    invalidRating();
  return Object.freeze({
    status: 'known',
    targetId: value.targetId,
    subscribed: value.subscribed,
    count: value.count as number,
    revision: value.revision,
    allowedActions: Object.freeze({ setSubscription: true }),
  });
}
export function matchRatingSubscriptionState(
  targetId: string,
  state: RatingSubscriptionState,
): void {
  if (state.status === 'known' && state.targetId !== targetId) invalidRating();
}
export interface RatingSubscriptionTarget {
  readonly targetId: string;
  readonly expectedTargetRevision: string;
}
export interface RatingSubscriptionQuery {
  readonly regionId: string | null;
  readonly targets: readonly RatingSubscriptionTarget[];
}
export function decodeRatingSubscriptionQuery(
  value: unknown,
): RatingSubscriptionQuery {
  exact(value, ['regionId', 'targets']);
  if (
    !ratingNullableId(value.regionId) ||
    !Array.isArray(value.targets) ||
    value.targets.length < 1 ||
    value.targets.length > 20
  )
    invalidRating();
  const targets = value.targets.map((raw: unknown) => {
    exact(raw, ['targetId', 'expectedTargetRevision']);
    if (!ratingId(raw.targetId) || !ratingId(raw.expectedTargetRevision))
      invalidRating();
    return Object.freeze({
      targetId: raw.targetId,
      expectedTargetRevision: raw.expectedTargetRevision,
    });
  });
  if (new Set(targets.map((item) => item.targetId)).size !== targets.length)
    invalidRating();
  return Object.freeze({
    regionId: value.regionId,
    targets: Object.freeze(targets),
  });
}
export interface RatingSubscriptionBatch {
  readonly items: readonly {
    readonly targetId: string;
    readonly state: RatingSubscriptionState;
  }[];
}
export function decodeRatingSubscriptionBatch(
  value: unknown,
): RatingSubscriptionBatch {
  exact(value, ['items']);
  if (
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > 20
  )
    invalidRating();
  const items = value.items.map((raw: unknown) => {
    exact(raw, ['targetId', 'state']);
    if (!ratingId(raw.targetId)) invalidRating();
    const state = decodeRatingSubscriptionState(raw.state);
    matchRatingSubscriptionState(raw.targetId, state);
    return Object.freeze({ targetId: raw.targetId, state });
  });
  if (new Set(items.map((item) => item.targetId)).size !== items.length)
    invalidRating();
  return Object.freeze({ items: Object.freeze(items) });
}
export function matchRatingSubscriptionBatch(
  targets: readonly RatingSubscriptionTarget[],
  result: RatingSubscriptionBatch,
): void {
  if (
    result.items.length !== targets.length ||
    result.items.some(
      (item, index) => item.targetId !== targets[index]?.targetId,
    )
  )
    invalidRating();
}
export interface RatingSubscriptionIntent {
  readonly operation: 'set_target_subscription';
  readonly targetId: string;
  readonly payload: {
    readonly clientRequestId: string;
    readonly regionId: string | null;
    readonly expectedTargetRevision: string;
    readonly expectedSubscriptionRevision: string;
    readonly subscribed: boolean;
  };
}
export function decodeRatingSubscriptionIntent(
  value: unknown,
): RatingSubscriptionIntent {
  exact(value, ['operation', 'targetId', 'payload']);
  exact(value.payload, [
    'clientRequestId',
    'regionId',
    'expectedTargetRevision',
    'expectedSubscriptionRevision',
    'subscribed',
  ]);
  const p = value.payload;
  if (
    value.operation !== 'set_target_subscription' ||
    !ratingId(value.targetId) ||
    !ratingId(p.clientRequestId) ||
    !ratingNullableId(p.regionId) ||
    !ratingId(p.expectedTargetRevision) ||
    !ratingId(p.expectedSubscriptionRevision) ||
    typeof p.subscribed !== 'boolean'
  )
    invalidRating();
  return Object.freeze({
    operation: 'set_target_subscription',
    targetId: value.targetId,
    payload: Object.freeze({
      clientRequestId: p.clientRequestId,
      regionId: p.regionId,
      expectedTargetRevision: p.expectedTargetRevision,
      expectedSubscriptionRevision: p.expectedSubscriptionRevision,
      subscribed: p.subscribed,
    }),
  });
}
export type RatingSubscriptionReceipt =
  | {
      readonly requestId: string;
      readonly operation: 'set_target_subscription';
      readonly outcome: 'applied' | 'noop';
      readonly targetId: string;
      readonly subscribed: boolean;
      readonly revision: string;
      readonly occurredAt: string;
    }
  | {
      readonly requestId: string;
      readonly operation: 'set_target_subscription';
      readonly outcome: 'rejected';
      readonly code: (typeof ratingRejections)[number];
    };
export function decodeRatingSubscriptionReceipt(
  value: unknown,
): RatingSubscriptionReceipt {
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
          'subscribed',
          'revision',
          'occurredAt',
        ],
  );
  if (
    !ratingId(value.requestId) ||
    value.operation !== 'set_target_subscription'
  )
    invalidRating();
  if (value.outcome === 'rejected') {
    if (!(ratingRejections as readonly unknown[]).includes(value.code))
      invalidRating();
    return Object.freeze({
      requestId: value.requestId,
      operation: 'set_target_subscription',
      outcome: 'rejected',
      code: value.code as (typeof ratingRejections)[number],
    });
  }
  if (
    !['applied', 'noop'].includes(String(value.outcome)) ||
    !ratingId(value.targetId) ||
    typeof value.subscribed !== 'boolean' ||
    !ratingId(value.revision) ||
    !ratingTimestamp(value.occurredAt)
  )
    invalidRating();
  return Object.freeze({
    requestId: value.requestId,
    operation: 'set_target_subscription',
    outcome: value.outcome as 'applied' | 'noop',
    targetId: value.targetId,
    subscribed: value.subscribed,
    revision: value.revision,
    occurredAt: value.occurredAt,
  });
}
export function matchRatingSubscriptionReceipt(
  intent: RatingSubscriptionIntent,
  receipt: RatingSubscriptionReceipt,
): void {
  if (
    receipt.requestId !== intent.payload.clientRequestId ||
    receipt.operation !== intent.operation ||
    (receipt.outcome !== 'rejected' &&
      (receipt.targetId !== intent.targetId ||
        receipt.subscribed !== intent.payload.subscribed ||
        (receipt.outcome === 'noop' &&
          receipt.revision !== intent.payload.expectedSubscriptionRevision)))
  )
    invalidRating();
}
