import type { ApiClient } from '../api/client';
import type { Decoder } from '../api/envelopes';
import type { Cancellation } from '../platform/contracts';
import { invalidRating, ratingId } from './contract';
import { ratingPageQuery } from './discussion-gateway';
import {
  decodeRatingUpdatesPage,
  decodeRatingUnread,
  decodeRatingNoticeTarget,
  decodeRatingNoticeRead,
  type RatingUpdatesPage,
  type RatingNoticeTarget,
  type RatingNoticeRead,
} from './updates-contract';
export interface RatingUpdatesGateway {
  list(
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<RatingUpdatesPage>;
  unread(cancel: Cancellation): Promise<{ readonly unreadCount: number }>;
  target(noticeId: string, cancel: Cancellation): Promise<RatingNoticeTarget>;
  markRead(noticeId: string, cancel: Cancellation): Promise<RatingNoticeRead>;
}
const base = '/v1/me/ratings/updates';
export class HttpRatingUpdatesGateway implements RatingUpdatesGateway {
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
  ): Promise<RatingUpdatesPage> {
    const page = await this.read(
      base,
      decodeRatingUpdatesPage,
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
    return this.read(`${base}/unread-count`, decodeRatingUnread, cancel);
  }
  async target(
    noticeId: string,
    cancel: Cancellation,
  ): Promise<RatingNoticeTarget> {
    if (!ratingId(noticeId)) invalidRating();
    const result = await this.read(
      `${base}/${noticeId}/target`,
      decodeRatingNoticeTarget,
      cancel,
    );
    if (result.noticeId !== noticeId) invalidRating();
    return result;
  }
  async markRead(
    noticeId: string,
    cancel: Cancellation,
  ): Promise<RatingNoticeRead> {
    if (!ratingId(noticeId)) invalidRating();
    const result = await this.api.request(
      {
        path: `${base}/${noticeId}/read`,
        method: 'PUT',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingNoticeRead,
      },
      { cancellation: cancel, body: {} },
    );
    if (result.noticeId !== noticeId) invalidRating();
    return result;
  }
}
