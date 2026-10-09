import type { ApiClient } from '../api/client';
import type { Decoder } from '../api/envelopes';
import type { Cancellation, Json } from '../platform/contracts';
import {
  decodeRatingContext,
  decodeRatingCategoryPage,
  decodeRatingTargetPage,
  decodeRatingTarget,
  decodeRatingMyScore,
  decodeRatingSummary,
  decodeRatingCommentPage,
  decodeRatingComment,
  decodeRatingIntent,
  decodeRatingReceipt,
  invalidRating,
  ratingCursor,
  ratingId,
  matchRatingReceipt,
  type RatingContext,
  type RatingCategoryPage,
  type RatingTargetPage,
  type RatingTarget,
  type RatingMyScore,
  type RatingSummary,
  type RatingCommentPage,
  type RatingComment,
  type RatingIntent,
  type RatingReceipt,
} from './contract';
export interface RatingsGateway {
  context(cancel: Cancellation): Promise<RatingContext>;
  categories(
    regionId: string | null,
    parentId: string | null,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<RatingCategoryPage>;
  targets(
    regionId: string | null,
    categoryId: string,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<RatingTargetPage>;
  detail(
    regionId: string | null,
    targetId: string,
    cancel: Cancellation,
  ): Promise<RatingTarget>;
  myScore(
    regionId: string | null,
    targetId: string,
    cancel: Cancellation,
  ): Promise<RatingMyScore>;
  summary(
    regionId: string | null,
    targetId: string,
    cancel: Cancellation,
  ): Promise<RatingSummary>;
  comments(
    regionId: string | null,
    targetId: string,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<RatingCommentPage>;
  comment(
    regionId: string | null,
    commentId: string,
    cancel: Cancellation,
  ): Promise<RatingComment>;
  command(intent: RatingIntent, cancel: Cancellation): Promise<RatingReceipt>;
  receipt(requestId: string, cancel: Cancellation): Promise<RatingReceipt>;
}
const scope = (regionId: string | null): Record<string, string | number> => {
  if (regionId !== null && !ratingId(regionId)) invalidRating();
  return regionId === null ? {} : { regionId };
};
const pagination = (
  cursor: string | null,
  limit: number,
): Record<string, string | number> => {
  if (
    (cursor !== null && !ratingCursor(cursor)) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    invalidRating();
  return { limit, ...(cursor === null ? {} : { cursor }) };
};
function checkPage(
  page: RatingCategoryPage | RatingTargetPage | RatingCommentPage,
  regionId: string | null,
  cursor: string | null,
  limit: number,
): void {
  if (
    page.context.regionId !== regionId ||
    page.items.length > limit ||
    (page.nextCursor !== null && page.nextCursor === cursor)
  )
    invalidRating();
}
export class HttpRatingsGateway implements RatingsGateway {
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
  context(cancel: Cancellation): Promise<RatingContext> {
    return this.read('/v1/ratings/context', decodeRatingContext, cancel);
  }
  async categories(
    regionId: string | null,
    parentId: string | null,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<RatingCategoryPage> {
    if (parentId !== null && !ratingId(parentId)) invalidRating();
    const page = await this.read(
      '/v1/ratings/categories',
      decodeRatingCategoryPage,
      cancel,
      {
        ...scope(regionId),
        ...(parentId ? { parentId } : {}),
        ...pagination(cursor, limit),
      },
    );
    checkPage(page, regionId, cursor, limit);
    if (page.context.parentId !== parentId) invalidRating();
    return page;
  }
  async targets(
    regionId: string | null,
    categoryId: string,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<RatingTargetPage> {
    if (!ratingId(categoryId)) invalidRating();
    const page = await this.read(
      '/v1/ratings/targets',
      decodeRatingTargetPage,
      cancel,
      { ...scope(regionId), categoryId, ...pagination(cursor, limit) },
    );
    checkPage(page, regionId, cursor, limit);
    if (page.context.categoryId !== categoryId) invalidRating();
    return page;
  }
  async detail(
    regionId: string | null,
    targetId: string,
    cancel: Cancellation,
  ): Promise<RatingTarget> {
    if (!ratingId(targetId)) invalidRating();
    const detail = await this.read(
      `/v1/ratings/targets/${targetId}`,
      decodeRatingTarget,
      cancel,
      scope(regionId),
    );
    if (detail.id !== targetId) invalidRating();
    return detail;
  }
  myScore(
    regionId: string | null,
    targetId: string,
    cancel: Cancellation,
  ): Promise<RatingMyScore> {
    if (!ratingId(targetId)) invalidRating();
    return this.read(
      `/v1/ratings/targets/${targetId}/my-score`,
      decodeRatingMyScore,
      cancel,
      scope(regionId),
    );
  }
  summary(
    regionId: string | null,
    targetId: string,
    cancel: Cancellation,
  ): Promise<RatingSummary> {
    if (!ratingId(targetId)) invalidRating();
    return this.read(
      `/v1/ratings/targets/${targetId}/score-summary`,
      decodeRatingSummary,
      cancel,
      scope(regionId),
    );
  }
  async comments(
    regionId: string | null,
    targetId: string,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<RatingCommentPage> {
    if (!ratingId(targetId)) invalidRating();
    const page = await this.read(
      `/v1/ratings/targets/${targetId}/comments`,
      decodeRatingCommentPage,
      cancel,
      { ...scope(regionId), ...pagination(cursor, limit) },
    );
    checkPage(page, regionId, cursor, limit);
    if (page.context.targetId !== targetId) invalidRating();
    return page;
  }
  async comment(
    regionId: string | null,
    commentId: string,
    cancel: Cancellation,
  ): Promise<RatingComment> {
    if (!ratingId(commentId)) invalidRating();
    const item = await this.read(
      `/v1/ratings/comments/${commentId}`,
      decodeRatingComment,
      cancel,
      scope(regionId),
    );
    if (item.id !== commentId) invalidRating();
    return item;
  }
  async command(
    raw: RatingIntent,
    cancel: Cancellation,
  ): Promise<RatingReceipt> {
    const intent = decodeRatingIntent(raw);
    const receipt = await this.api.request(
      {
        path:
          intent.operation === 'delete_comment'
            ? `/v1/ratings/comments/${intent.commentId}`
            : `/v1/ratings/targets/${intent.targetId}/${intent.operation === 'set_score' ? 'my-score' : 'comments'}`,
        method:
          intent.operation === 'set_score'
            ? 'PUT'
            : intent.operation === 'create_comment'
              ? 'POST'
              : 'DELETE',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingReceipt,
      },
      {
        cancellation: cancel,
        body: JSON.parse(JSON.stringify(intent.payload)) as Json,
      },
    );
    matchRatingReceipt(intent, receipt);
    return receipt;
  }
  async receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<RatingReceipt> {
    if (!ratingId(requestId)) invalidRating();
    const receipt = await this.read(
      `/v1/ratings/requests/${requestId}`,
      decodeRatingReceipt,
      cancel,
    );
    if (receipt.requestId !== requestId) invalidRating();
    return receipt;
  }
}
