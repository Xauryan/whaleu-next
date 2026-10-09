import { ClientError } from '../api/errors';
import type { ApiClient } from '../api/client';
import type { SessionStore } from '../auth/session';
import type { Cancellation, Json } from '../platform/contracts';
import { invalidRating, ratingId } from './contract';
import { ratingNullableId } from './discussion-contract';
import {
  decodeRatingCategoryCreationIntent,
  decodeRatingCategoryCreationReceipt,
  decodeRatingCategoryManagementContext,
  decodeRatingCategoryPrepared,
  matchRatingCategoryCreationReceipt,
  matchRatingCategoryPreparation,
  type RatingCategoryCreationIntent,
  type RatingCategoryCreationReceipt,
  type RatingCategoryManagementContext,
  type RatingCategoryPrepared,
} from './category-management-contract';
export interface RatingCategoryManagementGateway {
  context(
    regionId: string | null,
    cancel: Cancellation,
  ): Promise<RatingCategoryManagementContext>;
  prepare(
    intent: RatingCategoryCreationIntent,
    cancel: Cancellation,
  ): Promise<RatingCategoryPrepared>;
  command(
    intent: RatingCategoryCreationIntent,
    cancel: Cancellation,
  ): Promise<RatingCategoryCreationReceipt>;
  cancel(
    intent: RatingCategoryCreationIntent,
    cancel: Cancellation,
  ): Promise<RatingCategoryCreationReceipt>;
  receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<RatingCategoryCreationReceipt>;
}
const prefix = '/v1/ratings/category-management';
const body = (value: unknown): Json =>
  JSON.parse(JSON.stringify(value)) as Json;
/** Unknown Review/auth/topology is never a manufactured rejection or a successful publication. */
export class HttpRatingCategoryManagementGateway implements RatingCategoryManagementGateway {
  constructor(
    private readonly api: ApiClient,
    private readonly sessions: SessionStore,
  ) {}
  async context(
    regionId: string | null,
    cancel: Cancellation,
  ): Promise<RatingCategoryManagementContext> {
    if (!ratingNullableId(regionId)) invalidRating();
    const result = await this.api.request(
      {
        path: `${prefix}/context`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingCategoryManagementContext,
      },
      {
        cancellation: cancel,
        ...(regionId === null ? {} : { query: { regionId } }),
      },
    );
    if (result.regionId !== regionId) invalidRating();
    return result;
  }
  async prepare(
    raw: RatingCategoryCreationIntent,
    cancel: Cancellation,
  ): Promise<RatingCategoryPrepared> {
    const intent = decodeRatingCategoryCreationIntent(raw);
    const result = await this.api.request(
      {
        path: `${prefix}/prepare`,
        method: 'POST',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingCategoryPrepared,
      },
      { cancellation: cancel, body: body(intent.payload) },
    );
    if ('outcome' in result) matchRatingCategoryCreationReceipt(intent, result);
    else matchRatingCategoryPreparation(intent, result);
    return result;
  }
  async command(
    raw: RatingCategoryCreationIntent,
    cancel: Cancellation,
  ): Promise<RatingCategoryCreationReceipt> {
    const intent = decodeRatingCategoryCreationIntent(raw),
      owner = this.sessions.snapshot();
    const prepared = await this.prepare(intent, cancel);
    this.sessions.assertCurrent(owner);
    if (cancel.isCancelled)
      throw new ClientError('cancelled', 'Cancelled before category commit');
    if ('outcome' in prepared) return prepared;
    const result = await this.api.request(
      {
        path: `${prefix}/categories`,
        method: 'POST',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingCategoryCreationReceipt,
      },
      {
        cancellation: cancel,
        body: body({
          ...intent.payload,
          expectedContextRevision: prepared.contextRevision,
        }),
      },
    );
    this.sessions.assertCurrent(owner);
    matchRatingCategoryCreationReceipt(intent, result);
    if (
      result.outcome === 'applied' &&
      JSON.stringify(result.categories) !== JSON.stringify(prepared.categories)
    )
      invalidRating();
    return result;
  }
  async cancel(
    raw: RatingCategoryCreationIntent,
    cancel: Cancellation,
  ): Promise<RatingCategoryCreationReceipt> {
    const intent = decodeRatingCategoryCreationIntent(raw),
      owner = this.sessions.snapshot();
    const result = await this.api.request(
      {
        path: `${prefix}/cancel`,
        method: 'POST',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingCategoryCreationReceipt,
      },
      { cancellation: cancel, body: body(intent.payload) },
    );
    this.sessions.assertCurrent(owner);
    matchRatingCategoryCreationReceipt(intent, result);
    return result;
  }
  async receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<RatingCategoryCreationReceipt> {
    if (!ratingId(requestId)) invalidRating();
    const result = await this.api.request(
      {
        path: `${prefix}/requests/${requestId}`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingCategoryCreationReceipt,
      },
      { cancellation: cancel },
    );
    if (result.requestId !== requestId) invalidRating();
    return result;
  }
}
