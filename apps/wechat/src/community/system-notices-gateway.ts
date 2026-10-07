import type { ApiClient, Endpoint } from '../api/client';
import type { Cancellation } from '../platform/contracts';
import { isUuid } from '../profile/contract';
import { cursor, invalid } from './contract';
import {
  decodeSystemNoticeRead,
  decodeSystemNoticesList,
  decodeSystemNoticesUnread,
  type SystemNoticeRead,
  type SystemNoticesList,
  type SystemNoticesUnread,
} from './system-notices-contract';

export interface SystemNoticesGateway {
  list(
    after: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<SystemNoticesList>;
  unread(cancel: Cancellation): Promise<SystemNoticesUnread>;
  read(noticeId: string, cancel: Cancellation): Promise<SystemNoticeRead>;
}
const endpoint = <T>(
  path: string,
  decode: Endpoint<T>['decode'],
  method: Endpoint<T>['method'] = 'GET',
): Endpoint<T> => ({
  path,
  decode,
  method,
  authentication: 'required',
  successStatus: 200,
  authReplay: 'once',
});

/** This owner-only surface never queries community visibility or verification. */
export class HttpSystemNoticesGateway implements SystemNoticesGateway {
  constructor(private readonly api: ApiClient) {}
  async list(
    after: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<SystemNoticesList> {
    if (!cursor(after) || !Number.isInteger(limit) || limit < 1 || limit > 50)
      invalid();
    const result = await this.api.request(
      endpoint('/v1/me/system-notices', decodeSystemNoticesList),
      {
        query: { limit, ...(after ? { cursor: after } : {}) },
        cancellation: cancel,
      },
    );
    if (result.items.length > limit) invalid();
    return result;
  }
  unread(cancel: Cancellation): Promise<SystemNoticesUnread> {
    return this.api.request(
      endpoint('/v1/me/system-notices/unread-count', decodeSystemNoticesUnread),
      { cancellation: cancel },
    );
  }
  async read(
    noticeId: string,
    cancel: Cancellation,
  ): Promise<SystemNoticeRead> {
    if (!isUuid(noticeId)) invalid();
    const result = await this.api.request(
      endpoint(
        `/v1/me/system-notices/${noticeId}/read`,
        decodeSystemNoticeRead,
        'PUT',
      ),
      { body: {}, cancellation: cancel },
    );
    if (result.noticeId !== noticeId) invalid();
    return result;
  }
}
