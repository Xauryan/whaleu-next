import type { ApiClient } from '../api/client';
import type { Cancellation, Json } from '../platform/contracts';
import { invalidRating, ratingId } from './contract';
import {
  decodeRatingAdminDeletionContext,
  decodeRatingAdminDeletionIntent,
  decodeRatingAdminDeletionReceipt,
  decodeRatingDeletionContext,
  decodeRatingDeletionLocator,
  matchRatingAdminDeletionReceipt,
  matchRatingDeletionContext,
  type RatingAdminDeletionContext,
  type RatingAdminDeletionIntent,
  type RatingAdminDeletionReceipt,
  type RatingDeletionAuthority,
  type RatingDeletionContext,
  type RatingDeletionLocator,
} from './deletion-contract';
export interface RatingDeletionGateway {
  context(
    authority: RatingDeletionAuthority,
    locator: RatingDeletionLocator,
    cancel: Cancellation,
  ): Promise<RatingDeletionContext | RatingAdminDeletionContext>;
  command(
    intent: RatingAdminDeletionIntent,
    cancel: Cancellation,
  ): Promise<RatingAdminDeletionReceipt>;
  receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<RatingAdminDeletionReceipt>;
}
export class HttpRatingDeletionGateway implements RatingDeletionGateway {
  constructor(private readonly api: ApiClient) {}
  async context(
    authority: RatingDeletionAuthority,
    raw: RatingDeletionLocator,
    cancel: Cancellation,
  ): Promise<RatingDeletionContext | RatingAdminDeletionContext> {
    if (authority !== 'owner' && authority !== 'admin') invalidRating();
    const locator = decodeRatingDeletionLocator(raw);
    const result = await this.api.request(
      {
        path: `/v1/ratings/${authority === 'admin' ? 'admin/' : ''}${locator.subjectKind === 'comment' ? 'comments' : 'replies'}/${locator.subjectId}/deletion-context`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode:
          authority === 'admin'
            ? decodeRatingAdminDeletionContext
            : decodeRatingDeletionContext,
      },
      { cancellation: cancel },
    );
    matchRatingDeletionContext(locator, result);
    return result;
  }
  async command(
    raw: RatingAdminDeletionIntent,
    cancel: Cancellation,
  ): Promise<RatingAdminDeletionReceipt> {
    const intent = decodeRatingAdminDeletionIntent(raw);
    const receipt = await this.api.request(
      {
        path: `/v1/ratings/admin/${intent.operation === 'admin_delete_comment' ? 'comments' : 'replies'}/${intent.subjectId}`,
        method: 'DELETE',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingAdminDeletionReceipt,
      },
      {
        cancellation: cancel,
        body: JSON.parse(JSON.stringify(intent.payload)) as Json,
      },
    );
    matchRatingAdminDeletionReceipt(intent, receipt);
    return receipt;
  }
  async receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<RatingAdminDeletionReceipt> {
    if (!ratingId(requestId)) invalidRating();
    const receipt = await this.api.request(
      {
        path: `/v1/ratings/admin/requests/${requestId}`,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingAdminDeletionReceipt,
      },
      { cancellation: cancel },
    );
    if (receipt.requestId !== requestId) invalidRating();
    return receipt;
  }
}
