import type { ApiClient } from '../api/client';
import type { Decoder } from '../api/envelopes';
import { activityTimestamp } from '../activities/contract';
import { exact } from '../community/contract';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import type { Cancellation } from '../platform/contracts';
import { errandCursor, errandId, invalidErrand } from './contract';
import { decodeErrandNotice, type ErrandNotice } from './admin-notice-contract';
export { decodeErrandNotice, type ErrandNotice } from './admin-notice-contract';
export interface ErrandNoticesPage {
  readonly items: readonly ErrandNotice[];
  readonly nextCursor: string | null;
  readonly unreadCount: number;
}
export interface ErrandNoticeRead {
  readonly noticeId: string;
  readonly readAt: string;
  readonly unreadCount: number;
}
const count = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 0 &&
  value <= 2147483647;
export function decodeErrandNoticesPage(value: unknown): ErrandNoticesPage {
  exact(value, ['items', 'nextCursor', 'unreadCount']);
  if (
    !Array.isArray(value.items) ||
    value.items.length > 50 ||
    !(value.nextCursor === null || errandCursor(value.nextCursor)) ||
    !count(value.unreadCount)
  )
    invalidErrand();
  const items = value.items.map(decodeErrandNotice);
  if (
    new Set(items.map((item) => item.noticeId)).size !== items.length ||
    items.filter((item) => item.readAt === null).length > value.unreadCount
  )
    invalidErrand();
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: value.nextCursor,
    unreadCount: value.unreadCount,
  });
}
export function decodeErrandNoticeRead(value: unknown): ErrandNoticeRead {
  exact(value, ['noticeId', 'readAt', 'unreadCount']);
  if (
    !errandId(value.noticeId) ||
    !activityTimestamp(value.readAt) ||
    !count(value.unreadCount)
  )
    invalidErrand();
  return Object.freeze({
    noticeId: value.noticeId,
    readAt: value.readAt,
    unreadCount: value.unreadCount,
  });
}
export function decodeErrandUnread(value: unknown): {
  readonly unreadCount: number;
} {
  exact(value, ['unreadCount']);
  if (!count(value.unreadCount)) invalidErrand();
  return Object.freeze({ unreadCount: value.unreadCount });
}
export interface ErrandNoticesGateway {
  list(
    cursor: string | null,
    cancel: Cancellation,
    limit?: number,
  ): Promise<ErrandNoticesPage>;
  read(noticeId: string, cancel: Cancellation): Promise<ErrandNoticeRead>;
  unread(cancel: Cancellation): Promise<{ readonly unreadCount: number }>;
}
export class HttpErrandNoticesGateway implements ErrandNoticesGateway {
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
  async list(
    cursor: string | null,
    cancel: Cancellation,
    limit = 20,
  ): Promise<ErrandNoticesPage> {
    if (
      (cursor !== null && !errandCursor(cursor)) ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      invalidErrand();
    const result = await this.get(
      '/v1/me/errand-notices',
      decodeErrandNoticesPage,
      cancel,
      { limit, ...(cursor ? { cursor } : {}) },
    );
    if (
      result.items.length > limit ||
      (result.nextCursor !== null && result.nextCursor === cursor)
    )
      invalidErrand();
    return result;
  }
  async read(
    noticeId: string,
    cancel: Cancellation,
  ): Promise<ErrandNoticeRead> {
    if (!errandId(noticeId)) invalidErrand();
    const result = await this.api.request(
      {
        path: `/v1/me/errand-notices/${noticeId}/read`,
        method: 'PUT',
        authentication: 'required',
        authReplay: 'once',
        successStatus: 200,
        decode: decodeErrandNoticeRead,
      },
      { body: {}, cancellation: cancel },
    );
    if (result.noticeId !== noticeId) invalidErrand();
    return result;
  }
  unread(cancel: Cancellation): Promise<{ readonly unreadCount: number }> {
    return this.get(
      '/v1/me/errand-notices/unread-count',
      decodeErrandUnread,
      cancel,
    );
  }
}
export interface ErrandNoticesView extends CommunityView {
  readonly loaded: boolean;
  readonly items: readonly ErrandNotice[];
  readonly unreadCount: number;
  readonly canMore: boolean;
}
export const initialErrandNoticesView = (): ErrandNoticesView => ({
  ...initialCommunityView(),
  loaded: false,
  items: [],
  unreadCount: 0,
  canMore: false,
});
/** Owner-only local notices. Reading a list does not acknowledge; order navigation rereads fresh detail. */
export class ErrandNoticesController extends CommunityController<ErrandNoticesView> {
  private nextCursor: string | null = null;
  private cursors = new Set<string>();
  constructor(
    runtime: CommunityRuntime,
    render: (view: ErrandNoticesView) => void,
  ) {
    super(runtime, initialErrandNoticesView, render);
    this.update({ configured: !!runtime.errandNotices });
  }
  protected override resetPrivate(): void {
    this.nextCursor = null;
    this.cursors.clear();
  }
  protected override available(): boolean {
    if (!this.runtime.errandNotices || !this.accountId()) {
      this.update({
        configured: !!this.runtime.errandNotices,
        error: !this.accountId()
          ? '请先登录后查看跑腿通知'
          : '跑腿通知服务尚未配置',
      });
      return false;
    }
    return true;
  }
  protected override onSafetyInvalidated(): void {
    this.update({ status: '安全状态已变化，请重新加载通知' });
  }
  private clear(): void {
    this.stop();
    this.resetPrivate();
    this.update({
      busy: false,
      loaded: false,
      items: [],
      unreadCount: 0,
      canMore: false,
    });
  }
  async load(): Promise<void> {
    this.clear();
    if (this.available()) await this.fetch(false);
  }
  async more(): Promise<void> {
    if (
      !this.view.busy &&
      this.view.loaded &&
      this.nextCursor &&
      this.available()
    )
      await this.fetch(true);
  }
  private async fetch(append: boolean): Promise<void> {
    const cursor = append ? this.nextCursor : null;
    await this.run(
      (cancel) => this.runtime.errandNotices!.list(cursor, cancel),
      (raw) => {
        const result = decodeErrandNoticesPage(raw);
        if (
          result.nextCursor &&
          (result.nextCursor === cursor || this.cursors.has(result.nextCursor))
        )
          invalidErrand();
        if (cursor) this.cursors.add(cursor);
        this.nextCursor = result.nextCursor;
        const items = new Map(
          (append ? this.view.items : []).map((item) => [item.noticeId, item]),
        );
        for (const item of result.items) items.set(item.noticeId, item);
        this.update({
          items: [...items.values()],
          loaded: true,
          canMore: !!result.nextCursor,
          unreadCount: result.unreadCount,
          status: result.nextCursor
            ? '已加载本账号的跑腿通知'
            : '已到跑腿通知末尾',
        });
      },
      () => this.clear(),
    );
  }
  async read(noticeId: string): Promise<void> {
    if (
      this.view.busy ||
      !this.view.loaded ||
      !this.available() ||
      !this.view.items.some(
        (item) => item.noticeId === noticeId && item.readAt === null,
      )
    )
      return;
    await this.run(
      (cancel) => this.runtime.errandNotices!.read(noticeId, cancel),
      (raw) => {
        const result = decodeErrandNoticeRead(raw);
        if (result.noticeId !== noticeId) invalidErrand();
        this.update({
          items: this.view.items.map((item) =>
            item.noticeId === noticeId
              ? { ...item, readAt: result.readAt }
              : item,
          ),
          unreadCount: result.unreadCount,
          status: '此条通知已标记为已读',
        });
      },
      (error) => {
        if (
          ['protocol', 'forbidden', 'auth-required', 'auth-expired'].includes(
            error.kind,
          ) ||
          ['NOTICE_NOT_FOUND', 'ERRAND_NOT_FOUND'].includes(
            error.details.serverCode ?? '',
          )
        )
          this.clear();
        else
          this.update({
            status: '已读结果尚未确认，可刷新或重试；不会重复计数',
          });
      },
    );
  }
  orderPath(noticeId: string): string | null {
    if (!this.view.loaded || this.view.busy || !this.accountId()) return null;
    const item = this.view.items.find((row) => row.noticeId === noticeId);
    return item && (item.kind === 'accepted' || item.kind === 'completed')
      ? `/pages/errand-detail/errand-detail?orderId=${item.orderId}`
      : null;
  }
  override cancel(): void {
    this.clear();
    this.update({
      status: '已停止等待，已发送的已读操作仍可能完成，请刷新确认',
    });
  }
}
