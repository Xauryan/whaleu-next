import type { ApiClient } from '../api/client';
import type { Decoder } from '../api/envelopes';
import type { Cancellation, Json } from '../platform/contracts';
import { windowCursor, windowId } from '../window-ratings/contract';
import {
  decodeDiscussionIntent,
  decodeDiscussionPage,
  decodeDiscussionReceipt,
  decodeDiscussionOwn,
  decodeDiscussionNotices,
  decodeDiscussionRead,
  decodeDiscussionTarget,
  invalidDiscussion,
  matchDiscussionReceipt,
  type DiscussionIntent,
  type DiscussionPage,
  type DiscussionReceipt,
  type DiscussionOwn,
  type DiscussionSort,
  type DiscussionNotices,
  type DiscussionTarget,
} from './contract';
export interface WindowDiscussionGateway {
  list(
    windowId: string,
    rootId: string | null,
    sort: DiscussionSort,
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<DiscussionPage>;
  own(
    windowId: string,
    commentId: string,
    cancel: Cancellation,
  ): Promise<DiscussionOwn>;
  submit(
    intent: DiscussionIntent,
    cancel: Cancellation,
  ): Promise<DiscussionReceipt>;
  cancel(
    intent: DiscussionIntent,
    cancel: Cancellation,
  ): Promise<DiscussionReceipt>;
  receipt(requestId: string, cancel: Cancellation): Promise<DiscussionReceipt>;
  notices(
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<DiscussionNotices>;
  target(noticeId: string, cancel: Cancellation): Promise<DiscussionTarget>;
  read(
    noticeId: string,
    cancel: Cancellation,
  ): Promise<{ readonly noticeId: string; readonly readAt: string }>;
}
const validPage = (cursor: string | null, limit: number) => {
  if (
    (cursor !== null && !windowCursor(cursor)) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    invalidDiscussion();
};
export class HttpWindowDiscussionGateway implements WindowDiscussionGateway {
  constructor(private readonly api: ApiClient) {}
  private get<T>(
    path: string,
    decode: Decoder<T>,
    cancellation: Cancellation,
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
      { cancellation, ...(query ? { query } : {}) },
    );
  }
  async list(
    id: string,
    rootId: string | null,
    sort: DiscussionSort,
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<DiscussionPage> {
    if (
      !windowId(id) ||
      (rootId !== null && !windowId(rootId)) ||
      (sort !== 'likes' && sort !== 'time')
    )
      invalidDiscussion();
    validPage(cursor, limit);
    const page = await this.get(
      `/v1/ratings/windows/${id}/discussion${rootId ? `/${rootId}` : ''}`,
      decodeDiscussionPage,
      cancel,
      { limit, ...(!rootId ? { sort } : {}), ...(cursor ? { cursor } : {}) },
    );
    if (
      page.windowId !== id ||
      (page.root?.id ?? null) !== rootId ||
      page.items.length > limit ||
      (page.nextCursor !== null && page.nextCursor === cursor)
    )
      invalidDiscussion();
    for (let n = 1; n < page.items.length; n++) {
      const a = page.items[n - 1]!,
        b = page.items[n]!;
      if (
        rootId
          ? a.createdAt > b.createdAt ||
            (a.createdAt === b.createdAt && a.id >= b.id)
          : sort === 'likes'
            ? a.likes < b.likes ||
              (a.likes === b.likes &&
                (a.createdAt < b.createdAt ||
                  (a.createdAt === b.createdAt && a.id <= b.id)))
            : a.createdAt < b.createdAt ||
              (a.createdAt === b.createdAt && a.id <= b.id)
      )
        invalidDiscussion();
    }
    return page;
  }
  own(
    id: string,
    comment: string,
    cancel: Cancellation,
  ): Promise<DiscussionOwn> {
    if (!windowId(id) || !windowId(comment)) invalidDiscussion();
    return this.get(
      `/v1/ratings/windows/${id}/discussion/${comment}/my-like`,
      decodeDiscussionOwn,
      cancel,
    );
  }
  private async write(
    raw: DiscussionIntent,
    cancellation: Cancellation,
    cancelling: boolean,
  ): Promise<DiscussionReceipt> {
    const i = decodeDiscussionIntent(raw),
      prefix = `/v1/ratings/windows/${i.windowId}/discussion`;
    const path = cancelling
      ? `/v1/ratings/windows/discussion-requests/${i.command.clientRequestId}/cancel`
      : i.operation === 'window.discussion.root.v1'
        ? prefix
        : i.operation === 'window.discussion.reply.v1'
          ? `${prefix}/${i.rootId}/replies`
          : `${prefix}/${i.commentId}/like`;
    const receipt = await this.api.request(
      {
        path,
        method: 'POST',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeDiscussionReceipt,
      },
      {
        cancellation,
        body: JSON.parse(JSON.stringify(cancelling ? i : i.command)) as Json,
      },
    );
    matchDiscussionReceipt(i, receipt);
    return receipt;
  }
  submit(i: DiscussionIntent, c: Cancellation): Promise<DiscussionReceipt> {
    return this.write(i, c, false);
  }
  cancel(i: DiscussionIntent, c: Cancellation): Promise<DiscussionReceipt> {
    return this.write(i, c, true);
  }
  async receipt(id: string, c: Cancellation): Promise<DiscussionReceipt> {
    if (!windowId(id)) invalidDiscussion();
    const r = await this.get(
      `/v1/ratings/windows/discussion-requests/${id}`,
      decodeDiscussionReceipt,
      c,
    );
    if (r.requestId !== id) invalidDiscussion();
    return r;
  }
  async notices(
    cursor: string | null,
    c: Cancellation,
    limit = 20,
  ): Promise<DiscussionNotices> {
    validPage(cursor, limit);
    const r = await this.get(
      '/v1/me/window-discussion/notices',
      decodeDiscussionNotices,
      c,
      { limit, ...(cursor ? { cursor } : {}) },
    );
    if (
      r.items.length > limit ||
      (r.nextCursor !== null && r.nextCursor === cursor)
    )
      invalidDiscussion();
    return r;
  }
  target(id: string, c: Cancellation): Promise<DiscussionTarget> {
    if (!windowId(id)) invalidDiscussion();
    return this.get(
      `/v1/me/window-discussion/notices/${id}/target`,
      decodeDiscussionTarget,
      c,
    );
  }
  async read(
    id: string,
    cancellation: Cancellation,
  ): Promise<{ readonly noticeId: string; readonly readAt: string }> {
    if (!windowId(id)) invalidDiscussion();
    const r = await this.api.request(
      {
        path: `/v1/me/window-discussion/notices/${id}/read`,
        method: 'PUT',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeDiscussionRead,
      },
      { cancellation, body: {} },
    );
    if (r.noticeId !== id) invalidDiscussion();
    return r;
  }
}
