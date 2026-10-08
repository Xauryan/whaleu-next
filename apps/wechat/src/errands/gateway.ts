import type { ApiClient } from '../api/client';
import type { Decoder } from '../api/envelopes';
import type { Cancellation, Json } from '../platform/contracts';
import {
  decodeErrandContactHistory,
  decodeErrandDetail,
  decodeErrandIntent,
  decodeErrandPage,
  decodeErrandReceipt,
  decodeOperatingRegions,
  errandCursor,
  errandId,
  invalidErrand,
  matchErrandReceipt,
  type ErrandContactHistory,
  type ErrandDetail,
  type ErrandIntent,
  type ErrandListQuery,
  type ErrandPage,
  type ErrandReceipt,
  type ErrandRegion,
  type ErrandRelation,
} from './contract';
export interface ErrandsGateway {
  regions(
    campusId: string,
    cancel: Cancellation,
  ): Promise<readonly ErrandRegion[]>;
  list(
    query: ErrandListQuery,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<ErrandPage>;
  mine(
    relation: ErrandRelation,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<ErrandPage>;
  detail(orderId: string, cancel: Cancellation): Promise<ErrandDetail>;
  contactHistory(cancel: Cancellation): Promise<ErrandContactHistory>;
  command(intent: ErrandIntent, cancel: Cancellation): Promise<ErrandReceipt>;
  receipt(requestId: string, cancel: Cancellation): Promise<ErrandReceipt>;
}
export class HttpErrandsGateway implements ErrandsGateway {
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
  regions(
    campusId: string,
    cancel: Cancellation,
  ): Promise<readonly ErrandRegion[]> {
    if (!errandId(campusId)) invalidErrand();
    return this.read('/v1/operating-regions', decodeOperatingRegions, cancel, {
      campusId,
    });
  }
  async list(
    query: ErrandListQuery,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<ErrandPage> {
    if (
      !errandId(query.regionId) ||
      !['all', 'pending'].includes(query.filter) ||
      !['created', 'reward'].includes(query.sort) ||
      !['asc', 'desc'].includes(query.direction) ||
      Object.keys(query).length !== 4
    )
      invalidErrand();
    const result = await this.read('/v1/errands', decodeErrandPage, cancel, {
      ...query,
      ...pagination(cursor, limit),
    });
    checkPage(result, cursor, limit);
    if (
      result.context.kind !== 'discovery' ||
      result.context.regionId !== query.regionId ||
      result.items.some(
        (item) =>
          item.targetRegion.id !== query.regionId ||
          !['pending', 'accepted'].includes(item.state) ||
          (query.filter === 'pending' && item.state !== 'pending'),
      )
    )
      invalidErrand();
    return result;
  }
  async mine(
    relation: ErrandRelation,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<ErrandPage> {
    if (!['published', 'accepted'].includes(relation)) invalidErrand();
    const result = await this.read('/v1/me/errands', decodeErrandPage, cancel, {
      relation,
      ...pagination(cursor, limit),
    });
    checkPage(result, cursor, limit);
    if (result.context.kind !== 'own' || result.context.relation !== relation)
      invalidErrand();
    return result;
  }
  async detail(orderId: string, cancel: Cancellation): Promise<ErrandDetail> {
    if (!errandId(orderId)) invalidErrand();
    const result = await this.read(
      `/v1/errands/${orderId}`,
      decodeErrandDetail,
      cancel,
    );
    if (result.id !== orderId) invalidErrand();
    return result;
  }
  contactHistory(cancel: Cancellation): Promise<ErrandContactHistory> {
    return this.read(
      '/v1/me/errands/contact-history',
      decodeErrandContactHistory,
      cancel,
    );
  }
  async command(
    raw: ErrandIntent,
    cancel: Cancellation,
  ): Promise<ErrandReceipt> {
    const intent = decodeErrandIntent(raw);
    const receipt = await this.api.request(
      {
        path:
          intent.operation === 'publish'
            ? '/v1/errands'
            : `/v1/errands/${intent.orderId}/${intent.operation}`,
        method: 'POST',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeErrandReceipt,
      },
      {
        cancellation: cancel,
        body: JSON.parse(JSON.stringify(intent.payload)) as Json,
      },
    );
    matchErrandReceipt(intent, receipt);
    return receipt;
  }
  async receipt(
    requestId: string,
    cancel: Cancellation,
  ): Promise<ErrandReceipt> {
    if (!errandId(requestId)) invalidErrand();
    const result = await this.read(
      `/v1/me/errand-requests/${requestId}`,
      decodeErrandReceipt,
      cancel,
    );
    if (result.requestId !== requestId) invalidErrand();
    return result;
  }
}
function pagination(
  cursor: string | null,
  limit: number,
): Record<string, string | number> {
  if (
    (cursor !== null && !errandCursor(cursor)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    invalidErrand();
  return { limit, ...(cursor ? { cursor } : {}) };
}
function checkPage(
  page: ErrandPage,
  cursor: string | null,
  limit: number,
): void {
  if (
    page.items.length > limit ||
    (page.nextCursor !== null && page.nextCursor === cursor)
  )
    invalidErrand();
}
