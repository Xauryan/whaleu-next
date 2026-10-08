import type { ApiClient } from '../api/client';
import type { Decoder } from '../api/envelopes';
import type { Authorization } from '../identity-privacy/overlay';
import type { Json, Cancellation } from '../platform/contracts';
import { decodeErrandAdminAuthorization } from './admin-contract';
import {
  decodeErrandAdminIntent,
  decodeErrandAdminReceipt,
  isOrderAdminIntent,
  matchErrandAdminReceipt,
  type ErrandAdminIntent,
  type ErrandAdminReceipt,
} from './admin-command-contract';
import {
  decodeErrandRestrictionHistory,
  decodeErrandRestrictionPage,
  decodeErrandRestrictionQuery,
  type ErrandRestrictionHistory,
  type ErrandRestrictionPage,
  type ErrandRestrictionQuery,
} from './restriction-contract';
import { errandCursor, errandId, invalidErrand } from './contract';
export interface ErrandAdminCommandsGateway {
  authorization(cancel: Cancellation): Promise<Authorization>;
  command(
    intent: ErrandAdminIntent,
    cancel: Cancellation,
  ): Promise<ErrandAdminReceipt>;
  receipt(
    intent: ErrandAdminIntent,
    cancel: Cancellation,
  ): Promise<ErrandAdminReceipt>;
  restrictions(
    query: ErrandRestrictionQuery,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<ErrandRestrictionPage>;
  history(
    restrictionId: string,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<ErrandRestrictionHistory>;
}
function pagination(cursor: string | null, limit: number): void {
  if (
    (cursor !== null && !errandCursor(cursor)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    invalidErrand();
}
export class HttpErrandAdminCommandsGateway implements ErrandAdminCommandsGateway {
  constructor(private readonly api: ApiClient) {}
  private get<T>(
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
  authorization(cancel: Cancellation): Promise<Authorization> {
    return this.get(
      '/v1/me/authorization',
      decodeErrandAdminAuthorization,
      cancel,
    );
  }
  async command(
    raw: ErrandAdminIntent,
    cancel: Cancellation,
  ): Promise<ErrandAdminReceipt> {
    const intent = decodeErrandAdminIntent(raw);
    const path = isOrderAdminIntent(intent)
      ? `/v1/admin/errands/${intent.orderId}/${intent.operation === 'admin_delete' ? 'delete' : 'restrict-accepter'}`
      : intent.operation === 'issue'
        ? '/v1/admin/errand-restrictions'
        : `/v1/admin/errand-restrictions/${intent.restrictionId}/release`;
    const result = await this.api.request(
      {
        path,
        method: 'POST',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeErrandAdminReceipt,
      },
      {
        cancellation: cancel,
        body: JSON.parse(JSON.stringify(intent.payload)) as Json,
      },
    );
    matchErrandAdminReceipt(intent, result);
    return result;
  }
  async receipt(
    raw: ErrandAdminIntent,
    cancel: Cancellation,
  ): Promise<ErrandAdminReceipt> {
    const intent = decodeErrandAdminIntent(raw);
    const result = await this.get(
      `/v1/admin/${isOrderAdminIntent(intent) ? 'errand-requests' : 'errand-restriction-requests'}/${intent.payload.clientRequestId}`,
      decodeErrandAdminReceipt,
      cancel,
    );
    matchErrandAdminReceipt(intent, result);
    return result;
  }
  async restrictions(
    raw: ErrandRestrictionQuery,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<ErrandRestrictionPage> {
    const query = decodeErrandRestrictionQuery(raw);
    pagination(cursor, limit);
    const result = await this.get(
      '/v1/admin/errand-restrictions',
      decodeErrandRestrictionPage,
      cancel,
      { ...query, limit, ...(cursor ? { cursor } : {}) },
    );
    if (
      result.items.length > limit ||
      (result.nextCursor !== null && result.nextCursor === cursor) ||
      result.items.some(
        (item) =>
          (query.action !== undefined && item.action !== query.action) ||
          (query.state !== 'all' && item.state !== query.state) ||
          (query.targetProfileId !== undefined &&
            item.subject.status === 'available' &&
            item.subject.profileId !== query.targetProfileId),
      )
    )
      invalidErrand();
    return result;
  }
  async history(
    restrictionId: string,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<ErrandRestrictionHistory> {
    if (!errandId(restrictionId)) invalidErrand();
    pagination(cursor, limit);
    const result = await this.get(
      `/v1/admin/errand-restrictions/${restrictionId}/history`,
      decodeErrandRestrictionHistory,
      cancel,
      { limit, ...(cursor ? { cursor } : {}) },
    );
    if (
      result.restriction.restrictionId !== restrictionId ||
      result.events.length > limit ||
      (result.nextCursor !== null && result.nextCursor === cursor)
    )
      invalidErrand();
    return result;
  }
}
