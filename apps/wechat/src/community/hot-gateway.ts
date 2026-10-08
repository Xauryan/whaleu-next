import type { ApiClient } from '../api/client';
import type { Cancellation } from '../platform/contracts';
import { invalid } from './contract';
import {
  decodeHotIntent,
  decodeHotPage,
  hotCursor,
  type HotIntent,
  type HotPage,
} from './hot-contract';

export interface HotGateway {
  hot(
    intent: HotIntent,
    after: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<HotPage>;
}
export class HttpHotGateway implements HotGateway {
  constructor(private readonly api: ApiClient) {}
  async hot(
    raw: HotIntent,
    after: string | null,
    cancel: Cancellation,
    limit = 10,
  ): Promise<HotPage> {
    const intent = decodeHotIntent(raw);
    if (
      (after !== null && !hotCursor(after)) ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 10
    )
      invalid();
    const result = await this.api.request(
      {
        path: '/v1/community/hot',
        method: 'GET',
        authentication: 'optional',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeHotPage,
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
          item.space.id !== intent.spaceId ||
          item.trading?.urgency === 'urgent' ||
          item.trading?.resolution === 'resolved',
      )
    )
      invalid();
    return result;
  }
}
