import { ClientError } from '../api/errors';
import type { ApiClient } from '../api/client';
import type { SessionStore } from '../auth/session';
import type { Cancellation, Json } from '../platform/contracts';
import { invalidRating, ratingId } from './contract';
import {
  decodeRatingTargetOwnerEditingContext,
  decodeRatingTargetOwnerEditingIntent,
  decodeRatingTargetOwnerEditingPrepared,
  decodeRatingTargetOwnerEditingReceipt,
  matchRatingTargetOwnerEditingPreparation,
  matchRatingTargetOwnerEditingReceipt,
  type RatingTargetOwnerEditingContext,
  type RatingTargetOwnerEditingIntent,
  type RatingTargetOwnerEditingPrepared,
  type RatingTargetOwnerEditingReceipt,
} from './target-owner-editing-contract';
export interface RatingTargetOwnerEditingGateway {
  context(
    targetId: string,
    cancel: Cancellation,
  ): Promise<RatingTargetOwnerEditingContext>;
  prepare(
    intent: RatingTargetOwnerEditingIntent,
    cancel: Cancellation,
  ): Promise<RatingTargetOwnerEditingPrepared>;
  command(
    intent: RatingTargetOwnerEditingIntent,
    cancel: Cancellation,
  ): Promise<RatingTargetOwnerEditingReceipt>;
  cancel(
    intent: RatingTargetOwnerEditingIntent,
    cancel: Cancellation,
  ): Promise<RatingTargetOwnerEditingReceipt>;
  receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<RatingTargetOwnerEditingReceipt>;
}
const prefix = '/v1/ratings/management/owner-edit';
const body = (value: unknown): Json =>
  JSON.parse(JSON.stringify(value)) as Json;
/** Preparation tokens are transient, session-bound, and never enter the immutable journal. */
export class HttpRatingTargetOwnerEditingGateway implements RatingTargetOwnerEditingGateway {
  constructor(
    private readonly api: ApiClient,
    private readonly sessions: SessionStore,
  ) {}
  async context(
    targetId: string,
    cancel: Cancellation,
  ): Promise<RatingTargetOwnerEditingContext> {
    if (!ratingId(targetId)) invalidRating();
    const result = await this.api.request(
      {
        path: `${prefix}/targets/${targetId}/context`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingTargetOwnerEditingContext,
      },
      { cancellation: cancel },
    );
    if (result.targetId !== targetId) invalidRating();
    return result;
  }
  async prepare(
    raw: RatingTargetOwnerEditingIntent,
    cancel: Cancellation,
  ): Promise<RatingTargetOwnerEditingPrepared> {
    const intent = decodeRatingTargetOwnerEditingIntent(raw);
    const result = await this.api.request(
      {
        path: `${prefix}/prepare`,
        method: 'POST',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingTargetOwnerEditingPrepared,
      },
      { cancellation: cancel, body: body(intent.payload) },
    );
    if ('outcome' in result)
      matchRatingTargetOwnerEditingReceipt(intent, result);
    else matchRatingTargetOwnerEditingPreparation(intent, result);
    return result;
  }
  async command(
    raw: RatingTargetOwnerEditingIntent,
    cancel: Cancellation,
  ): Promise<RatingTargetOwnerEditingReceipt> {
    const intent = decodeRatingTargetOwnerEditingIntent(raw),
      owner = this.sessions.snapshot();
    // Every retry sends prepare for the original key. Its stable server token is not cached
    // across attempts; only the server may decide whether its original session can still commit.
    const prepared = await this.prepare(intent, cancel);
    this.sessions.assertCurrent(owner);
    if (cancel.isCancelled)
      throw new ClientError('cancelled', 'Cancelled before commit');
    if ('outcome' in prepared) return prepared;
    const result = await this.api.request(
      {
        path: `${prefix}/commit`,
        method: 'POST',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingTargetOwnerEditingReceipt,
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
    matchRatingTargetOwnerEditingReceipt(intent, result);
    if (
      result.outcome === 'applied' &&
      (result.revision !== prepared.revision ||
        result.definitionRevision !== prepared.definitionRevision ||
        result.contentVersion !== prepared.contentVersion)
    )
      invalidRating();
    return result;
  }
  async cancel(
    raw: RatingTargetOwnerEditingIntent,
    cancel: Cancellation,
  ): Promise<RatingTargetOwnerEditingReceipt> {
    const intent = decodeRatingTargetOwnerEditingIntent(raw);
    const result = await this.api.request(
      {
        path: `${prefix}/cancel`,
        method: 'POST',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingTargetOwnerEditingReceipt,
      },
      { cancellation: cancel, body: body(intent.payload) },
    );
    matchRatingTargetOwnerEditingReceipt(intent, result);
    return result;
  }
  async receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<RatingTargetOwnerEditingReceipt> {
    if (!ratingId(requestId)) invalidRating();
    const result = await this.api.request(
      {
        path: `${prefix}/requests/${requestId}`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingTargetOwnerEditingReceipt,
      },
      { cancellation: cancel },
    );
    if (result.requestId !== requestId) invalidRating();
    return result;
  }
}
