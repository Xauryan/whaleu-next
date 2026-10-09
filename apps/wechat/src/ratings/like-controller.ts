import { ClientError } from '../api/errors';
import type { Cancellation } from '../platform/contracts';
import { invalidRating } from './contract';
import {
  decodeRatingLikeState,
  matchRatingLikeState,
  type RatingLikeState,
  type RatingLikeSubject,
} from './like-contract';
import type { RatingLikesGateway } from './like-gateway';
export type RatingLikeStates = Readonly<Record<string, RatingLikeState>>;
/** Independent current reads, bounded to one visible page plus its root. Receipts never populate this map. */
export async function readRatingLikeStates(
  gateway: RatingLikesGateway | undefined,
  regionId: string | null,
  subjects: readonly RatingLikeSubject[],
  cancel: Cancellation,
): Promise<RatingLikeStates> {
  if (
    subjects.length > 51 ||
    new Set(subjects.map((s) => s.replyId ?? s.rootId)).size !== subjects.length
  )
    invalidRating();
  const result: Record<string, RatingLikeState> = {};
  // The existing Safety final-proof protocol has a global exclusive reader gate.
  // Serialize this supplemental batch so its own reads do not race into 503s.
  // This is below the four-request ceiling; no retries, cached receipts or extra rows.
  for (const subject of subjects) {
    if (cancel.isCancelled)
      throw new ClientError('cancelled', 'Like read cancelled');
    let state: RatingLikeState = { status: 'unavailable' };
    if (gateway) {
      try {
        const raw = await gateway.state(regionId, subject, cancel);
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Like read cancelled');
        state = decodeRatingLikeState(raw);
        matchRatingLikeState(subject, state);
      } catch (error) {
        // Interaction authority is independent from the content read purpose: a direct-like denial
        // must not hide a separately authorized list row. Never synthesize false/zero.
        // Protocol, authentication, forbidden and cancellation errors still fail closed.
        if (
          !(error instanceof ClientError) ||
          !['http', 'business', 'network', 'timeout', 'configuration'].includes(
            error.kind,
          )
        )
          throw error;
      }
    }
    if (cancel.isCancelled)
      throw new ClientError('cancelled', 'Like read cancelled');
    result[subject.replyId ?? subject.rootId] = state;
  }
  return Object.freeze(result);
}
