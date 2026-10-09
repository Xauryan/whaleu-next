import { ClientError } from '../api/errors';
import type { ApiClient } from '../api/client';
import type { Cancellation, Json } from '../platform/contracts';
import { invalidRating, ratingId } from './contract';
import {
  decodeRatingTargetCreationIntent,
  decodeRatingTargetCreationReceipt,
  decodeRatingTargetPreparation,
  matchRatingTargetCreationReceipt,
  type RatingTargetCreationIntent,
  type RatingTargetCreationReceipt,
  type RatingTargetPreparation,
} from './management-contract';
export interface RatingManagementGateway {
  prepare(
    intent: RatingTargetCreationIntent,
    cancel: Cancellation,
  ): Promise<RatingTargetPreparation>;
  command(
    intent: RatingTargetCreationIntent,
    cancel: Cancellation,
  ): Promise<RatingTargetCreationReceipt>;
  cancel(
    intent: RatingTargetCreationIntent,
    cancel: Cancellation,
  ): Promise<RatingTargetCreationReceipt>;
  receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<RatingTargetCreationReceipt>;
}
export class HttpRatingManagementGateway implements RatingManagementGateway {
  constructor(private readonly api: ApiClient) {}
  async prepare(
    raw: RatingTargetCreationIntent,
    cancel: Cancellation,
  ): Promise<RatingTargetPreparation> {
    const intent = decodeRatingTargetCreationIntent(raw);
    const result = await this.api.request(
      {
        path: '/v1/ratings/management/prepare',
        method: 'POST',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingTargetPreparation,
      },
      {
        cancellation: cancel,
        body: JSON.parse(JSON.stringify(intent.payload)) as Json,
      },
    );
    if (result.requestId !== intent.payload.clientRequestId) invalidRating();
    return result;
  }
  async command(
    raw: RatingTargetCreationIntent,
    cancel: Cancellation,
  ): Promise<RatingTargetCreationReceipt> {
    const intent = decodeRatingTargetCreationIntent(raw);
    // Replaying prepare is safe for this exact immutable key/input, including lost preparation responses.
    try {
      const context = await this.prepare(intent, cancel);
      const receipt = await this.api.request(
        {
          path: '/v1/ratings/management/targets',
          method: 'POST',
          authentication: 'required',
          authReplay: 'once',
          successStatus: 200,
          decode: decodeRatingTargetCreationReceipt,
        },
        {
          cancellation: cancel,
          body: JSON.parse(
            JSON.stringify({
              ...intent.payload,
              expectedContextRevision: context.contextRevision,
            }),
          ) as Json,
        },
      );
      matchRatingTargetCreationReceipt(intent, receipt);
      if (
        receipt.outcome === 'applied' &&
        (receipt.targetId !== context.targetId ||
          receipt.revision !== context.revision)
      )
        invalidRating();
      return receipt;
    } catch (error) {
      // A closed preparation is not a receipt: only a validated owner lookup settles the journal.
      if (
        !cancel.isCancelled &&
        error instanceof ClientError &&
        (error.kind === 'http' || error.kind === 'business') &&
        error.details.httpStatus === 409 &&
        error.details.serverCode === 'RATING_CREATION_CONTEXT_CHANGED'
      ) {
        const receipt = await this.receipt(
          intent.payload.clientRequestId,
          cancel,
        );
        matchRatingTargetCreationReceipt(intent, receipt);
        return receipt;
      }
      throw error;
    }
  }
  async cancel(
    raw: RatingTargetCreationIntent,
    cancel: Cancellation,
  ): Promise<RatingTargetCreationReceipt> {
    const intent = decodeRatingTargetCreationIntent(raw);
    const receipt = await this.api.request(
      {
        path: '/v1/ratings/management/cancel',
        method: 'POST',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingTargetCreationReceipt,
      },
      {
        cancellation: cancel,
        body: JSON.parse(JSON.stringify(intent.payload)) as Json,
      },
    );
    matchRatingTargetCreationReceipt(intent, receipt);
    return receipt;
  }
  async receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<RatingTargetCreationReceipt> {
    if (!ratingId(requestId)) invalidRating();
    const receipt = await this.api.request(
      {
        path: `/v1/ratings/management/requests/${requestId}`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingTargetCreationReceipt,
      },
      { cancellation: cancel },
    );
    if (receipt.requestId !== requestId) invalidRating();
    return receipt;
  }
}
