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
  readonly comments: readonly Comment[];
  readonly loaded: boolean;
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
  comments: [],
  loaded: false,
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
  ) {
    super(runtime, initialDetailView, render);
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
        );
        this.checkCommentPrivacy(post, comments.items);
        return { post, comments };
      },
      (result) => {
        this.nextCursor = result.comments.nextCursor;
        this.update({
          post: result.post,
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
      (cancel) => this.runtime.gateway!.comments(this.postId, after, cancel),
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
  private checkCommentPrivacy(post: Post, comments: readonly Comment[]): void {
    if (
      post.author.kind === 'named' &&
      comments.some(
        (comment) =>
          comment.author.kind === 'anonymous' && comment.author.isPostAuthor,
      )
    )
      throw new ClientError(
        'protocol',
        'Anonymous comment cannot reveal a named parent relationship',
      );
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
            comments: this.view.comments.filter(
              (item) => item.id !== target.id,
            ),
            post: this.view.post
              ? {
                  ...this.view.post,
                  commentCount: Math.max(0, this.view.post.commentCount - 1),
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
