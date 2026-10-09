import type { ApiClient } from '../api/client';
import type { Decoder } from '../api/envelopes';
import type { Cancellation } from '../platform/contracts';
import { invalidRating, ratingId } from './contract';
import { ratingPageQuery } from './discussion-gateway';
import {
  decodeRatingLikeUpdatesPage,
  decodeRatingLikeUnread,
  decodeRatingLikeNoticeTarget,
  decodeRatingLikeNoticeRead,
  type RatingLikeUpdatesPage,
  type RatingLikeNoticeTarget,
  type RatingLikeNoticeRead,
} from './like-updates-contract';
export interface RatingLikeUpdatesGateway {
  list(
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<RatingLikeUpdatesPage>;
  unread(cancel: Cancellation): Promise<{ readonly unreadCount: number }>;
  target(
    noticeId: string,
    cancel: Cancellation,
  ): Promise<RatingLikeNoticeTarget>;
  markRead(
    noticeId: string,
    cancel: Cancellation,
  ): Promise<RatingLikeNoticeRead>;
}
const base = '/v1/me/ratings/like-updates';
export class HttpRatingLikeUpdatesGateway implements RatingLikeUpdatesGateway {
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
  async list(
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<RatingLikeUpdatesPage> {
    const page = await this.read(
      base,
      decodeRatingLikeUpdatesPage,
      cancel,
      ratingPageQuery(cursor, limit, 20),
    );
    if (
      page.items.length > limit ||
      (page.nextCursor !== null && page.nextCursor === cursor)
    )
      invalidRating();
    return page;
  }
  unread(cancel: Cancellation): Promise<{ readonly unreadCount: number }> {
    return this.read(`${base}/unread-count`, decodeRatingLikeUnread, cancel);
  }
  async target(
    noticeId: string,
    cancel: Cancellation,
  ): Promise<RatingLikeNoticeTarget> {
    if (!ratingId(noticeId)) invalidRating();
    const result = await this.read(
      `${base}/${noticeId}/target`,
      decodeRatingLikeNoticeTarget,
      cancel,
    );
    if (result.noticeId !== noticeId) invalidRating();
    return result;
  }
  async markRead(
    noticeId: string,
    cancel: Cancellation,
  ): Promise<RatingLikeNoticeRead> {
    if (!ratingId(noticeId)) invalidRating();
    const result = await this.api.request(
      {
        path: `${base}/${noticeId}/read`,
        method: 'PUT',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingLikeNoticeRead,
      },
      { cancellation: cancel, body: {} },
    );
    if (result.noticeId !== noticeId) invalidRating();
    return result;
  }
}
