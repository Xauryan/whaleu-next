import { ClientError } from '../../api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../../community/controller';
import type { CommunityRuntime } from '../../community/runtime';
import type { SystemNotice } from '../../community/system-notices-contract';

export interface SystemNoticesView extends CommunityView {
  readonly items: readonly SystemNotice[];
  readonly unreadCount: number;
  readonly loaded: boolean;
  readonly canLoadMore: boolean;
}
export const initialSystemNoticesView = (): SystemNoticesView => ({
  ...initialCommunityView(),
  items: [],
  unreadCount: 0,
  loaded: false,
  canLoadMore: false,
});
const authorityFailure = (error: ClientError): boolean =>
  ['forbidden', 'auth-required', 'auth-expired', 'protocol'].includes(
    error.kind,
  ) || error.details.serverCode === 'NOTICE_NOT_FOUND';

/** Transient owner state only. Reading the list is never a read acknowledgment. */
export class SystemNoticesController extends CommunityController<SystemNoticesView> {
  private nextCursor: string | null = null;
  private cursors = new Set<string>();
  constructor(
    runtime: CommunityRuntime,
    render: (view: SystemNoticesView) => void,
  ) {
    super(runtime, initialSystemNoticesView, render);
    this.update({ configured: !!runtime.gateway && !!runtime.systemNotices });
  }
  protected override resetPrivate(): void {
    this.nextCursor = null;
    this.cursors.clear();
  }
  private clear(): void {
    this.resetPrivate();
    this.update({
      items: [],
      unreadCount: 0,
      loaded: false,
      canLoadMore: false,
    });
  }
  private ready(): boolean {
    if (!this.available()) return false;
    if (!this.runtime.systemNotices) {
      this.update({
        configured: false,
        status: '暂不可用',
        error: '当前构建尚未配置系统通知 API 环境',
      });
      return false;
    }
    return true;
  }
  protected override onSafetyInvalidated(): void {
    void this.load();
  }
  async load(): Promise<void> {
    this.stop();
    this.clear();
    this.update({ busy: false });
    if (!this.ready()) return;
    await this.fetch(false);
  }
  async more(): Promise<void> {
    if (
      this.view.busy ||
      !this.view.loaded ||
      !this.nextCursor ||
      !this.ready()
    )
      return;
    await this.fetch(true);
  }
  private async fetch(append: boolean): Promise<void> {
    const after = append ? this.nextCursor : null;
    await this.run(
      (cancel) => this.runtime.systemNotices!.list(after, cancel),
      (result) => {
        if (
          result.nextCursor &&
          (result.nextCursor === after || this.cursors.has(result.nextCursor))
        )
          throw new ClientError(
            'protocol',
            'System notice cursor did not advance',
          );
        if (after) this.cursors.add(after);
        this.nextCursor = result.nextCursor;
        const merged = new Map(
          (append ? this.view.items : []).map((item) => [
            item.noticeId.toLowerCase(),
            item,
          ]),
        );
        for (const item of result.items)
          merged.set(item.noticeId.toLowerCase(), item);
        this.update({
          items: [...merged.values()],
          unreadCount: result.unreadCount,
          loaded: true,
          canLoadMore: !!result.nextCursor,
          status: '已读取本账号的系统通知',
        });
      },
      (error) => {
        if (!append || authorityFailure(error)) this.clear();
      },
    );
  }
  /** The idempotent owner-only PUT can be retried after an uncertain response. */
  async acknowledge(noticeId: string): Promise<void> {
    const item = this.view.items.find((row) => row.noticeId === noticeId);
    if (
      !item ||
      item.readAt !== null ||
      this.view.busy ||
      !this.view.loaded ||
      !this.ready()
    )
      return;
    await this.run(
      (cancel) => this.runtime.systemNotices!.read(noticeId, cancel),
      (result) => {
        if (result.noticeId !== noticeId)
          throw new ClientError(
            'protocol',
            'System notice read target mismatch',
          );
        this.update({
          items: this.view.items.map((row) =>
            row.noticeId === noticeId ? { ...row, readAt: result.readAt } : row,
          ),
          unreadCount: result.unreadCount,
          status: '此条系统通知已标记为已读',
        });
      },
      (error) => {
        if (authorityFailure(error)) this.clear();
        else
          this.update({
            status: '已读结果尚未确认，可重试此条或刷新；重复确认不会重复计数',
          });
      },
    );
  }
  override cancel(): void {
    super.cancel();
    this.clear();
    this.update({
      error: '已停止等待；已发送的已读操作仍可能完成，请刷新确认',
    });
  }
}

export interface SystemNoticesBadgeView extends CommunityView {
  readonly unreadCount: number;
  readonly loaded: boolean;
}
export const initialSystemNoticesBadgeView = (): SystemNoticesBadgeView => ({
  ...initialCommunityView(),
  unreadCount: 0,
  loaded: false,
});
export class SystemNoticesBadgeController extends CommunityController<SystemNoticesBadgeView> {
  constructor(
    runtime: CommunityRuntime,
    render: (view: SystemNoticesBadgeView) => void,
  ) {
    super(runtime, initialSystemNoticesBadgeView, render);
    this.update({ configured: !!runtime.gateway && !!runtime.systemNotices });
  }
  protected override onSafetyInvalidated(): void {
    void this.load();
  }
  async load(): Promise<void> {
    this.stop();
    this.update({ unreadCount: 0, loaded: false, busy: false });
    if (!this.available()) return;
    if (!this.runtime.systemNotices) {
      this.update({
        configured: false,
        status: '暂不可用',
        error: '当前构建尚未配置系统通知 API 环境',
      });
      return;
    }
    await this.run(
      (cancel) => this.runtime.systemNotices!.unread(cancel),
      (result) =>
        this.update({
          unreadCount: result.unreadCount,
          loaded: true,
          status: '已读取系统通知未读数',
        }),
      () => this.update({ unreadCount: 0, loaded: false }),
    );
  }
  override cancel(): void {
    super.cancel();
    this.update({ unreadCount: 0, loaded: false, error: '' });
  }
}
