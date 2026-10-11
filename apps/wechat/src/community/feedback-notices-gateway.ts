import type { ApiClient, Endpoint } from '../api/client';
import type { Cancellation } from '../platform/contracts';
import { isUuid } from '../profile/contract';
import { cursor, invalid } from './contract';
import {
  decodeFeedbackNoticeRead,
  decodeFeedbackNoticeTarget,
  type FeedbackNoticeTarget,
  decodeFeedbackNoticesList,
  decodeFeedbackNoticesUnread,
  type FeedbackNoticeRead,
  type FeedbackNoticesList,
  type FeedbackNoticesUnread,
} from './feedback-notices-contract';

export interface FeedbackNoticesGateway {
  list(
    after: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<FeedbackNoticesList>;
  unread(cancel: Cancellation): Promise<FeedbackNoticesUnread>;
  target(noticeId: string, cancel: Cancellation): Promise<FeedbackNoticeTarget>;
  read(noticeId: string, cancel: Cancellation): Promise<FeedbackNoticeRead>;
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

/** Every request requires current super_admin authority; target/read also recheck exact content access. */
export class HttpFeedbackNoticesGateway implements FeedbackNoticesGateway {
  constructor(private readonly api: ApiClient) {}
  async list(
    after: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<FeedbackNoticesList> {
    if (!cursor(after) || !Number.isInteger(limit) || limit < 1 || limit > 50)
      invalid();
    const result = await this.api.request(
      endpoint('/v1/me/feedback-notices', decodeFeedbackNoticesList),
      {
        query: { limit, ...(after ? { cursor: after } : {}) },
        cancellation: cancel,
      },
    );
    if (result.items.length > limit) invalid();
    return result;
  }
  unread(cancel: Cancellation): Promise<FeedbackNoticesUnread> {
    return this.api.request(
      endpoint(
        '/v1/me/feedback-notices/unread-count',
        decodeFeedbackNoticesUnread,
      ),
      { cancellation: cancel },
    );
  }
  async target(
    noticeId: string,
    cancel: Cancellation,
  ): Promise<FeedbackNoticeTarget> {
    if (!isUuid(noticeId)) invalid();
    const result = await this.api.request(
      endpoint(
        `/v1/me/feedback-notices/${noticeId}/target`,
        decodeFeedbackNoticeTarget,
      ),
      { cancellation: cancel },
    );
    if (result.noticeId !== noticeId) invalid();
    return result;
  }
  async read(
    noticeId: string,
    cancel: Cancellation,
  ): Promise<FeedbackNoticeRead> {
    if (!isUuid(noticeId)) invalid();
    const result = await this.api.request(
      endpoint(
        `/v1/me/feedback-notices/${noticeId}/read`,
        decodeFeedbackNoticeRead,
        'PUT',
      ),
      { body: {}, cancellation: cancel },
    );
    if (result.noticeId !== noticeId) invalid();
    return result;
  }
}
