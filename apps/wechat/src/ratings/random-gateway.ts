import type { ApiClient } from '../api/client';
import type { Cancellation } from '../platform/contracts';
import {
  decodeRatingRandomQuery,
  decodeRatingRandomResult,
  matchRatingRandomResult,
  type RatingRandomQuery,
  type RatingRandomResult,
} from './random-contract';

export interface RatingRandomGateway {
  draw(
    query: RatingRandomQuery,
    cancel: Cancellation,
  ): Promise<RatingRandomResult>;
}
export class HttpRatingRandomGateway implements RatingRandomGateway {
  constructor(private readonly api: ApiClient) {}
  async draw(
    raw: RatingRandomQuery,
    cancellation: Cancellation,
  ): Promise<RatingRandomResult> {
    const query = decodeRatingRandomQuery(raw);
    return this.api.request(
      {
        path: '/v1/ratings/random-target',
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode(value) {
          const result = decodeRatingRandomResult(value);
          matchRatingRandomResult(query, result);
          return result;
        },
      },
      { cancellation, query: { ...query } },
    );
  }
}
