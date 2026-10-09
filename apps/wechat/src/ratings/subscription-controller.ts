import { ClientError } from '../api/errors';
import type { Cancellation } from '../platform/contracts';
import { invalidRating, ratingId } from './contract';
import {
  decodeRatingSubscriptionBatch,
  decodeRatingSubscriptionQuery,
  decodeRatingSubscriptionState,
  matchRatingSubscriptionBatch,
  matchRatingSubscriptionState,
  type RatingSubscriptionState,
  type RatingSubscriptionTarget,
} from './subscription-contract';
import type { RatingSubscriptionsGateway } from './subscription-gateway';
export type RatingSubscriptionStates = Readonly<
  Record<string, RatingSubscriptionState>
>;
const unknown = (): RatingSubscriptionState =>
  Object.freeze({ status: 'unavailable' });
function current(cancel: Cancellation): void {
  if (cancel.isCancelled)
    throw new ClientError('cancelled', 'Subscription read cancelled');
}
function independent(error: unknown): void {
  // A denied interaction or unavailable dependency does not invalidate an independently authorized content read.
  // Authentication, forbidden-account, malformed protocol and cancellation still fail closed.
  if (
    error instanceof ClientError &&
    error.kind === 'forbidden' &&
    [
      'PHONE_VERIFICATION_REQUIRED',
      'AFFILIATION_VERIFICATION_REQUIRED',
      'IDENTITY_CAMPUS_REQUIRED',
      'SAFETY_ACTION_RESTRICTED',
    ].includes(error.details.serverCode ?? '')
  )
    return;
  if (
    !(error instanceof ClientError) ||
    ![
      'http',
      'business',
      'network',
      'timeout',
      'configuration',
      'phone-verification-required',
    ].includes(error.kind)
  )
    throw error;
}
export async function readRatingSubscriptionState(
  gateway: RatingSubscriptionsGateway | undefined,
  regionId: string | null,
  targetId: string,
  cancel: Cancellation,
): Promise<RatingSubscriptionState> {
  if (!ratingId(targetId)) invalidRating();
  current(cancel);
  let state = unknown();
  if (gateway) {
    try {
      const raw = await gateway.state(regionId, targetId, cancel);
      current(cancel);
      state = decodeRatingSubscriptionState(raw);
      matchRatingSubscriptionState(targetId, state);
    } catch (error) {
      independent(error);
    }
  }
  current(cancel);
  return state;
}
/** Only the current visible page: at most 50 cards, at most three sequential read-only batches. */
export async function readRatingSubscriptionStates(
  gateway: RatingSubscriptionsGateway | undefined,
  regionId: string | null,
  targets: readonly RatingSubscriptionTarget[],
  cancel: Cancellation,
): Promise<RatingSubscriptionStates> {
  if (
    targets.length > 50 ||
    new Set(targets.map((item) => item.targetId)).size !== targets.length
  )
    invalidRating();
  const result: Record<string, RatingSubscriptionState> = {};
  for (let index = 0; index < targets.length; index += 20) {
    current(cancel);
    const query = decodeRatingSubscriptionQuery({
      regionId,
      targets: targets.slice(index, index + 20),
    });
    for (const item of query.targets) result[item.targetId] = unknown();
    if (gateway) {
      try {
        const raw = await gateway.states(regionId, query.targets, cancel);
        current(cancel);
        const batch = decodeRatingSubscriptionBatch(raw);
        matchRatingSubscriptionBatch(query.targets, batch);
        for (const item of batch.items) result[item.targetId] = item.state;
      } catch (error) {
        independent(error);
      }
    }
    current(cancel);
  }
  current(cancel);
  return Object.freeze(result);
}
