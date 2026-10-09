import type { ApiClient } from '../api/client';
import type { Cancellation, Json } from '../platform/contracts';
import { invalidRating, ratingId } from './contract';
import { ratingScopeQuery } from './discussion-gateway';
import {
  decodeRatingLikeIntent,
  decodeRatingLikeReceipt,
  decodeRatingLikeState,
  matchRatingLikeReceipt,
  matchRatingLikeState,
  type RatingLikeIntent,
  type RatingLikeReceipt,
  type RatingLikeState,
  type RatingLikeSubject,
} from './like-contract';
export interface RatingLikesGateway {
  state(
    regionId: string | null,
    subject: RatingLikeSubject,
    cancel: Cancellation,
  ): Promise<RatingLikeState>;
  command(
    intent: RatingLikeIntent,
    cancel: Cancellation,
  ): Promise<RatingLikeReceipt>;
  receipt(requestId: string, cancel: Cancellation): Promise<RatingLikeReceipt>;
}
export class HttpRatingLikesGateway implements RatingLikesGateway {
  constructor(private readonly api: ApiClient) {}
  async state(
    regionId: string | null,
    subject: RatingLikeSubject,
    cancel: Cancellation,
  ): Promise<RatingLikeState> {
    if (
      !ratingId(subject.targetId) ||
      !ratingId(subject.rootId) ||
      (subject.replyId !== null && !ratingId(subject.replyId))
    )
      invalidRating();
    const state = await this.api.request(
      {
        path:
          subject.replyId === null
            ? `/v1/ratings/comments/${subject.rootId}/like`
            : `/v1/ratings/replies/${subject.replyId}/like`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingLikeState,
      },
      { cancellation: cancel, query: ratingScopeQuery(regionId) },
    );
    matchRatingLikeState(subject, state);
    return state;
  }
  async command(
    raw: RatingLikeIntent,
    cancel: Cancellation,
  ): Promise<RatingLikeReceipt> {
    const intent = decodeRatingLikeIntent(raw);
    const receipt = await this.api.request(
      {
        path:
          intent.operation === 'set_comment_like'
            ? `/v1/ratings/comments/${intent.rootId}/like`
            : `/v1/ratings/replies/${intent.replyId}/like`,
        method: 'PUT',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingLikeReceipt,
      },
      {
        cancellation: cancel,
        body: JSON.parse(JSON.stringify(intent.payload)) as Json,
      },
    );
    matchRatingLikeReceipt(intent, receipt);
    return receipt;
  }
  async receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<RatingLikeReceipt> {
    if (!ratingId(requestId)) invalidRating();
    const receipt = await this.api.request(
      {
        path: `/v1/ratings/like-requests/${requestId}`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingLikeReceipt,
      },
      { cancellation: cancel },
    );
    if (receipt.requestId !== requestId) invalidRating();
    return receipt;
  }
}
