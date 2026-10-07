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
  deleteTarget: null,
  needsReload: false,
});
export class DetailController extends CommunityController<DetailView> {
  private nextCursor: string | null = null;
  constructor(
    runtime: CommunityRuntime,
    private readonly postId: string,
    render: (view: DetailView) => void,
    private readonly onPost: (post: Post | null) => void = () => undefined,
    private readonly located:
      { commentId: string } | { replyId: string } | null = null,
  ) {
    super(runtime, initialDetailView, render);
    if (this.located) this.update({ sort: 'time' });
  }
  protected override resetPrivate(): void {
    this.nextCursor = null;
    this.onPost?.(null);
  }
  private clear(): void {
    this.nextCursor = null;
    this.onPost(null);
    this.update({
      post: null,
      locatedComment: null,
      locatedReplyId: '',
      comments: [],
      loaded: false,
      canLoadMore: false,
      deleteTarget: null,
      needsReload: true,
    });
  }
  async load(): Promise<void> {
    this.clear();
    if (!this.available()) return;
    // Never expose comments until a fresh parent visibility decision has succeeded.
    await this.run(
      async (cancel) => {
        const post = await this.runtime.gateway!.post(this.postId, cancel);
        const comments = await this.runtime.gateway!.comments(
          this.postId,
          null,
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
        this.nextCursor = result.comments.nextCursor;
        this.update({
          post: result.post,
          locatedComment: result.context?.comment ?? null,
          locatedReplyId: result.context?.reply?.id ?? '',
          comments: result.comments.items,
          canLoadMore: !!this.nextCursor,
          loaded: true,
          needsReload: false,
          status: '已加载帖子与评论',
        });
        this.onPost(result.post);
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
    const after = this.nextCursor;
    await this.run(
      (cancel) =>
        this.runtime.gateway!.comments(this.postId, after, cancel, {
          sort: this.view.sort,
          order: this.view.order,
        }),
      (result) => {
        if (result.nextCursor === after)
          throw new ClientError('protocol', 'Cursor did not advance');
        if (this.view.post)
          this.checkCommentPrivacy(this.view.post, result.items);
        this.nextCursor = result.nextCursor;
        this.update({
          comments: [
            ...new Map(
              [...this.view.comments, ...result.items].map((item) => [
                item.id,
                item,
              ]),
            ).values(),
          ],
          canLoadMore: !!this.nextCursor,
        });
      },
      () => this.clear(),
    );
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
  async setLiked(liked: boolean): Promise<void> {
    if (
      !this.available() ||
      this.view.busy ||
      !this.view.post ||
      this.view.needsReload ||
      this.view.post.viewer.isLiked === liked
    )
      return;
    await this.run(
      (cancel) => this.runtime.gateway!.like(this.postId, liked, cancel),
      (result) => {
        const post = this.view.post;
        if (!post) return;
        this.update({
          post: {
            ...post,
            likeCount: result.likeCount,
            viewer: { ...post.viewer, isLiked: result.isLiked },
          },
          status: result.isLiked ? '已点赞' : '已取消点赞',
        });
      },
      () => this.clear(),
    );
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
