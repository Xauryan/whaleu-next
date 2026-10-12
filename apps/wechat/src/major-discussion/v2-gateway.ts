import type { ApiClient } from '../api/client';
import type { Decoder } from '../api/envelopes';
import { uploadDigest } from '../media/upload-contracts';
import type { Cancellation, Json } from '../platform/contracts';
import { majorCursor, majorId } from '../majors/contract';
import {
  decodeDiscussionRead,
  decodeDiscussionTarget,
  invalidDiscussion,
  type DiscussionSort,
  type DiscussionTarget,
} from './contract';
import {
  decodeDiscussionV2CancelTarget,
  decodeDiscussionV2Intent,
  decodeDiscussionV2Notices,
  decodeDiscussionV2Page,
  decodeDiscussionV2Receipt,
  matchDiscussionV2Receipt,
  type DiscussionV2CancelTarget,
  type DiscussionV2Intent,
  type DiscussionV2Notices,
  type DiscussionV2Page,
  type DiscussionV2Receipt,
} from './v2-contract';

export interface MajorDiscussionV2Gateway {
  list(
    majorId: string,
    rootId: string | null,
    sort: DiscussionSort,
    cursor: string | null,
    cancellation: Cancellation,
    limit?: number,
  ): Promise<DiscussionV2Page>;
  submit(
    intent: DiscussionV2Intent,
    cancellation: Cancellation,
  ): Promise<DiscussionV2Receipt>;
  cancel(
    target: DiscussionV2CancelTarget,
    cancellation: Cancellation,
    intentHash?: string | null,
  ): Promise<DiscussionV2Receipt>;
  receipt(
    requestId: string,
    cancellation: Cancellation,
  ): Promise<DiscussionV2Receipt>;
  notices(
    cursor: string | null,
    cancellation: Cancellation,
    limit?: number,
  ): Promise<DiscussionV2Notices>;
  target(
    noticeId: string,
    cancellation: Cancellation,
  ): Promise<DiscussionTarget>;
  read(
    noticeId: string,
    cancellation: Cancellation,
  ): Promise<{ readonly noticeId: string; readonly readAt: string }>;
}
function validPage(cursor: string | null, limit: number): void {
  if (
    (cursor !== null && !majorCursor(cursor)) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 50
  )
    invalidDiscussion();
}
export class HttpMajorDiscussionV2Gateway implements MajorDiscussionV2Gateway {
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
    cancellation: Cancellation,
    limit = 20,
  ): Promise<DiscussionV2Page> {
    if (
      !majorId(id) ||
      (rootId !== null && !majorId(rootId)) ||
      (sort !== 'likes' && sort !== 'time')
    )
      invalidDiscussion();
    validPage(cursor, limit);
    const page = await this.get(
      `/v2/majors/${id}/discussion${rootId ? `/${rootId}` : ''}`,
      decodeDiscussionV2Page,
      cancellation,
      { limit, ...(!rootId ? { sort } : {}), ...(cursor ? { cursor } : {}) },
    );
    if (
      page.majorId !== id ||
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
  async submit(
    raw: DiscussionV2Intent,
    cancellation: Cancellation,
  ): Promise<DiscussionV2Receipt> {
    const intent = decodeDiscussionV2Intent(raw);
    const prefix = `/v2/majors/${intent.majorId}/discussion`;
    const receipt = await this.api.request(
      {
        path:
          intent.operation === 'major.discussion.root.v2'
            ? prefix
            : `${prefix}/${intent.rootId}/replies`,
        method: 'POST',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeDiscussionV2Receipt,
      },
      {
        cancellation,
        body: JSON.parse(JSON.stringify(intent.command)) as Json,
      },
    );
    matchDiscussionV2Receipt(intent, receipt);
    return receipt;
  }
  async cancel(
    raw: DiscussionV2CancelTarget,
    cancellation: Cancellation,
    intentHash: string | null = null,
  ): Promise<DiscussionV2Receipt> {
    const target = decodeDiscussionV2CancelTarget(raw);
    if (intentHash !== null && !uploadDigest(intentHash)) invalidDiscussion();
    const receipt = await this.api.request(
      {
        path: `/v2/majors/discussion-requests/${target.clientRequestId}/cancel`,
        method: 'POST',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeDiscussionV2Receipt,
      },
      {
        cancellation,
        body: {
          protocol: target.protocol,
          operation: target.operation,
          majorId: target.majorId,
          ...(target.operation === 'major.discussion.reply.v2'
            ? { rootId: target.rootId }
            : {}),
          intentHash,
        },
      },
    );
    matchDiscussionV2Receipt(target, receipt);
    return receipt;
  }
  async receipt(
    requestId: string,
    cancellation: Cancellation,
  ): Promise<DiscussionV2Receipt> {
    if (!majorId(requestId)) invalidDiscussion();
    const result = await this.get(
      `/v2/majors/discussion-requests/${requestId}`,
      decodeDiscussionV2Receipt,
      cancellation,
    );
    if (result.requestId !== requestId) invalidDiscussion();
    return result;
  }
  async notices(
    cursor: string | null,
    cancellation: Cancellation,
    limit = 20,
  ): Promise<DiscussionV2Notices> {
    validPage(cursor, limit);
    const result = await this.get(
      '/v2/me/major-discussion/notices',
      decodeDiscussionV2Notices,
      cancellation,
      { limit, ...(cursor ? { cursor } : {}) },
    );
    if (
      result.items.length > limit ||
      (result.nextCursor !== null && result.nextCursor === cursor)
    )
      invalidDiscussion();
    return result;
  }
  target(
    noticeId: string,
    cancellation: Cancellation,
  ): Promise<DiscussionTarget> {
    if (!majorId(noticeId)) invalidDiscussion();
    return this.get(
      `/v2/me/major-discussion/notices/${noticeId}/target`,
      decodeDiscussionTarget,
      cancellation,
    );
  }
  async read(
    noticeId: string,
    cancellation: Cancellation,
  ): Promise<{ readonly noticeId: string; readonly readAt: string }> {
    if (!majorId(noticeId)) invalidDiscussion();
    const result = await this.api.request(
      {
        path: `/v2/me/major-discussion/notices/${noticeId}/read`,
        method: 'PUT',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeDiscussionRead,
      },
      { cancellation, body: {} },
    );
    if (result.noticeId !== noticeId) invalidDiscussion();
    return result;
  }
}
