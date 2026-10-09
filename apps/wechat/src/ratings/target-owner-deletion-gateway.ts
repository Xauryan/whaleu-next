import type { ApiClient } from '../api/client';
import type { Cancellation, Json } from '../platform/contracts';
import { invalidRating, ratingId } from './contract';
import {
  decodeRatingTargetOwnerDeletionContext,
  decodeRatingTargetOwnerDeletionIntent,
  decodeRatingTargetOwnerDeletionReceipt,
  matchRatingTargetOwnerDeletionReceipt,
  type RatingTargetOwnerDeletionContext,
  type RatingTargetOwnerDeletionIntent,
  type RatingTargetOwnerDeletionReceipt,
} from './target-owner-deletion-contract';

export interface RatingTargetOwnerDeletionGateway {
  context(
    targetId: string,
    cancel: Cancellation,
  ): Promise<RatingTargetOwnerDeletionContext>;
  command(
    intent: RatingTargetOwnerDeletionIntent,
    cancel: Cancellation,
  ): Promise<RatingTargetOwnerDeletionReceipt>;
  cancel(
    intent: RatingTargetOwnerDeletionIntent,
    cancel: Cancellation,
  ): Promise<RatingTargetOwnerDeletionReceipt>;
  receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<RatingTargetOwnerDeletionReceipt>;
}
const prefix = '/v1/ratings/management/owner-deletion';
/** Metadata-only cleanup. No public detail, region, Review or identity lookup. */
export class HttpRatingTargetOwnerDeletionGateway implements RatingTargetOwnerDeletionGateway {
  constructor(private readonly api: ApiClient) {}
  async context(
    targetId: string,
    cancel: Cancellation,
  ): Promise<RatingTargetOwnerDeletionContext> {
    if (!ratingId(targetId)) invalidRating();
    const result = await this.api.request(
      {
        path: `${prefix}/targets/${targetId}/context`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingTargetOwnerDeletionContext,
      },
      { cancellation: cancel },
    );
    if (result.targetId !== targetId) invalidRating();
    return result;
  }
  async command(
    raw: RatingTargetOwnerDeletionIntent,
    cancel: Cancellation,
  ): Promise<RatingTargetOwnerDeletionReceipt> {
    const intent = decodeRatingTargetOwnerDeletionIntent(raw);
    const { clientRequestId, targetId, expectedTargetRevision } =
      intent.payload;
    return this.send(
      intent,
      `${prefix}/targets/${targetId}`,
      { clientRequestId, expectedTargetRevision },
      cancel,
    );
  }
  async cancel(
    raw: RatingTargetOwnerDeletionIntent,
    cancel: Cancellation,
  ): Promise<RatingTargetOwnerDeletionReceipt> {
    const intent = decodeRatingTargetOwnerDeletionIntent(raw);
    return this.send(intent, `${prefix}/cancel`, { ...intent.payload }, cancel);
  }
  private async send(
    intent: RatingTargetOwnerDeletionIntent,
    path: string,
    body: Json,
    cancel: Cancellation,
  ): Promise<RatingTargetOwnerDeletionReceipt> {
    // HTTP errors (including not-found/conflict/unavailable) never manufacture a terminal receipt.
    const result = await this.api.request(
      {
        path,
        method: 'POST',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingTargetOwnerDeletionReceipt,
      },
      { cancellation: cancel, body },
    );
    matchRatingTargetOwnerDeletionReceipt(intent, result);
    return result;
  }
  async receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<RatingTargetOwnerDeletionReceipt> {
    if (!ratingId(requestId)) invalidRating();
    const result = await this.api.request(
      {
        path: `${prefix}/requests/${requestId}`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingTargetOwnerDeletionReceipt,
      },
      { cancellation: cancel },
    );
    if (result.requestId !== requestId) invalidRating();
    return result;
  }
}
