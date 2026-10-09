import {
  decodeRatingLikeNoticeTarget,
  decodeRatingLikeUpdatesPage,
  type RatingLikeNotice,
} from './like-updates-contract';
import { ClientError } from '../api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import { invalidRating, ratingId } from './contract';
import { ratingError } from './controller';
import { ratingThreadPath } from './discussion-controller';
import {
  decodeRatingNoticeRead,
  decodeRatingNoticeTarget,
  decodeRatingUpdatesPage,
  type RatingNotice,
} from './updates-contract';
export interface RatingUpdatesView extends CommunityView {
  readonly loaded: boolean;
  readonly items: readonly (RatingNotice | RatingLikeNotice)[];
  readonly category: 'reply' | 'like';
  readonly unreadCount: number | null;
  readonly canMore: boolean;
}
export const initialRatingUpdatesView = (): RatingUpdatesView => ({
  ...initialCommunityView(),
  loaded: false,
  category: 'reply',
  items: [],
  unreadCount: null,
  canMore: false,
});
export class RatingUpdatesController extends CommunityController<RatingUpdatesView> {
  private cursor: string | null = null;
  private readonly seen = new Set<string>();
  private inactive = false;
  private readonly unsubscribeScope: () => void;
  private readonly unsubscribeBrowse: () => void;
  constructor(
    runtime: CommunityRuntime,
    render: (view: RatingUpdatesView) => void,
    private readonly navigate: (path: string) => Promise<void>,
  ) {
    super(runtime, initialRatingUpdatesView, render);
    const invalidate = (accountId?: string) => {
      if (accountId !== undefined && accountId !== this.accountId()) return;
      this.stop();
      this.resetPrivate();
      this.clear();
      this.update({
        status: '身份或浏览校区已变化，评分更新预览已清除，请重新加载',
      });
    };
    this.unsubscribeScope =
      runtime.directoryScopeChanges?.subscribe(invalidate) ?? (() => undefined);
    this.unsubscribeBrowse =
      runtime.browsingScopeChanges?.subscribe(invalidate) ?? (() => undefined);
    this.update({ configured: !!runtime.ratingUpdates });
  }
  private gateway() {
    return this.view.category === 'like'
      ? this.runtime.ratingLikeUpdates
      : this.runtime.ratingUpdates;
  }
  private decodePage(raw: unknown) {
    return this.view.category === 'like'
      ? decodeRatingLikeUpdatesPage(raw)
      : decodeRatingUpdatesPage(raw);
  }
  async selectCategory(category: 'reply' | 'like'): Promise<void> {
    if (this.inactive || !['reply', 'like'].includes(category)) return;
    this.stop();
    this.clear(category);
    await this.load();
  }
  protected override available(): boolean {
    if (this.inactive) return false;
    if (!this.gateway() || !this.accountId()) {
      this.update({
        configured: !!this.gateway(),
        error: this.accountId()
          ? '当前构建尚未配置评分更新服务'
          : '请先登录查看自己的评分更新',
      });
      return false;
    }
    return true;
  }
  protected override resetPrivate(): void {
    this.cursor = null;
    this.seen.clear();
  }
  protected override onSafetyInvalidated(): void {
    this.update({
      configured: !!this.gateway(),
      status: '安全状态已变化，旧预览和分页已清除，请重新加载',
    });
  }
  private clear(category: 'reply' | 'like' = this.view.category): void {
    this.resetPrivate();
    this.update({
      ...initialRatingUpdatesView(),
      category,
      configured: !!(category === 'like'
        ? this.runtime.ratingLikeUpdates
        : this.runtime.ratingUpdates),
      hasSession: !!this.accountId(),
    });
  }
  async load(): Promise<void> {
    this.stop();
    this.clear();
    if (!this.available()) return;
    await this.run(
      async (cancel) => await this.gateway()!.list(null, cancel),
      (raw) => {
        const page = this.decodePage(raw);
        this.cursor = page.nextCursor;
        this.update({
          loaded: true,
          items: page.items,
          unreadCount: page.unreadCount,
          canMore: !!page.nextCursor,
          status:
            this.view.category === 'like'
              ? '已读取本账号当前本地赞通知'
              : '已读取本账号当前本地评分回复更新',
        });
      },
      (error) => {
        this.clear();
        this.update({
          error: ratingError(error),
          status: '评分更新暂不能确认，未读数不能视为零',
        });
      },
    );
  }
  async more(): Promise<void> {
    const cursor = this.cursor;
    if (!this.available() || !this.view.loaded || this.view.busy || !cursor)
      return;
    await this.run(
      async (cancel) => await this.gateway()!.list(cursor, cancel),
      (raw) => {
        const page = this.decodePage(raw);
        if (
          page.nextCursor &&
          (page.nextCursor === cursor || this.seen.has(page.nextCursor))
        )
          invalidRating();
        this.seen.add(cursor);
        this.cursor = page.nextCursor;
        const items = new Map(
          this.view.items.map((item) => [item.noticeId, item]),
        );
        for (const item of page.items) items.set(item.noticeId, item);
        this.update({
          items: [...items.values()],
          unreadCount: page.unreadCount,
          canMore: !!page.nextCursor,
          status:
            this.view.category === 'like'
              ? '已读取更多本地赞通知'
              : '已读取更多本地评分回复更新',
        });
      },
      (error) => {
        this.clear();
        this.update({
          error: ratingError(error),
          status: '旧预览和分页已清除，请重新加载',
        });
      },
    );
  }
  async open(noticeId: string): Promise<void> {
    if (
      !this.available() ||
      this.view.busy ||
      !this.view.loaded ||
      !ratingId(noticeId) ||
      !this.view.items.some(
        (item) => item.noticeId === noticeId && item.status === 'available',
      )
    )
      return;
    const owner = this.runtime.sessions.snapshot();
    await this.run(
      async (cancel) => {
        const raw = await this.gateway()!.target(noticeId, cancel);
        const result =
          this.view.category === 'like'
            ? decodeRatingLikeNoticeTarget(raw)
            : decodeRatingNoticeTarget(raw);
        if (result.noticeId !== noticeId) invalidRating();
        this.runtime.sessions.assertCurrent(owner);
        if (cancel.isCancelled || this.inactive)
          throw new ClientError('cancelled', 'Navigation cancelled');
        if (result.status === 'available')
          await this.navigate(
            this.view.category === 'like'
              ? `/pages/rating-thread/rating-thread?targetId=${result.target.targetId}&rootId=${result.target.rootId}${result.target.replyId ? `&replyId=${result.target.replyId}` : ''}${result.target.regionId ? `&regionId=${result.target.regionId}` : ''}&likeNoticeId=${noticeId}`
              : ratingThreadPath(
                  { ...result.target, replyId: result.target.replyId! },
                  noticeId,
                ),
          );
        return result;
      },
      (result) => {
        if (result.status === 'unavailable') {
          this.update({
            items: this.view.items.map((item) =>
              item.noticeId === noticeId
                ? {
                    noticeId: item.noticeId,
                    createdAt: item.createdAt,
                    readAt: item.readAt,
                    status: 'unavailable',
                  }
                : item,
            ),
            status: '此条更新的内容当前不可查看；未自动标记已读',
          });
        } else
          this.update({
            status:
              this.view.category === 'like'
                ? '打开后会重新定位；成功读取被赞内容才确认这条赞已读'
                : '打开回复后会重新定位；成功读取当前回复才确认这条更新已读',
          });
      },
      (error) => {
        this.clear();
        this.update({
          error: ratingError(error),
          status:
            this.view.category === 'like'
              ? '未确认打开被赞内容，未自动标记已读'
              : '未确认打开回复，未自动标记已读',
        });
      },
    );
  }
  async acknowledge(noticeId: string): Promise<void> {
    if (
      !this.available() ||
      this.view.busy ||
      !this.view.loaded ||
      !ratingId(noticeId) ||
      !this.view.items.some(
        (item) => item.noticeId === noticeId && item.readAt === null,
      )
    )
      return;
    await this.run(
      (cancel) => this.gateway()!.markRead(noticeId, cancel),
      (raw) => {
        const result = decodeRatingNoticeRead(raw);
        if (result.noticeId !== noticeId) invalidRating();
        this.update({
          items: this.view.items.map((item) =>
            item.noticeId === noticeId
              ? { ...item, readAt: result.readAt }
              : item,
          ),
          unreadCount: result.unreadCount,
          status: '这条评分更新已标记已读',
        });
      },
      (error) => {
        this.clear();
        this.update({
          error: ratingError(error),
          status: '这条更新的已读状态尚未确认，请重新加载',
        });
      },
    );
  }
  override cancel(): void {
    this.stop();
    this.clear();
    this.update({
      status: '已停止等待，预览和分页已清除；已发送的已读操作仍可能完成',
    });
  }
  override dispose(): void {
    this.inactive = true;
    this.unsubscribeScope();
    this.unsubscribeBrowse();
    super.dispose();
  }
}
