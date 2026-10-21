import {
  guardNoticeRead,
  type NoticeReadGuard,
} from '../../notifications/notice-read-guard';
import { ClientError, clientError } from '../../api/errors';
import type { SessionTicket } from '../../auth/session';
import {
  initialCommunityView,
  type CommunityView,
} from '../../community/controller';
import type { CommunityRuntime } from '../../community/runtime';
import { cancellable } from '../../platform/cancellable';
import { Cancellation } from '../../platform/contracts';
import {
  compareSocialUpdateTime,
  decodeSocialUpdateRead,
  decodeSocialUpdateResolution,
  decodeSocialUpdatesPage,
  invalidSocialUpdate,
  socialUpdateCategory,
  type SocialUpdate,
  type SocialUpdateCategory,
  type SocialUpdateTarget,
  type SocialUpdateUnread,
} from './contract';
import type { SocialUpdatesGateway } from './gateway';

export type SocialUpdatesRuntime = Pick<
  CommunityRuntime,
  'sessions' | 'privateViews' | 'safetyChanges'
>;
export interface SocialUpdatesView extends CommunityView {
  readonly loaded: boolean;
  readonly items: readonly SocialUpdate[];
  readonly canMore: boolean;
  readonly unreadCount: number | null;
  readonly unreadCountStatus: SocialUpdateUnread['unreadCountStatus'];
}
export const initialSocialUpdatesView = (): SocialUpdatesView => ({
  ...initialCommunityView(),
  loaded: false,
  items: [],
  canMore: false,
  unreadCount: null,
  unreadCountStatus: 'unavailable',
});
const labels = {
  likes: '社区点赞',
  saves: '社区收藏',
  followers: '新增关注',
} as const;
function sameTarget(
  left: SocialUpdateTarget,
  right: SocialUpdateTarget,
): boolean {
  return left.type === 'profile'
    ? right.type === 'profile' && left.profileId === right.profileId
    : right.type === 'community' &&
        left.postId === right.postId &&
        left.commentId === right.commentId &&
        left.replyId === right.replyId;
}
function targetPath(target: SocialUpdateTarget): string {
  if (target.type === 'profile')
    return `/pages/public-profile/public-profile?profileId=${target.profileId}`;
  if (target.replyId)
    return `/pages/community-thread/community-thread?postId=${target.postId}&rootCommentId=${target.commentId}&replyId=${target.replyId}`;
  return `/pages/community-detail/community-detail?postId=${target.postId}${target.commentId ? `&rootCommentId=${target.commentId}` : ''}`;
}
/** Private, category-bound owner. No persisted rows, eager reads, total inference or actor inference. */
export class SocialUpdatesController {
  private view: SocialUpdatesView;
  private readonly owner: SessionTicket;
  private cursor: string | null = null;
  private readonly seen = new Set<string>();
  private generation = 0;
  private stopped = false;
  private invalidated = false;
  private cancellation: Cancellation | undefined;
  private readonly unsubscribeSession: () => void;
  private readonly unsubscribeHide: () => void;
  private readonly unsubscribeSafety: () => void;
  constructor(
    private readonly runtime: SocialUpdatesRuntime,
    private readonly gateway: SocialUpdatesGateway | undefined,
    private readonly category: SocialUpdateCategory,
    private readonly render: (view: SocialUpdatesView) => void,
    private readonly navigate: (path: string) => Promise<void>,
  ) {
    if (!socialUpdateCategory(category)) invalidSocialUpdate();
    this.owner = runtime.sessions.snapshot();
    this.view = this.initial();
    this.unsubscribeSession = runtime.sessions.subscribe(() => {
      if (!this.ownsSession()) this.invalidate('登录状态已变化，请重新加载。');
    });
    this.unsubscribeHide =
      runtime.privateViews?.subscribe((accountId) => {
        if (
          accountId === undefined ||
          accountId === this.owner.credentials?.accountId
        )
          this.invalidate('消息已清除，请重新加载。');
      }) ?? (() => undefined);
    this.unsubscribeSafety =
      runtime.safetyChanges?.subscribe((accountId) => {
        if (accountId === this.owner.credentials?.accountId)
          this.invalidate('安全状态已变化，请重新加载。');
      }) ?? (() => undefined);
    this.render(this.view);
  }
  snapshot(): SocialUpdatesView {
    return this.view;
  }
  private initial(): SocialUpdatesView {
    return {
      ...initialSocialUpdatesView(),
      configured: !!this.gateway,
      hasSession: !!this.runtime.sessions.snapshot().credentials,
    };
  }
  private ownsSession(): boolean {
    const current = this.runtime.sessions.snapshot();
    return (
      current.epoch === this.owner.epoch &&
      current.credentials?.accountId === this.owner.credentials?.accountId &&
      current.credentials?.sessionId === this.owner.credentials?.sessionId
    );
  }
  private active(): boolean {
    return !this.stopped && !this.invalidated && this.ownsSession();
  }
  private update(patch: Partial<SocialUpdatesView>): void {
    if (this.stopped) return;
    this.view = Object.freeze({ ...this.view, ...patch });
    this.render(this.view);
  }
  private stop(): void {
    this.generation++;
    this.cancellation?.cancel();
    this.cancellation = undefined;
  }
  private clear(patch: Partial<SocialUpdatesView> = {}): void {
    this.cursor = null;
    this.seen.clear();
    this.update({ ...this.initial(), ...patch });
  }
  private invalidate(status: string): void {
    if (this.stopped || this.invalidated) return;
    this.invalidated = true;
    this.stop();
    this.clear({ status });
  }
  private available(): boolean {
    if (!this.active()) return false;
    if (!this.owner.credentials || !this.gateway) {
      this.clear({
        error: !this.owner.credentials
          ? '请先登录查看自己的互动消息'
          : `${labels[this.category]}服务暂未配置`,
      });
      return false;
    }
    return true;
  }
  private async run<T>(
    work: (cancel: Cancellation) => Promise<T>,
    apply: (result: T) => void,
    operation: 'load' | 'more' | 'open' | 'read',
  ): Promise<void> {
    if (!this.available() || this.view.busy) return;
    this.stop();
    const generation = this.generation;
    const cancel = new Cancellation();
    this.cancellation = cancel;
    let sent = this.runtime.sessions.snapshot();
    const current = () => this.active() && generation === this.generation;
    this.update({ busy: true, error: '' });
    try {
      const result = await cancellable(
        Promise.resolve().then(() => {
          if (!current() || cancel.isCancelled)
            throw new ClientError('cancelled', 'Social update cancelled');
          this.runtime.sessions.assertCurrent(this.owner);
          sent = this.runtime.sessions.snapshot();
          return work(cancel);
        }),
        cancel,
      );
      if (current()) apply(result);
    } catch (error) {
      if (!current()) return;
      const failure = clientError(error);
      if (
        failure.kind === 'auth-required' ||
        (failure.kind === 'forbidden' &&
          failure.details.serverCode === 'ACCOUNT_BLOCKED' &&
          failure.details.httpStatus === 403)
      ) {
        this.clear();
        try {
          this.runtime.sessions.logoutIfCurrent(sent);
        } catch {
          /* Never replace a newer login. */
        }
      }
      if (!current()) return;
      const authority =
        [
          'protocol',
          'forbidden',
          'auth-required',
          'auth-expired',
          'stale-session',
        ].includes(failure.kind) ||
        [
          'SOCIAL_UPDATES_UNAVAILABLE',
          'SOCIAL_UPDATE_NOT_FOUND',
          'NOTICE_NOT_FOUND',
          'SOCIAL_UPDATES_RESTART_REQUIRED',
          'DISCOVERY_RESTART_REQUIRED',
          'COMMUNITY_UNAVAILABLE',
          'SAFETY_UNAVAILABLE',
          'CONTENT_REVIEW_UNAVAILABLE',
          'SAFETY_MODERATION_UNAVAILABLE',
        ].includes(failure.details.serverCode ?? '');
      const errorText = `${labels[this.category]}${operation === 'read' ? '已读状态尚未确认' : operation === 'open' ? '暂时无法打开' : '暂时无法读取'}，请重试。`;
      if (authority || operation === 'load' || operation === 'more')
        this.clear({ error: errorText });
      else
        this.update({
          error: errorText,
          unreadCount: null,
          unreadCountStatus: 'unavailable',
        });
    } finally {
      if (current()) {
        this.cancellation = undefined;
        this.update({ busy: false });
      }
    }
  }
  async load(): Promise<void> {
    if (!this.active()) return;
    this.stop();
    this.clear();
    await this.readPage(null);
  }
  async more(): Promise<void> {
    if (!this.active() || !this.view.loaded || this.view.busy || !this.cursor)
      return;
    await this.readPage(this.cursor);
  }
  private async readPage(cursor: string | null): Promise<void> {
    await this.run(
      (cancel) => this.gateway!.list(cursor, cancel),
      (raw) => {
        const page = decodeSocialUpdatesPage(raw, this.category);
        if (
          page.nextCursor !== null &&
          (page.nextCursor === cursor || this.seen.has(page.nextCursor))
        )
          invalidSocialUpdate();
        if (cursor) this.seen.add(cursor);
        this.cursor = page.nextCursor;
        const merged = new Map(
          (cursor ? this.view.items : []).map((item) => [item.noticeId, item]),
        );
        for (const item of page.items) {
          const previous = merged.get(item.noticeId);
          if (
            previous &&
            (previous.createdAt !== item.createdAt ||
              (previous.readAt !== null && previous.readAt !== item.readAt) ||
              (previous.status === 'available' &&
                item.status === 'available' &&
                !sameTarget(previous.target, item.target)))
          )
            invalidSocialUpdate();
          merged.set(item.noticeId, item);
        }
        this.update({
          items: [...merged.values()],
          loaded: true,
          canMore: page.nextCursor !== null,
          unreadCount: page.unreadCount,
          unreadCountStatus: page.unreadCountStatus,
          status:
            page.unreadCountStatus === 'available'
              ? '已读取当前互动消息'
              : '未读范围暂不能确认，请稍后刷新',
        });
      },
      cursor ? 'more' : 'load',
    );
  }
  async open(noticeId: string): Promise<void> {
    if (!this.active() || !this.view.loaded || this.view.busy) return;
    const item = this.view.items.find((row) => row.noticeId === noticeId);
    if (!item || item.status !== 'available') return;
    await this.run(
      async (cancel) => {
        const result = decodeSocialUpdateResolution(
          await this.gateway!.target(noticeId, cancel),
          this.category,
        );
        if (
          result.noticeId !== noticeId ||
          (result.status === 'available' &&
            !sameTarget(item.target, result.target))
        )
          invalidSocialUpdate();
        if (!this.active() || cancel.isCancelled)
          throw new ClientError('cancelled', 'Navigation cancelled');
        this.runtime.sessions.assertCurrent(this.owner);
        if (result.status === 'available')
          await this.navigate(targetPath(result.target));
        return result;
      },
      (result) => {
        if (result.status === 'unavailable')
          this.update({
            items: this.view.items.map((row) =>
              row.noticeId === noticeId
                ? {
                    noticeId: row.noticeId,
                    createdAt: row.createdAt,
                    readAt: row.readAt,
                    status: 'unavailable',
                  }
                : row,
            ),
          });
        this.update({
          status:
            result.status === 'available'
              ? '已打开内容，未标记已读'
              : '此条消息暂不可查看，未标记已读',
        });
      },
      'open',
    );
  }
  async acknowledge(noticeId: string, guard?: NoticeReadGuard): Promise<void> {
    if (!this.active() || !this.view.loaded || this.view.busy) return;
    const item = this.view.items.find((row) => row.noticeId === noticeId);
    if (!item || item.readAt !== null) return;
    await this.run(
      (cancel) =>
        this.gateway!.markRead(noticeId, guardNoticeRead(cancel, guard)),
      (raw) => {
        const result = decodeSocialUpdateRead(raw);
        if (
          result.noticeId !== noticeId ||
          compareSocialUpdateTime(result.readAt, item.createdAt) < 0
        )
          invalidSocialUpdate();
        this.update({
          items: this.view.items.map((row) =>
            row.noticeId === noticeId ? { ...row, readAt: result.readAt } : row,
          ),
          unreadCount: result.unreadCount,
          unreadCountStatus: result.unreadCountStatus,
          status: '此条消息已标记已读',
        });
      },
      'read',
    );
  }
  cancel(): void {
    if (!this.active()) return;
    this.stop();
    this.clear({ status: '已停止等待；已发送的已读操作仍可能完成。' });
  }
  dispose(): void {
    if (this.stopped) return;
    this.stop();
    this.unsubscribeSession();
    this.unsubscribeHide();
    this.unsubscribeSafety();
    this.clear();
    this.stopped = true;
  }
}
