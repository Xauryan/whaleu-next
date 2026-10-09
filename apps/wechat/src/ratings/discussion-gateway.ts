import type { ApiClient } from '../api/client';
import type { Decoder } from '../api/envelopes';
import type { Cancellation, Json } from '../platform/contracts';
import { invalidRating, ratingCursor, ratingId } from './contract';
import {
  decodeRatingDiscussion,
  decodeRatingReply,
  decodeRatingReplyIntent,
  decodeRatingReplyPage,
  decodeRatingReplyPosition,
  decodeRatingReplyReceipt,
  matchRatingReplyReceipt,
  type RatingDiscussionContext,
  type RatingReply,
  type RatingReplyIntent,
  type RatingReplyPage,
  type RatingReplyPosition,
  type RatingReplyReceipt,
} from './discussion-contract';
export interface RatingDiscussionGateway {
  discussion(
    regionId: string | null,
    rootId: string,
    cancel: Cancellation,
  ): Promise<RatingDiscussionContext>;
  replies(
    regionId: string | null,
    rootId: string,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<RatingReplyPage>;
  reply(
    regionId: string | null,
    replyId: string,
    cancel: Cancellation,
  ): Promise<RatingReply>;
  position(
    regionId: string | null,
    replyId: string,
    cancel: Cancellation,
    limit?: number,
  ): Promise<RatingReplyPosition>;
  command(
    intent: RatingReplyIntent,
    cancel: Cancellation,
  ): Promise<RatingReplyReceipt>;
  receipt(requestId: string, cancel: Cancellation): Promise<RatingReplyReceipt>;
}
export function ratingScopeQuery(
  regionId: string | null,
): Record<string, string | number> {
  if (regionId !== null && !ratingId(regionId)) invalidRating();
  return regionId === null ? {} : { regionId };
}
export function ratingPageQuery(
  cursor: string | null,
  limit: number,
  maximum = 50,
): Record<string, string | number> {
  if (
    (cursor !== null && !ratingCursor(cursor)) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > maximum
  )
    invalidRating();
  return { limit, ...(cursor === null ? {} : { cursor }) };
}
export class HttpRatingDiscussionGateway implements RatingDiscussionGateway {
  constructor(private readonly api: ApiClient) {}
  private read<T>(
    path: string,
    decode: Decoder<T>,
    cancel: Cancellation,
    query?: Record<string, string | number>,
  ): Promise<T> {
    return this.api.request(
      {
        path,
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode,
      },
      { cancellation: cancel, ...(query ? { query } : {}) },
    );
  }
  async discussion(
    regionId: string | null,
    rootId: string,
    cancel: Cancellation,
  ): Promise<RatingDiscussionContext> {
    if (!ratingId(rootId)) invalidRating();
    const result = await this.read(
      `/v1/ratings/comments/${rootId}/discussion`,
      decodeRatingDiscussion,
      cancel,
      ratingScopeQuery(regionId),
    );
    if (
      result.context.regionId !== regionId ||
      result.context.rootId !== rootId
    )
      invalidRating();
    return result;
  }
  async replies(
    regionId: string | null,
    rootId: string,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<RatingReplyPage> {
    if (!ratingId(rootId)) invalidRating();
    const page = await this.read(
      `/v1/ratings/comments/${rootId}/replies`,
      decodeRatingReplyPage,
      cancel,
      { ...ratingScopeQuery(regionId), ...ratingPageQuery(cursor, limit) },
    );
    if (
      page.context.regionId !== regionId ||
      page.context.rootId !== rootId ||
      page.items.length > limit ||
      (page.nextCursor !== null && page.nextCursor === cursor)
    )
      invalidRating();
    return page;
  }
  async reply(
    regionId: string | null,
    replyId: string,
    cancel: Cancellation,
  ): Promise<RatingReply> {
    if (!ratingId(replyId)) invalidRating();
    const result = await this.read(
      `/v1/ratings/replies/${replyId}`,
      decodeRatingReply,
      cancel,
      ratingScopeQuery(regionId),
    );
    if (result.id !== replyId) invalidRating();
    return result;
  }
  async position(
    regionId: string | null,
    replyId: string,
    cancel: Cancellation,
    limit = 20,
  ): Promise<RatingReplyPosition> {
    if (!ratingId(replyId)) invalidRating();
    const result = await this.read(
      `/v1/ratings/replies/${replyId}/position`,
      decodeRatingReplyPosition,
      cancel,
      { ...ratingScopeQuery(regionId), ...ratingPageQuery(null, limit) },
    );
    if (
      result.context.regionId !== regionId ||
      result.anchorReplyId !== replyId ||
      result.page.items.length > limit
    )
      invalidRating();
    return result;
  }
  async command(
    raw: RatingReplyIntent,
    cancel: Cancellation,
  ): Promise<RatingReplyReceipt> {
    const intent = decodeRatingReplyIntent(raw);
    const receipt = await this.api.request(
      {
        path:
          intent.operation === 'create_reply'
            ? `/v1/ratings/comments/${intent.rootId}/replies`
            : `/v1/ratings/replies/${intent.replyId}`,
        method: intent.operation === 'create_reply' ? 'POST' : 'DELETE',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingReplyReceipt,
      },
      {
        cancellation: cancel,
        body: JSON.parse(JSON.stringify(intent.payload)) as Json,
      },
    );
    matchRatingReplyReceipt(intent, receipt);
    return receipt;
  }
  async receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<RatingReplyReceipt> {
    if (!ratingId(requestId)) invalidRating();
    const receipt = await this.read(
      `/v1/ratings/reply-requests/${requestId}`,
      decodeRatingReplyReceipt,
      cancel,
    );
    if (receipt.requestId !== requestId) invalidRating();
    return receipt;
  }
}
