import { ClientError } from '../../api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../../community/controller';
import { checkDiscussionPrivacy } from '../../community/discussion-contract';
import type { CommunityRuntime } from '../../community/runtime';
import type { CommunityUpdate } from '../../community/updates-contract';

export interface UpdatesView extends CommunityView {
  readonly items: readonly CommunityUpdate[];
  readonly unreadCount: number;
  readonly loaded: boolean;
  readonly canLoadMore: boolean;
}
export const initialUpdatesView = (): UpdatesView => ({
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
    'COMMUNITY_UNAVAILABLE',
    'COMMUNITY_SCOPE_UNAVAILABLE',
    'NOTICE_NOT_FOUND',
  ].includes(error.details.serverCode ?? '');

/** No notice snapshots or unread values are persisted. Every response belongs to this login and page generation. */
export class UpdatesController extends CommunityController<UpdatesView> {
  private nextCursor: string | null = null;
  constructor(
    runtime: CommunityRuntime,
    render: (view: UpdatesView) => void,
    private readonly navigate: (url: string) => Promise<void>,
  ) {
    super(runtime, initialUpdatesView, render);
  }
  protected override resetPrivate(): void {
    this.nextCursor = null;
  }
  private clear(): void {
    this.nextCursor = null;
    this.update({
      items: [],
      unreadCount: 0,
      loaded: false,
      canLoadMore: false,
    });
  }
  protected override onSafetyInvalidated(): void {
    void this.load();
  }
  async load(): Promise<void> {
    this.stop();
    this.clear();
    this.update({ busy: false });
    if (!this.available()) return;
    await this.read(false);
  }
  async more(): Promise<void> {
    if (
      !this.available() ||
      this.view.busy ||
      !this.view.loaded ||
      !this.nextCursor
    )
      return;
    await this.read(true);
  }
  private async read(append: boolean): Promise<void> {
    const after = append ? this.nextCursor : null;
    await this.run(
      (cancel) => this.runtime.gateway!.updates(after, cancel),
      (result) => {
        if (result.nextCursor && result.nextCursor === after)
          throw new ClientError('protocol', 'Updates cursor did not advance');
        this.nextCursor = result.nextCursor;
        const merged = new Map(
          (append ? this.view.items : []).map((item) => [item.noticeId, item]),
        );
        for (const item of result.items) merged.set(item.noticeId, item);
        this.update({
          items: [...merged.values()],
          unreadCount: result.unreadCount,
          loaded: true,
          canLoadMore: !!result.nextCursor,
          status: '已读取本账号的社区站内更新',
        });
      },
      (error) => {
        if (!append || authorityFailure(error)) this.clear();
      },
    );
  }
  /** An explicit per-row acknowledgment. Retry is safe and never marks a category or another account. */
  async acknowledge(noticeId: string): Promise<void> {
    const item = this.view.items.find((row) => row.noticeId === noticeId);
    if (
      !item ||
      item.readAt !== null ||
      this.view.busy ||
      !this.view.loaded ||
      !this.available()
    )
      return;
    await this.run(
      (cancel) => this.runtime.gateway!.readUpdate(noticeId, cancel),
      (result) => {
        if (result.noticeId !== noticeId)
          throw new ClientError(
            'protocol',
            'Read acknowledgment target mismatch',
          );
        this.update({
          items: this.view.items.map((row) =>
            row.noticeId === noticeId ? { ...row, readAt: result.readAt } : row,
          ),
          unreadCount: result.unreadCount,
          status: '此条更新已标记为已读',
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
  private unavailable(noticeId: string): void {
    this.update({
      items: this.view.items.map((item): CommunityUpdate =>
        item.noticeId === noticeId
          ? {
              noticeId: item.noticeId,
              createdAt: item.createdAt,
              readAt: item.readAt,
              status: 'unavailable',
            }
          : item,
      ),
      status: '这条更新的内容当前不可查看，可单独标记为已读',
    });
  }
  /** The ID only resolves owner metadata; normal post and discussion authorization still decide access. */
  async open(noticeId: string): Promise<void> {
    const item = this.view.items.find((row) => row.noticeId === noticeId);
    if (
      !item ||
      item.status !== 'available' ||
      this.view.busy ||
      !this.view.loaded ||
      !this.available()
    )
      return;
    const owner = this.runtime.sessions.snapshot();
    await this.run(
      async (cancel) => {
        const current = () => {
          this.runtime.sessions.assertCurrent(owner);
          if (cancel.isCancelled)
            throw new ClientError('cancelled', 'Cancelled before navigation');
        };
        const resolved = await this.runtime.gateway!.updateTarget(
          noticeId,
          cancel,
        );
        current();
        if (resolved.noticeId !== noticeId)
          throw new ClientError('protocol', 'Update target identity mismatch');
        if (resolved.status === 'unavailable') return false;
        const target = resolved.target;
        if (
          target.postId !== item.target.postId ||
          target.commentId !== item.target.commentId ||
          target.replyId !== item.target.replyId
        )
          throw new ClientError('protocol', 'Update ancestry changed');
        const post = await this.runtime.gateway!.post(target.postId, cancel);
        current();
        const context = await this.runtime.gateway!.discussionContext(
          target.postId,
          target.replyId
            ? { replyId: target.replyId }
            : { commentId: target.commentId },
          cancel,
        );
        if (
          post.id !== target.postId ||
          context.comment.id !== target.commentId ||
          context.comment.postId !== post.id ||
          (target.replyId
            ? context.reply?.id !== target.replyId ||
              context.reply.rootCommentId !== target.commentId ||
              context.reply.postId !== post.id
            : context.reply !== null)
        )
          throw new ClientError('protocol', 'Located update ancestry mismatch');
        checkDiscussionPrivacy(post, [
          context.comment.author,
          ...(context.reply
            ? [
                context.reply.author,
                ...(context.reply.target.status === 'available'
                  ? [context.reply.target.author]
                  : []),
              ]
            : []),
        ]);
        current();
        const url = target.replyId
          ? `/pages/community-thread/community-thread?postId=${post.id}&rootCommentId=${context.comment.id}&replyId=${target.replyId}`
          : `/pages/community-detail/community-detail?postId=${post.id}&rootCommentId=${context.comment.id}`;
        await this.navigate(url);
        return true;
      },
      (opened) => {
        if (!opened) this.unavailable(noticeId);
        else
          this.update({
            status: '已打开目标；仅在点选“标记已读”时确认此条更新',
          });
      },
      (error) => {
        if (authorityFailure(error)) this.clear();
        else if (
          ['POST_NOT_FOUND', 'COMMENT_NOT_FOUND', 'REPLY_NOT_FOUND'].includes(
            error.details.serverCode ?? '',
          )
        )
          this.unavailable(noticeId);
      },
    );
  }
  override cancel(): void {
    super.cancel();
    this.clear();
  }
}

export interface UpdatesBadgeView extends CommunityView {
  readonly unreadCount: number;
  readonly loaded: boolean;
}
export const initialUpdatesBadgeView = (): UpdatesBadgeView => ({
  ...initialCommunityView(),
  unreadCount: 0,
  loaded: false,
});
export class UpdatesBadgeController extends CommunityController<UpdatesBadgeView> {
  constructor(
    runtime: CommunityRuntime,
    render: (view: UpdatesBadgeView) => void,
  ) {
    super(runtime, initialUpdatesBadgeView, render);
  }
  protected override onSafetyInvalidated(): void {
    void this.load();
  }
  async load(): Promise<void> {
    this.stop();
    this.update({ unreadCount: 0, loaded: false, busy: false });
    if (!this.available()) return;
    await this.run(
      (cancel) => this.runtime.gateway!.updatesUnread(cancel),
      (result) =>
        this.update({
          unreadCount: result.unreadCount,
          loaded: true,
          status: '已读取本站内未读数',
        }),
      () => this.update({ unreadCount: 0, loaded: false }),
    );
  }
  override cancel(): void {
    super.cancel();
    this.update({ unreadCount: 0, loaded: false });
  }
}
