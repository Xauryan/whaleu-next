import type { ApiClient } from '../api/client';
import type { Cancellation, Json } from '../platform/contracts';
import { invalidRating, ratingId } from './contract';
import { ratingScopeQuery } from './discussion-gateway';
import {
  decodeRatingSubscriptionBatch,
  decodeRatingSubscriptionIntent,
  decodeRatingSubscriptionQuery,
  decodeRatingSubscriptionReceipt,
  decodeRatingSubscriptionState,
  matchRatingSubscriptionBatch,
  matchRatingSubscriptionReceipt,
  matchRatingSubscriptionState,
  type RatingSubscriptionBatch,
  type RatingSubscriptionIntent,
  type RatingSubscriptionReceipt,
  type RatingSubscriptionState,
  type RatingSubscriptionTarget,
} from './subscription-contract';
export interface RatingSubscriptionsGateway {
  state(
    regionId: string | null,
    targetId: string,
    cancel: Cancellation,
  ): Promise<RatingSubscriptionState>;
  states(
    regionId: string | null,
    targets: readonly RatingSubscriptionTarget[],
    cancel: Cancellation,
  ): Promise<RatingSubscriptionBatch>;
  command(
    intent: RatingSubscriptionIntent,
    cancel: Cancellation,
  ): Promise<RatingSubscriptionReceipt>;
  receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<RatingSubscriptionReceipt>;
}
export class HttpRatingSubscriptionsGateway implements RatingSubscriptionsGateway {
  constructor(private readonly api: ApiClient) {}
  async state(
    regionId: string | null,
    targetId: string,
    cancel: Cancellation,
  ): Promise<RatingSubscriptionState> {
    if (!ratingId(targetId)) invalidRating();
    const state = await this.api.request(
      {
        path: `/v1/ratings/targets/${targetId}/subscription`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingSubscriptionState,
      },
      { cancellation: cancel, query: ratingScopeQuery(regionId) },
    );
    matchRatingSubscriptionState(targetId, state);
    return state;
  }
  async states(
    regionId: string | null,
    targets: readonly RatingSubscriptionTarget[],
    cancel: Cancellation,
  ): Promise<RatingSubscriptionBatch> {
    const query = decodeRatingSubscriptionQuery({ regionId, targets });
    const result = await this.api.request(
      {
        path: '/v1/ratings/subscription-states/query',
        method: 'POST',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingSubscriptionBatch,
      },
      { cancellation: cancel, body: JSON.parse(JSON.stringify(query)) as Json },
    );
    matchRatingSubscriptionBatch(query.targets, result);
    return result;
  }
  async command(
    raw: RatingSubscriptionIntent,
    cancel: Cancellation,
  ): Promise<RatingSubscriptionReceipt> {
    const intent = decodeRatingSubscriptionIntent(raw);
    const receipt = await this.api.request(
      {
        path: `/v1/ratings/targets/${intent.targetId}/subscription`,
        method: 'PUT',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingSubscriptionReceipt,
      },
      {
        cancellation: cancel,
        body: JSON.parse(JSON.stringify(intent.payload)) as Json,
      },
    );
    matchRatingSubscriptionReceipt(intent, receipt);
    return receipt;
  }
  async receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<RatingSubscriptionReceipt> {
    if (!ratingId(requestId)) invalidRating();
    const receipt = await this.api.request(
      {
        path: `/v1/ratings/subscription-requests/${requestId}`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingSubscriptionReceipt,
      },
      { cancellation: cancel },
    );
    if (receipt.requestId !== requestId) invalidRating();
    return receipt;
  }
}
