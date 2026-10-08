import { checkDiscussionPrivacy } from '../../community/discussion-contract';
import type { CommentQuery } from '../../community/gateway';
import { ClientError } from '../../api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../../community/controller';
import type { Comment, Post } from '../../community/contract';
import type { CommunityRuntime } from '../../community/runtime';
export interface DetailView extends CommunityView {
  readonly post: Post | null;
  readonly locatedComment: Comment | null;
  readonly locatedReplyId: string;
  readonly comments: readonly Comment[];
  readonly loaded: boolean;
  readonly sort: 'time' | 'likes';
  readonly order: 'asc' | 'desc';
  readonly canLoadMore: boolean;
  readonly canPrevious: boolean;
  readonly pageNumber: number;
  readonly deleteTarget: {
    readonly kind: 'post' | 'comment';
    readonly id: string;
  } | null;
  readonly needsReload: boolean;
}
export const initialDetailView = (): DetailView => ({
  ...initialCommunityView(),
  post: null,
  locatedComment: null,
  locatedReplyId: '',
  comments: [],
  loaded: false,
  sort: 'likes',
  order: 'desc',
  canLoadMore: false,
  canPrevious: false,
  pageNumber: 0,
  deleteTarget: null,
  needsReload: false,
});
export class DetailController extends CommunityController<DetailView> {
  private nextCursor: string | null = null;
  // Only navigation tokens survive page replacement, never root/reply DTOs.
  private pageCursors: (string | null)[] = [null];
  private pageIndex = 0;
  private postReadGeneration = 0;
  /** Identifies when a post read began, not when its callback eventually arrives. */
  get readGeneration(): number {
    return this.postReadGeneration;
  }
  constructor(
    runtime: CommunityRuntime,
    private readonly postId: string,
    render: (view: DetailView) => void,
    private readonly onPost: (
      post: Post | null,
      readGeneration: number,
    ) => void = () => undefined,
    private readonly located:
      { commentId: string } | { replyId: string } | null = null,
  ) {
    super(runtime, initialDetailView, render);
    if (this.located) this.update({ sort: 'time' });
  }
  protected override resetPrivate(): void {
    this.resetNavigation();
    this.onPost?.(null, this.postReadGeneration);
  }
  private resetNavigation(): void {
    this.nextCursor = null;
    this.pageCursors = [null];
    this.pageIndex = 0;
  }
  private clear(resetNavigation = true): void {
    if (resetNavigation) this.resetNavigation();
    this.nextCursor = null;
    this.onPost(null, this.postReadGeneration);
    this.update({
      post: null,
      locatedComment: null,
      locatedReplyId: '',
      comments: [],
      loaded: false,
      canLoadMore: false,
      canPrevious: false,
      pageNumber: 0,
      deleteTarget: null,
      needsReload: true,
      busy: false,
    });
  }
  protected override onSafetyInvalidated(): void {
    void this.load();
  }
  async load(): Promise<void> {
    this.resetNavigation();
    await this.read(null, 0);
  }
  private async read(after: string | null, pageIndex: number): Promise<void> {
    const readGeneration = ++this.postReadGeneration;
    this.stop();
    this.clear(false);
    if (!this.available()) {
      this.resetNavigation();
      return;
    }
    // Never expose comments until a fresh parent visibility decision has succeeded.
    await this.run(
      async (cancel) => {
        const post = await this.runtime.gateway!.post(this.postId, cancel);
        const comments = await this.runtime.gateway!.comments(
          this.postId,
          after,
          cancel,
          { sort: this.view.sort, order: this.view.order },
        );
        const context = this.located
          ? await this.runtime.gateway!.discussionContext(
              post.id,
              this.located,
              cancel,
            )
          : null;
        this.checkCommentPrivacy(post, [
          ...comments.items,
          ...(context ? [context.comment] : []),
        ]);
        if (context?.reply)
          checkDiscussionPrivacy(post, [
            context.reply.author,
            ...(context.reply.target.status === 'available'
              ? [context.reply.target.author]
              : []),
          ]);
        return { post, comments, context };
      },
      (result) => {
        if (
          result.comments.nextCursor !== null &&
          (result.comments.nextCursor === after ||
            this.pageCursors
              .slice(0, pageIndex)
              .includes(result.comments.nextCursor))
        )
          throw new ClientError('protocol', 'Root cursor did not advance');
        this.nextCursor = result.comments.nextCursor;
        // Previous re-fetches current bodies and discards the old forward branch.
        this.pageCursors = [...this.pageCursors.slice(0, pageIndex), after];
        this.pageIndex = pageIndex;
        this.update({
          post: result.post,
          locatedComment: result.context?.comment ?? null,
          locatedReplyId: result.context?.reply?.id ?? '',
          comments: result.comments.items,
          canLoadMore: !!this.nextCursor,
          canPrevious: pageIndex > 0,
          pageNumber: pageIndex + 1,
          loaded: true,
          needsReload: false,
          status: '已加载帖子与评论',
        });
        this.onPost(result.post, readGeneration);
      },
      () => this.clear(),
    );
  }
  async more(): Promise<void> {
    if (
      !this.available() ||
      this.view.busy ||
      !this.view.loaded ||
      !this.nextCursor
    )
      return;
    await this.read(this.nextCursor, this.pageIndex + 1);
  }
  async previous(): Promise<void> {
    if (
      !this.available() ||
      this.view.busy ||
      !this.view.loaded ||
      !this.view.canPrevious ||
      this.pageIndex < 1
    )
      return;
    await this.read(this.pageCursors[this.pageIndex - 1]!, this.pageIndex - 1);
  }
  async moreReplies(commentId: string): Promise<void> {
    const root = this.view.comments.find((item) => item.id === commentId),
      after = root?.replyPreview.nextCursor;
    if (
      !root ||
      !after ||
      this.view.busy ||
      !this.view.post ||
      !this.available()
    )
      return;
    await this.run(
      (cancel) => this.runtime.gateway!.replies(root.id, after, cancel),
      (result) => {
        if (
          result.nextCursor === after ||
          result.items.some((item) => item.postId !== this.postId)
        )
          throw new ClientError('protocol', 'Reply continuation mismatch');
        checkDiscussionPrivacy(
          this.view.post!,
          result.items.flatMap((item) => [
            item.author,
            ...(item.target.status === 'available' ? [item.target.author] : []),
          ]),
        );
        this.update({
          comments: this.view.comments.map((item) =>
            item.id === root.id
              ? {
                  ...item,
                  replyPreview: {
                    items: [
                      ...new Map(
                        [...item.replyPreview.items, ...result.items].map(
                          (reply) => [reply.id, reply],
                        ),
                      ).values(),
                    ],
                    nextCursor: result.nextCursor,
                  },
                }
              : item,
          ),
        });
      },
      () => this.clear(),
    );
  }
  private checkCommentPrivacy(post: Post, comments: readonly Comment[]): void {
    checkDiscussionPrivacy(
      post,
      comments.flatMap((comment) => [
        comment.author,
        ...comment.replyPreview.items.flatMap((reply) => [
          reply.author,
          ...(reply.target.status === 'available' ? [reply.target.author] : []),
        ]),
      ]),
    );
  }
  async setOrdering(query: CommentQuery): Promise<void> {
    if (this.view.busy) return;
    this.update({
      sort: query.sort ?? this.view.sort,
      order: query.order ?? this.view.order,
    });
    await this.load();
  }
  requestDelete(kind: 'post' | 'comment', id: string): void {
    if (this.view.busy || !this.view.loaded || this.view.needsReload) return;
    const allowed =
      kind === 'post'
        ? this.view.post?.id === id && this.view.post.viewer.canDelete
        : this.view.comments.some(
            (item) => item.id === id && item.viewer.canDelete,
          );
    if (allowed) this.update({ deleteTarget: { kind, id } });
  }
  dismissDelete(): void {
    if (!this.view.busy) this.update({ deleteTarget: null });
  }
  async confirmDelete(): Promise<void> {
    const target = this.view.deleteTarget;
    if (!target || this.view.busy || !this.available()) return;
    await this.run(
      (cancel) =>
        target.kind === 'post'
          ? this.runtime.gateway!.deletePost(target.id, cancel)
          : this.runtime.gateway!.deleteComment(target.id, cancel),
      () => {
        if (target.kind === 'post') {
          this.clear();
          this.update({ needsReload: false, status: '帖子已删除' });
        } else {
          this.update({
            locatedComment:
              this.view.locatedComment?.id === target.id
                ? null
                : this.view.locatedComment,
            locatedReplyId:
              this.view.locatedComment?.id === target.id
                ? ''
                : this.view.locatedReplyId,
            comments: this.view.comments.filter(
              (item) => item.id !== target.id,
            ),
            post: this.view.post
              ? {
                  ...this.view.post,
                  commentCount: Math.max(0, this.view.post.commentCount - 1),
                  replyCount: Math.max(
                    0,
                    this.view.post.replyCount -
                      (this.view.comments.find((item) => item.id === target.id)
                        ?.replyCount ?? 0),
                  ),
                  discussionCount: Math.max(
                    0,
                    this.view.post.discussionCount -
                      1 -
                      (this.view.comments.find((item) => item.id === target.id)
                        ?.replyCount ?? 0),
                  ),
                }
              : null,
            deleteTarget: null,
            status: '评论已删除',
          });
        }
      },
      () => this.clear(),
    );
  }
  override cancel(): void {
    super.cancel();
    this.clear();
  }
}
