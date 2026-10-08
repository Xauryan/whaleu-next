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
      result.items.some(
        (item) =>
          (intent.scope === undefined
            ? item.space.id !== intent.spaceId
            : intent.scope !== 'all' && item.space.kind !== intent.scope) ||
          (intent.category !== undefined &&
            item.category !== intent.category) ||
          (intent.scope === undefined &&
            intent.category === undefined &&
            item.trading?.urgency === 'urgent') ||
          (intent.tradingSubtype !== undefined &&
            (!item.trading ||
              item.trading.subtype.kind !== 'known' ||
              item.trading.subtype.key !== intent.tradingSubtype)),
      )
    )
      invalid();
    return result;
  }
}
