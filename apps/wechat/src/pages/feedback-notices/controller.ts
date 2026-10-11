import { ClientError } from '../../api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../../community/controller';
import type { CommunityRuntime } from '../../community/runtime';
import type { FeedbackNotice } from '../../community/feedback-notices-contract';

export interface FeedbackNoticesView extends CommunityView {
  readonly items: readonly (FeedbackNotice & {
    readonly available: boolean | null;
  })[];
  readonly unreadCount: number;
  readonly loaded: boolean;
  readonly canLoadMore: boolean;
}
export const initialFeedbackNoticesView = (): FeedbackNoticesView => ({
  ...initialCommunityView(),
  items: [],
  unreadCount: 0,
  loaded: false,
  canLoadMore: false,
});
const authorityFailure = (error: ClientError): boolean =>
  ['forbidden', 'auth-required', 'auth-expired', 'protocol'].includes(
    error.kind,
  ) ||
  [
    'NOTICE_NOT_FOUND',
    'AUTHORIZATION_REQUIRED',
    'AUTHORIZATION_UNAVAILABLE',
  ].includes(error.details.serverCode ?? '');

/** Transient owner state only. Reading the list is never a read acknowledgment. */
export class FeedbackNoticesController extends CommunityController<FeedbackNoticesView> {
  private nextCursor: string | null = null;
  private cursors = new Set<string>();
  constructor(
    runtime: CommunityRuntime,
    render: (view: FeedbackNoticesView) => void,
    private readonly navigate: (url: string) => Promise<void>,
  ) {
    super(runtime, initialFeedbackNoticesView, render);
    this.update({ configured: !!runtime.gateway && !!runtime.feedbackNotices });
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
    if (!this.runtime.feedbackNotices) {
      this.update({
        configured: false,
        status: '暂不可用',
        error: '当前构建尚未配置反馈通知 API 环境',
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
      (cancel) => this.runtime.feedbackNotices!.list(after, cancel),
      (result) => {
        if (
          result.nextCursor &&
          (result.nextCursor === after || this.cursors.has(result.nextCursor))
        )
          throw new ClientError(
            'protocol',
            'Feedback notice cursor did not advance',
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
          merged.set(item.noticeId.toLowerCase(), { ...item, available: null });
        this.update({
          items: [...merged.values()],
          unreadCount: result.unreadCount,
          loaded: true,
          canLoadMore: !!result.nextCursor,
          status: '已读取本账号的反馈通知',
        });
      },
      (error) => {
        if (!append || authorityFailure(error)) this.clear();
      },
    );
  }
  private unavailable(noticeId: string): void {
    this.update({
      items: this.view.items.map((item) =>
        item.noticeId === noticeId ? { ...item, available: false } : item,
      ),
      status: '这条反馈当前不可查看；刷新后可重新确认',
    });
  }
  async open(noticeId: string): Promise<void> {
    const item = this.view.items.find((row) => row.noticeId === noticeId);
    if (
      !item ||
      item.available === false ||
      this.view.busy ||
      !this.view.loaded ||
      !this.ready()
    )
      return;
    const owner = this.runtime.sessions.snapshot();
    await this.run(
      async (cancel) => {
        const current = () => {
          this.runtime.sessions.assertCurrent(owner);
          if (cancel.isCancelled)
            throw new ClientError(
              'cancelled',
              'Cancelled before feedback navigation',
            );
        };
        const target = await this.runtime.feedbackNotices!.target(
          noticeId,
          cancel,
        );
        current();
        if (target.noticeId !== noticeId)
          throw new ClientError(
            'protocol',
            'Feedback target identity mismatch',
          );
        if (target.status === 'unavailable') return false;
        const post = await this.runtime.gateway!.post(target.postId, cancel);
        current();
        if (post.id !== target.postId || post.category !== 'feedback')
          throw new ClientError('protocol', 'Feedback target changed');
        await this.navigate(
          `/pages/community-detail/community-detail?postId=${post.id}`,
        );
        return true;
      },
      (opened) => {
        if (!opened) this.unavailable(noticeId);
        else this.update({ status: '已打开反馈；可单独点选此条通知标记已读' });
      },
      (error) => {
        if (authorityFailure(error)) this.clear();
        else if (
          ['POST_NOT_FOUND', 'POST_BLOCKED_BY_YOU'].includes(
            error.details.serverCode ?? '',
          )
        )
          this.unavailable(noticeId);
      },
    );
  }
  /** The idempotent owner-only PUT can be retried after an uncertain response. */
  async acknowledge(noticeId: string): Promise<void> {
    const item = this.view.items.find((row) => row.noticeId === noticeId);
    if (
      !item ||
      item.readAt !== null ||
      item.available === false ||
      this.view.busy ||
      !this.view.loaded ||
      !this.ready()
    )
      return;
    await this.run(
      (cancel) => this.runtime.feedbackNotices!.read(noticeId, cancel),
      (result) => {
        if (result.noticeId !== noticeId)
          throw new ClientError(
            'protocol',
            'Feedback notice read target mismatch',
          );
        this.update({
          items: this.view.items.map((row) =>
            row.noticeId === noticeId ? { ...row, readAt: result.readAt } : row,
          ),
          unreadCount: result.unreadCount,
          status: '此条反馈通知已标记为已读',
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
