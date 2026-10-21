import type { ApiClient } from '../../api/client';
import type { Decoder } from '../../api/envelopes';
import type { Cancellation } from '../../platform/contracts';
import {
  decodeSocialUpdateRead,
  decodeSocialUpdateResolution,
  decodeSocialUpdatesPage,
  decodeSocialUpdateUnread,
  invalidSocialUpdate,
  socialUpdateCategory,
  socialUpdateCursor,
  socialUpdateId,
  type SocialUpdateCategory,
  type SocialUpdateRead,
  type SocialUpdateResolution,
  type SocialUpdatesPage,
  type SocialUpdateUnread,
} from './contract';

export interface SocialUpdatesGateway {
  list(
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<SocialUpdatesPage>;
  unread(cancel: Cancellation): Promise<SocialUpdateUnread>;
  target(
    noticeId: string,
    cancel: Cancellation,
  ): Promise<SocialUpdateResolution>;
  markRead(noticeId: string, cancel: Cancellation): Promise<SocialUpdateRead>;
}
const base = '/v1/me/social-updates';
/** A reader's category is immutable and present on every private request. */
export class HttpSocialUpdatesGateway implements SocialUpdatesGateway {
  constructor(
    private readonly api: ApiClient,
    private readonly category: SocialUpdateCategory,
  ) {
    if (!socialUpdateCategory(category)) invalidSocialUpdate();
  }
  private get<T>(
    path: string,
    decode: Decoder<T>,
    cancel: Cancellation,
    query: Readonly<Record<string, string | number>> = {},
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
      { cancellation: cancel, query: { ...query, category: this.category } },
    );
  }
  async list(
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<SocialUpdatesPage> {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 20 ||
      !(cursor === null || socialUpdateCursor(cursor))
    )
      invalidSocialUpdate();
    const page = await this.get(
      base,
      (raw) => decodeSocialUpdatesPage(raw, this.category),
      cancel,
      { limit, ...(cursor === null ? {} : { cursor }) },
    );
    if (
      page.items.length > limit ||
      (page.nextCursor !== null && page.nextCursor === cursor)
    )
      invalidSocialUpdate();
    return page;
  }
  unread(cancel: Cancellation): Promise<SocialUpdateUnread> {
    return this.get(`${base}/unread-count`, decodeSocialUpdateUnread, cancel);
  }
  async target(
    noticeId: string,
    cancel: Cancellation,
  ): Promise<SocialUpdateResolution> {
    if (!socialUpdateId(noticeId)) invalidSocialUpdate();
    const result = await this.get(
      `${base}/${noticeId}/target`,
      (raw) => decodeSocialUpdateResolution(raw, this.category),
      cancel,
    );
    if (result.noticeId !== noticeId) invalidSocialUpdate();
    return result;
  }
  async markRead(
    noticeId: string,
    cancel: Cancellation,
  ): Promise<SocialUpdateRead> {
    if (!socialUpdateId(noticeId)) invalidSocialUpdate();
    const result = await this.api.request(
      {
        path: `${base}/${noticeId}/read`,
        method: 'PUT',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeSocialUpdateRead,
      },
      { cancellation: cancel, query: { category: this.category }, body: {} },
    );
    if (result.noticeId !== noticeId) invalidSocialUpdate();
    return result;
  }
}
