import { ClientError } from '../api/errors';
import type { Cancellation } from '../platform/contracts';
import {
  CommunityController,
  communityError,
  initialCommunityView,
  reasonMessage,
  type CommunityView,
} from './controller';
import type {
  DiscussionOperation,
  DiscussionReceipt,
} from './discussion-contract';
import type { PendingDiscussion } from './discussion-pending';
import type { CommunityRuntime } from './runtime';
export interface DiscussionMutationView extends CommunityView {
  readonly frozen: boolean;
  readonly recoveryPostId: string;
  readonly recoveryRootCommentId: string;
  readonly recoveryReplyId: string;
  readonly actionLabel: string;
  readonly receiptStatus: string;
}
export const initialDiscussionMutationView = (): DiscussionMutationView => ({
  ...initialCommunityView(),
  frozen: false,
  recoveryPostId: '',
  recoveryRootCommentId: '',
  recoveryReplyId: '',
  actionLabel: '',
  receiptStatus: '',
});
export class DiscussionMutationController extends CommunityController<DiscussionMutationView> {
  private pending: PendingDiscussion | null = null;
  constructor(
    runtime: CommunityRuntime,
    render: (view: DiscussionMutationView) => void,
    private readonly onSettled: () => void = () => undefined,
  ) {
    super(runtime, initialDiscussionMutationView, render);
  }
  protected override resetPrivate(): void {
    this.pending = null;
  }
  load(): void {
    if (!this.available()) return;
    try {
      const pending = this.runtime.pendingDiscussion.load(this.accountId()!);
      if (pending) this.show(pending);
    } catch (error) {
      this.update({
        frozen: true,
        error: communityError(error),
        status: '无法读取原互动记录，禁止新建互动',
      });
    }
  }
  private show(pending: PendingDiscussion): void {
    this.pending = pending;
    this.update({
      frozen: true,
      recoveryPostId: pending.postId,
      recoveryRootCommentId: pending.rootCommentId,
      recoveryReplyId:
        pending.operation === 'set_reply_like' ? pending.targetId : '',
      actionLabel:
        pending.operation === 'set_comment_pin'
          ? pending.desired
            ? '置顶评论'
            : '取消置顶'
          : pending.desired
            ? '点赞'
            : '取消点赞',
      status: '原互动结果待确认，仅可查询或重试原意图',
    });
  }
  async apply(
    operation: DiscussionOperation,
    postId: string,
    rootCommentId: string,
    targetId: string,
    desired: boolean,
  ): Promise<void> {
    if (this.view.busy || this.view.frozen || !this.available()) return;
    const accountId = this.accountId()!,
      owner = this.runtime.sessions.snapshot();
    try {
      const old = this.runtime.pendingDiscussion.load(accountId);
      if (old) {
        this.show(old);
        return;
      }
    } catch (error) {
      this.update({ frozen: true, error: communityError(error) });
      return;
    }
    await this.run(
      async (cancel) => {
        const clientRequestId = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Cancelled before persistence');
        const pending = this.runtime.pendingDiscussion.freeze({
          version: 1,
          accountId,
          operation,
          postId,
          rootCommentId,
          targetId,
          desired,
          clientRequestId,
        });
        this.show(pending);
        return this.dispatch(pending, cancel);
      },
      (receipt) => this.settle(receipt),
      () => this.update({ status: '互动结果未知，请保留原请求' }),
    );
  }
  private dispatch(
    attempt: PendingDiscussion,
    cancel: Cancellation,
  ): Promise<DiscussionReceipt> {
    if (attempt.accountId !== this.accountId())
      throw new ClientError('stale-session', 'Account changed');
    if (
      JSON.stringify(this.runtime.pendingDiscussion.load(attempt.accountId)) !==
      JSON.stringify(attempt)
    )
      throw new ClientError('storage', 'Pending intent changed');
    return attempt.operation === 'set_comment_pin'
      ? this.runtime.gateway!.pinComment(
          attempt.postId,
          attempt.targetId,
          attempt.desired,
          attempt.clientRequestId,
          cancel,
        )
      : this.runtime.gateway!.discussionLike(
          attempt.operation === 'set_reply_like' ? 'reply' : 'comment',
          attempt.targetId,
          attempt.desired,
          attempt.clientRequestId,
          cancel,
        );
  }
  async recover(retry = false): Promise<void> {
    if (this.view.busy || !this.available()) return;
    try {
      const pending = this.runtime.pendingDiscussion.load(this.accountId()!);
      if (!pending) {
        this.update({ error: '未找到原互动记录，请重新打开页面' });
        return;
      }
      this.show(pending);
      await this.run(
        (cancel) =>
          retry
            ? this.dispatch(pending, cancel)
            : this.runtime.gateway!.discussionReceipt(
                pending.clientRequestId,
                cancel,
              ),
        (receipt) => this.settle(receipt),
        () => this.update({ frozen: true, status: '原互动仍待确认' }),
      );
    } catch (error) {
      this.update({ frozen: true, error: communityError(error) });
    }
  }
  private settle(receipt: DiscussionReceipt): void {
    if (!this.pending || this.pending.accountId !== this.accountId())
      throw new ClientError('protocol', 'Missing original interaction');
    const settled = this.runtime.pendingDiscussion.settle(
      this.pending,
      receipt,
    );
    this.pending = null;
    this.update({
      frozen: false,
      recoveryPostId: '',
      recoveryRootCommentId: '',
      recoveryReplyId: '',
      receiptStatus:
        settled.outcome === 'applied'
          ? '原互动已确认，正在重新读取当前状态'
          : reasonMessage(settled.code),
      status: '原互动已确认',
      error: '',
    });
    this.onSettled();
  }
}
