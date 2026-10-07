import { ClientError } from '../../api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../../community/controller';
import type { Comment, Post } from '../../community/contract';
import {
  checkDiscussionPrivacy,
  type Reply,
} from '../../community/discussion-contract';
import type { CommunityRuntime } from '../../community/runtime';
export interface ThreadView extends CommunityView {
  readonly post: Post | null;
  readonly root: Comment | null;
  readonly replies: readonly Reply[];
  readonly locatedReply: Reply | null;
  readonly contextReplies: readonly Reply[];
  readonly loaded: boolean;
  readonly canLoadMore: boolean;
  readonly needsReload: boolean;
  readonly deleteReplyId: string;
}
export const initialThreadView = (): ThreadView => ({
  ...initialCommunityView(),
  post: null,
  root: null,
  replies: [],
  locatedReply: null,
  contextReplies: [],
  loaded: false,
  canLoadMore: false,
  needsReload: false,
  deleteReplyId: '',
});
export class ThreadController extends CommunityController<ThreadView> {
  private nextCursor: string | null = null;
  constructor(
    runtime: CommunityRuntime,
    private readonly postId: string,
    private readonly rootCommentId: string,
    private readonly replyId: string | null,
    render: (view: ThreadView) => void,
  ) {
    super(runtime, initialThreadView, render);
  }
  protected override resetPrivate(): void {
    this.nextCursor = null;
  }
  private clear(): void {
    this.nextCursor = null;
    this.update({
      post: null,
      root: null,
      replies: [],
      locatedReply: null,
      contextReplies: [],
      loaded: false,
      canLoadMore: false,
      needsReload: true,
      deleteReplyId: '',
    });
  }
  private check(post: Post, root: Comment, replies: readonly Reply[]): void {
    if (
      root.postId !== post.id ||
      root.id !== this.rootCommentId ||
      replies.some(
        (item) => item.postId !== post.id || item.rootCommentId !== root.id,
      )
    )
      throw new ClientError('protocol', 'Discussion ancestry mismatch');
    checkDiscussionPrivacy(post, [
      root.author,
      ...root.replyPreview.items.flatMap((item) => [
        item.author,
        ...(item.target.status === 'available' ? [item.target.author] : []),
      ]),
      ...replies.flatMap((item) => [
        item.author,
        ...(item.target.status === 'available' ? [item.target.author] : []),
      ]),
    ]);
  }
  async load(): Promise<void> {
    this.clear();
    if (!this.available()) return;
    await this.run(
      async (cancel) => {
        const post = await this.runtime.gateway!.post(this.postId, cancel);
        const root = await this.runtime.gateway!.comment(
          this.rootCommentId,
          cancel,
        );
        const replies = await this.runtime.gateway!.replies(
          root.id,
          null,
          cancel,
        );
        const context = this.replyId
          ? await this.runtime.gateway!.discussionContext(
              post.id,
              { replyId: this.replyId },
              cancel,
            )
          : null;
        this.check(post, root, [
          ...replies.items,
          ...(context
            ? [
                ...context.replies.items,
                ...(context.reply ? [context.reply] : []),
              ]
            : []),
        ]);
        if (context && context.comment.id !== root.id)
          throw new ClientError('protocol', 'Located root mismatch');
        return {
          post,
          root,
          replies,
          locatedReply: context?.reply ?? null,
          contextReplies: context?.replies.items ?? [],
        };
      },
      (result) => {
        this.nextCursor = result.replies.nextCursor;
        this.update({
          post: result.post,
          root: result.root,
          replies: result.replies.items,
          contextReplies: result.contextReplies.filter(
            (item) =>
              !result.replies.items.some((ordinary) => ordinary.id === item.id),
          ),
          locatedReply: result.replies.items.some(
            (item) => item.id === result.locatedReply?.id,
          )
            ? null
            : result.locatedReply,
          loaded: true,
          canLoadMore: !!this.nextCursor,
          needsReload: false,
          status: '已加载根评论与按时间递增的回复',
        });
      },
      () => this.clear(),
    );
  }
  async more(): Promise<void> {
    if (
      this.view.busy ||
      !this.view.loaded ||
      !this.nextCursor ||
      !this.available()
    )
      return;
    const after = this.nextCursor;
    await this.run(
      (cancel) =>
        this.runtime.gateway!.replies(this.rootCommentId, after, cancel),
      (result) => {
        if (result.nextCursor === after)
          throw new ClientError('protocol', 'Cursor did not advance');
        this.check(this.view.post!, this.view.root!, result.items);
        this.nextCursor = result.nextCursor;
        const replies = [
          ...new Map(
            [...this.view.replies, ...result.items].map((item) => [
              item.id,
              item,
            ]),
          ).values(),
        ];
        this.update({
          replies,
          contextReplies: this.view.contextReplies.filter(
            (item) => !replies.some((ordinary) => ordinary.id === item.id),
          ),
          locatedReply: replies.some(
            (item) => item.id === this.view.locatedReply?.id,
          )
            ? null
            : this.view.locatedReply,
          canLoadMore: !!this.nextCursor,
        });
      },
      () => this.clear(),
    );
  }
  requestDelete(replyId: string): void {
    if (
      !this.view.busy &&
      this.view.loaded &&
      (
        [...this.view.replies, ...this.view.contextReplies].find(
          (item) => item.id === replyId,
        ) ??
        (this.view.locatedReply?.id === replyId ? this.view.locatedReply : null)
      )?.viewer.canDelete
    )
      this.update({ deleteReplyId: replyId });
  }
  dismissDelete(): void {
    if (!this.view.busy) this.update({ deleteReplyId: '' });
  }
  async confirmDelete(): Promise<void> {
    if (this.view.busy || !this.view.deleteReplyId || !this.available()) return;
    const target = this.view.deleteReplyId;
    await this.run(
      (cancel) => this.runtime.gateway!.deleteReply(target, cancel),
      () => {
        this.clear();
        this.update({
          status: '回复已删除，请重新加载。其他人的后续回复仍保留',
        });
      },
      () => this.clear(),
    );
  }
  override cancel(): void {
    super.cancel();
    this.clear();
  }
}
