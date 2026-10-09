import type { ApiClient } from '../api/client';
import type { Decoder } from '../api/envelopes';
import type { Cancellation } from '../platform/contracts';
import { invalidRating, ratingId } from './contract';
import { ratingPageQuery } from './discussion-gateway';
import {
  decodeRatingSubscriptionUpdatesPage,
  decodeRatingSubscriptionUnread,
  decodeRatingSubscriptionNoticeTarget,
  decodeRatingSubscriptionNoticeRead,
  type RatingSubscriptionUpdatesPage,
  type RatingSubscriptionNoticeTarget,
  type RatingSubscriptionNoticeRead,
} from './subscription-updates-contract';
export interface RatingSubscriptionUpdatesGateway {
  list(
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<RatingSubscriptionUpdatesPage>;
  unread(cancel: Cancellation): Promise<{ readonly unreadCount: number }>;
  target(
    noticeId: string,
    cancel: Cancellation,
  ): Promise<RatingSubscriptionNoticeTarget>;
  markRead(
    noticeId: string,
    cancel: Cancellation,
  ): Promise<RatingSubscriptionNoticeRead>;
}
const base = '/v1/me/ratings/subscription-updates';
export class HttpRatingSubscriptionUpdatesGateway implements RatingSubscriptionUpdatesGateway {
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
  ): Promise<RatingSubscriptionUpdatesPage> {
    const page = await this.read(
      base,
      decodeRatingSubscriptionUpdatesPage,
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
    return this.read(
      `${base}/unread-count`,
      decodeRatingSubscriptionUnread,
      cancel,
    );
  }
  async target(
    noticeId: string,
    cancel: Cancellation,
  ): Promise<RatingSubscriptionNoticeTarget> {
    if (!ratingId(noticeId)) invalidRating();
    const result = await this.read(
      `${base}/${noticeId}/target`,
      decodeRatingSubscriptionNoticeTarget,
      cancel,
    );
    if (result.noticeId !== noticeId) invalidRating();
    return result;
  }
  async markRead(
    noticeId: string,
    cancel: Cancellation,
  ): Promise<RatingSubscriptionNoticeRead> {
    if (!ratingId(noticeId)) invalidRating();
    const result = await this.api.request(
      {
        path: `${base}/${noticeId}/read`,
        method: 'PUT',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeRatingSubscriptionNoticeRead,
      },
      { cancellation: cancel, body: {} },
    );
    if (result.noticeId !== noticeId) invalidRating();
    return result;
  }
}
