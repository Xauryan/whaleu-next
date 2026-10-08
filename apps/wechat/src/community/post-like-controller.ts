import { ClientError } from '../api/errors';
import type { Cancellation } from '../platform/contracts';
import type { Post } from './contract';
import {
  CommunityController,
  communityError,
  initialCommunityView,
  reasonMessage,
  type CommunityView,
} from './controller';
import type { PostLikeReceipt } from './post-like-contract';
import type { PendingPostLike } from './post-like-pending';
import type { CommunityRuntime } from './runtime';

export interface PostLikeMutationView extends CommunityView {
  readonly frozen: boolean;
  readonly recoveryPostId: string;
  readonly actionLabel: string;
  readonly receiptStatus: string;
}
export const initialPostLikeMutationView = (): PostLikeMutationView => ({
  ...initialCommunityView(),
  frozen: false,
  recoveryPostId: '',
  actionLabel: '',
  receiptStatus: '',
});
export class PostLikeMutationController extends CommunityController<PostLikeMutationView> {
  private pending: PendingPostLike | null = null;
  constructor(
    runtime: CommunityRuntime,
    render: (view: PostLikeMutationView) => void,
    private readonly onSettled: () => void = () => undefined,
  ) {
    super(runtime, initialPostLikeMutationView, render);
  }
  protected override resetPrivate(): void {
    this.pending = null;
  }
  /** Restoring the journal needs no post visibility, profile, publication or review permission. */
  load(): void {
    this.stop();
    this.update({ busy: false, error: '' });
    if (!this.available()) return;
    try {
      const pending = this.runtime.pendingPostLikes.load(this.accountId()!);
      if (pending) this.show(pending);
      else {
        this.pending = null;
        this.update({ frozen: false, recoveryPostId: '', actionLabel: '' });
      }
    } catch (error) {
      this.update({
        frozen: true,
        error: communityError(error),
        status: '无法读取原点赞请求，禁止发送新请求',
      });
    }
  }
  private show(pending: PendingPostLike): void {
    this.pending = pending;
    this.update({
      frozen: true,
      recoveryPostId: pending.postId,
      actionLabel: pending.liked ? '点赞帖子' : '取消点赞',
      status: '原点赞请求结果待确认，请查询或重试完全相同的意图',
    });
  }
  async setLiked(post: Post, liked: boolean): Promise<void> {
    if (
      this.view.busy ||
      this.view.frozen ||
      !this.available() ||
      typeof liked !== 'boolean' ||
      post.viewer.isLiked === liked
    )
      return;
    const accountId = this.accountId()!,
      owner = this.runtime.sessions.snapshot();
    try {
      const old = this.runtime.pendingPostLikes.load(accountId);
      if (old) {
        this.show(old);
        return;
      }
    } catch (error) {
      this.update({ frozen: true, error: communityError(error) });
      return;
    }
    const postId = post.id;
    let persistenceStarted = false;
    await this.run(
      async (cancel) => {
        const requestId = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Cancelled before persistence');
        persistenceStarted = true;
        const pending = this.runtime.pendingPostLikes.freeze({
          version: 1,
          accountId,
          requestId,
          operation: 'set_post_like',
          postId,
          liked,
        });
        this.show(pending);
        // Rendering or storage adapters may synchronously invalidate login ownership.
        this.runtime.sessions.assertCurrent(owner);
        return this.dispatch(pending, cancel);
      },
      (receipt) => this.settle(receipt),
      () =>
        this.update({
          frozen: this.view.frozen || persistenceStarted,
          status: '点赞结果未知，请保留原请求并查询回执',
        }),
    );
  }
  private dispatch(
    attempt: PendingPostLike,
    cancel: Cancellation,
  ): Promise<PostLikeReceipt> {
    const owner = this.runtime.sessions.snapshot();
    this.runtime.sessions.assertCurrent(this.owner);
    if (cancel.isCancelled)
      throw new ClientError('cancelled', 'Cancelled before dispatch');
    if (attempt.accountId !== this.accountId())
      throw new ClientError('stale-session', 'Account changed');
    if (
      JSON.stringify(this.runtime.pendingPostLikes.load(attempt.accountId)) !==
      JSON.stringify(attempt)
    )
      throw new ClientError('storage', 'Pending intent changed');
    this.runtime.sessions.assertCurrent(owner);
    if (cancel.isCancelled)
      throw new ClientError('cancelled', 'Cancelled before dispatch');
    return this.runtime.gateway!.like(
      {
        requestId: attempt.requestId,
        operation: attempt.operation,
        postId: attempt.postId,
        liked: attempt.liked,
      },
      cancel,
    );
  }
  async recover(retry = false): Promise<void> {
    if (this.view.busy || !this.available()) return;
    const owner = this.runtime.sessions.snapshot();
    try {
      const pending = this.runtime.pendingPostLikes.load(this.accountId()!);
      if (!pending) {
        this.update({ error: '未找到原点赞记录，请重新打开页面' });
        return;
      }
      this.show(pending);
      this.runtime.sessions.assertCurrent(owner);
      await this.run(
        (cancel) =>
          retry
            ? this.dispatch(pending, cancel)
            : this.runtime.gateway!.postLikeReceipt(pending.requestId, cancel),
        (receipt) => this.settle(receipt),
        () => this.update({ frozen: true, status: '原点赞请求仍待确认' }),
      );
    } catch (error) {
      this.update({ frozen: true, error: communityError(error) });
    }
  }
  private settle(receipt: PostLikeReceipt): void {
    if (!this.pending || this.pending.accountId !== this.accountId())
      throw new ClientError('protocol', 'Missing original post-like intent');
    const settled = this.runtime.pendingPostLikes.settle(this.pending, receipt);
    this.pending = null;
    this.update({
      frozen: false,
      recoveryPostId: '',
      actionLabel: '',
      error: '',
      status: '原点赞请求已确认',
      receiptStatus:
        settled.outcome === 'applied'
          ? '原请求已确认，正在重新读取当前状态'
          : reasonMessage(settled.code),
    });
    // Never project the receipt's historical liked bit onto live detail/counts.
    this.onSettled();
  }
}
