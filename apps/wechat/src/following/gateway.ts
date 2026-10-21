import { ApiClient, type Endpoint } from '../api/client';
import { ClientError } from '../api/errors';
import { decodeFeed, isCategory, type Feed } from '../community/contract';
import { isTradingSubtype } from '../community/trading-contract';
import type { FeedQuery } from '../community/gateway';
import type { Cancellation } from '../platform/contracts';
import { isUuid } from '../profile/contract';
import {
  decodeFollowState,
  decodeFollowReceipt,
  type FollowReceipt,
  type FollowState,
} from './contract';
function invalid(): never {
  throw new ClientError('protocol', 'Invalid following contract');
}
function id(value: string): string {
  if (!isUuid(value)) invalid();
  return value;
}
export class FollowingGateway {
  constructor(private readonly api: ApiClient) {}
  async feed(query: FeedQuery, cancellation: Cancellation): Promise<Feed> {
    if (query.category !== undefined && !isCategory(query.category)) invalid();
    if (
      query.tradingSubtype !== undefined &&
      (query.category !== 'trading' || !isTradingSubtype(query.tradingSubtype))
    )
      invalid();
    if (
      query.cursor !== undefined &&
      (!/^[A-Za-z0-9_-]+$/.test(query.cursor) || query.cursor.length > 1024)
    )
      invalid();
    const result = await this.api.request<Feed>(
      {
        path: '/v1/community/following/posts',
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        decode: decodeFeed,
      },
      {
        cancellation,
        query: {
          spaceId: id(query.spaceId),
          limit: 10,
          ...(query.category ? { category: query.category } : {}),
          ...(query.cursor ? { cursor: query.cursor } : {}),
          ...(query.tradingSubtype
            ? { tradingSubtype: query.tradingSubtype }
            : {}),
        },
      },
    );
    if (
      result.items.some(
        (item) =>
          item.author.kind !== 'named' ||
          (item.space.id !== query.spaceId &&
            item.isRelatedCampusSync !== true) ||
          (query.category && item.category !== query.category) ||
          (query.tradingSubtype &&
            (item.trading?.subtype.kind !== 'known' ||
              item.trading.subtype.key !== query.tradingSubtype)) ||
          (!query.category && item.trading?.urgency === 'urgent'),
      )
    )
      invalid();
    return result;
  }
  async status(
    profileId: string,
    cancellation: Cancellation,
  ): Promise<FollowState> {
    const result = await this.api.request(this.endpoint(profileId, 'GET'), {
      cancellation,
    });
    if (result.profileId !== profileId) invalid();
    return result;
  }
  /** Keep the same requestId for retries of the same intent. Never manufacture a
   * second intent on an ambiguous network failure. Receipt may be historical:
   * refresh status after successful acknowledgement before rendering UI state. */
  async set(
    profileId: string,
    following: boolean,
    requestId: string,
    cancellation: Cancellation,
  ): Promise<FollowReceipt> {
    if (typeof following !== 'boolean') invalid();
    const result = await this.api.request(
      {
        path: `/v1/profiles/${id(profileId)}/follow`,
        method: following ? 'POST' : 'DELETE',
        authentication: 'required',
        authReplay: 'never',
        decode: decodeFollowReceipt,
      },
      { cancellation, body: { requestId: id(requestId) } },
    );
    if (
      result.profileId !== profileId ||
      result.following !== following ||
      result.requestId !== requestId
    )
      invalid();
    return result;
  }
  private endpoint(
    profileId: string,
    method: 'GET' | 'POST' | 'DELETE',
  ): Endpoint<FollowState> {
    return {
      path: `/v1/profiles/${id(profileId)}/follow`,
      method,
      authentication: 'required',
      authReplay: method === 'GET' ? 'once' : 'never',
      decode: decodeFollowState,
    };
  }
}
