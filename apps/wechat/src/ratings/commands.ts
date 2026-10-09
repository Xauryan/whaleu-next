import { ClientError } from '../api/errors';
import type { CommunityRuntime } from '../community/runtime';
import type { Cancellation } from '../platform/contracts';
import {
  isRatingReplyIntent,
  isRatingSubscriptionIntent,
  isRatingLikeIntent,
  type PendingRating,
  type RatingCommandReceipt,
} from './pending';
export const ratingCommandLabels = {
  set_target_subscription: '目标订阅状态',
  set_score: '评分',
  create_comment: '文字评价发布',
  delete_comment: '文字评价删除',
  create_reply: '回复发布',
  delete_reply: '回复删除',
  set_comment_like: '评价点赞状态',
  set_reply_like: '回复点赞状态',
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
  if (isRatingSubscriptionIntent(intent)) {
    if (!runtime.ratingSubscriptions)
      throw new ClientError(
        'configuration',
        'Rating subscriptions unavailable',
      );
    return retry
      ? runtime.ratingSubscriptions.command(intent, cancel)
      : runtime.ratingSubscriptions.receipt(
          intent.payload.clientRequestId,
          cancel,
        );
  }
  if (isRatingLikeIntent(intent)) {
    if (!runtime.ratingLikes)
      throw new ClientError('configuration', 'Rating likes unavailable');
    return retry
      ? runtime.ratingLikes.command(intent, cancel)
      : runtime.ratingLikes.receipt(intent.payload.clientRequestId, cancel);
  }
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
