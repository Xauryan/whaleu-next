import type { ApiClient } from '../api/client';
import type { Authorization } from '../identity-privacy/overlay';
import type { Cancellation } from '../platform/contracts';
import {
  decodeErrandAdminAuthorization,
  decodeErrandAdminPage,
  decodeErrandAdminQuery,
  matchErrandAdminPage,
  type ErrandAdminPage,
  type ErrandAdminQuery,
} from './admin-contract';
import { errandCursor, invalidErrand } from './contract';
export interface ErrandAdminGateway {
  authorization(cancel: Cancellation): Promise<Authorization>;
  list(
    query: ErrandAdminQuery,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<ErrandAdminPage>;
}
/** Isolated read-only surface: no administrative mutation transport exists in E2A. */
export class HttpErrandAdminGateway implements ErrandAdminGateway {
  constructor(private readonly api: ApiClient) {}
  authorization(cancel: Cancellation): Promise<Authorization> {
    return this.api.request(
      {
        path: '/v1/me/authorization',
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeErrandAdminAuthorization,
      },
      { cancellation: cancel },
    );
  }
  async list(
    raw: ErrandAdminQuery,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<ErrandAdminPage> {
    const query = decodeErrandAdminQuery(raw);
    if (
      (cursor !== null && !errandCursor(cursor)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      invalidErrand();
    const page = await this.api.request(
      {
        path: '/v1/admin/errands',
        method: 'GET',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeErrandAdminPage,
      },
      {
        cancellation: cancel,
        query: { ...query, limit, ...(cursor ? { cursor } : {}) },
      },
    );
    matchErrandAdminPage(page, query, cursor, limit);
    return page;
  }
}
