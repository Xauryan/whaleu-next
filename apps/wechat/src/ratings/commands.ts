import { ClientError } from '../api/errors';
import type { CommunityRuntime } from '../community/runtime';
import type { Cancellation } from '../platform/contracts';
import {
  isRatingReplyIntent,
  type PendingRating,
  type RatingCommandReceipt,
} from './pending';
export const ratingCommandLabels = {
  set_score: '评分',
  create_comment: '文字评价发布',
  delete_comment: '文字评价删除',
  create_reply: '回复发布',
  delete_reply: '回复删除',
} as const;
export function runRatingCommand(
  runtime: CommunityRuntime,
  attempt: PendingRating,
  cancel: Cancellation,
  retry: boolean,
): Promise<RatingCommandReceipt> {
  const accountId = runtime.sessions.snapshot().credentials?.accountId;
  if (attempt.accountId !== accountId)
    throw new ClientError('stale-session', 'Account changed');
  runtime.pendingRatings!.assertOriginal(attempt);
  const intent = attempt.intent;
  if (isRatingReplyIntent(intent)) {
    if (!runtime.ratingDiscussion)
      throw new ClientError('configuration', 'Rating discussion unavailable');
    return retry
      ? runtime.ratingDiscussion.command(intent, cancel)
      : runtime.ratingDiscussion.receipt(
          intent.payload.clientRequestId,
          cancel,
        );
  }
  if (!runtime.ratings)
    throw new ClientError('configuration', 'Ratings unavailable');
  return retry
    ? runtime.ratings.command(intent, cancel)
    : runtime.ratings.receipt(intent.payload.clientRequestId, cancel);
}
