import type { ApiClient } from '../api/client';
import type { Cancellation } from '../platform/contracts';
import { invalid } from './contract';
import {
  decodeSearchIntent,
  decodeSearchPage,
  searchCursor,
  type SearchIntent,
  type SearchPage,
} from './search-contract';

export interface SearchGateway {
  search(
    intent: SearchIntent,
    after: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<SearchPage>;
}
export class HttpSearchGateway implements SearchGateway {
  constructor(private readonly api: ApiClient) {}
  async search(
    raw: SearchIntent,
    after: string | null,
    cancel: Cancellation,
    limit = 10,
  ): Promise<SearchPage> {
    const intent = decodeSearchIntent(raw);
    if (
      (after !== null && !searchCursor(after)) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 10
    )
      invalid();
    const result = await this.api.request(
      {
        path: '/v1/community/search',
        method: 'GET',
        authentication: 'optional',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeSearchPage,
      },
      {
        query: {
          ...intent,
          limit,
          ...(after !== null ? { cursor: after } : {}),
        },
        cancellation: cancel,
      },
    );
    if (
      result.items.length > limit ||
      (result.continuation === 'more' && result.items.length !== limit) ||
      (result.continuation === 'scan_pending' &&
        result.items.length >= limit) ||
      (after !== null && result.nextCursor === after) ||
      (intent.type !== undefined &&
        intent.type !== 'all' &&
        (result.effectiveTypes.length !== 1 ||
          result.effectiveTypes[0] !== intent.type)) ||
      ((intent.type === undefined || intent.type === 'all') &&
        !['post', 'post,comment,reply'].includes(
          result.effectiveTypes.join(','),
        )) ||
      result.items.some(
        (item) =>
          (intent.scope === undefined
            ? item.space.id !== intent.spaceId
            : intent.scope !== 'all' && item.space.kind !== intent.scope) ||
          (intent.postId !== undefined && item.postId !== intent.postId) ||
          (intent.from !== undefined && item.createdAt < intent.from) ||
          (intent.to !== undefined && item.createdAt >= intent.to) ||
          (intent.category !== undefined &&
            item.category !== intent.category) ||
          (intent.scope === undefined &&
            intent.category === undefined &&
            item.tradingUrgency === 'urgent') ||
          (intent.tradingSubtype !== undefined &&
            item.tradingSubtype !== intent.tradingSubtype),
      )
    )
      invalid();
    return result;
  }
}
