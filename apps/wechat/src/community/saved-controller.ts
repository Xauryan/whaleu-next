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
import {
  isUpdateChannel,
  type PostUpdatePreferences,
  type SavedIntent,
  type SavedReceipt,
  type UpdateChannel,
} from './saved-contract';
import type { PendingSaved } from './saved-pending';
import type { CommunityRuntime } from './runtime';
export interface SavedMutationView extends CommunityView {
  readonly frozen: boolean;
  readonly recoveryPostId: string;
  readonly actionLabel: string;
  readonly receiptStatus: string;
  readonly preferences: PostUpdatePreferences | null;
  readonly processingStatus: string;
}
export const initialSavedMutationView = (): SavedMutationView => ({
  ...initialCommunityView(),
  frozen: false,
  recoveryPostId: '',
  actionLabel: '',
  receiptStatus: '',
  preferences: null,
  processingStatus: '',
});
export class SavedMutationController extends CommunityController<SavedMutationView> {
  private pending: PendingSaved | null = null;
  private post: Post | null = null;
  constructor(
    runtime: CommunityRuntime,
    render: (view: SavedMutationView) => void,
    private readonly onSettled: () => void = () => undefined,
  ) {
    super(runtime, initialSavedMutationView, render);
  }
  protected override resetPrivate(): void {
    this.pending = null;
    this.post = null;
  }
  /** A new parent visibility decision clears preferences before it can expose or enable controls. */
  async load(post: Post | null = null): Promise<void> {
    this.stop();
    this.post = post;
    this.update({
      preferences: null,
      processingStatus: '',
      busy: false,
      error: '',
    });
    if (!this.available()) return;
    try {
      const pending = this.runtime.pendingSaved.load(this.accountId()!);
      if (pending) this.show(pending);
      else {
        this.pending = null;
        this.update({ frozen: false, recoveryPostId: '', actionLabel: '' });
      }
    } catch (error) {
      this.update({
        frozen: true,
        error: communityError(error),
        status: '无法读取原收藏设置请求，禁止发送新请求',
      });
      return;
    }
    if (!post) return;
    await this.run(
      (cancel) => this.runtime.gateway!.postUpdatePreferences(post.id, cancel),
      (preferences) => {
        if (preferences.postId !== this.post?.id)
          throw new ClientError('protocol', 'Preference target changed');
        const processingStatus =
          preferences.inAppCapability === 'unavailable' ||
          preferences.inAppProcessing === 'disabled'
            ? '当前未启用新站内更新生成；已存在的记录仍可查看'
            : preferences.inAppProcessing === 'manual_only'
              ? '当前仅手动处理本地事件，不会自动生成新站内更新'
              : '当前配置为自动处理本地新事件；列表仅显示已生成的记录';
        this.update({
          preferences,
          processingStatus,
          status: this.view.frozen
            ? '原收藏或设置结果待确认'
            : `已读取当前设置；${processingStatus}；外部通知尚不可用`,
        });
      },
      () => this.update({ preferences: null, processingStatus: '' }),
    );
  }
  private show(pending: PendingSaved): void {
    this.pending = pending;
    this.update({
      frozen: true,
      recoveryPostId: pending.postId,
      actionLabel:
        pending.operation === 'set_post_saved'
          ? pending.desired
            ? '收藏帖子'
            : '取消收藏'
          : `${pending.channel === 'saved' ? '收藏更新' : '外部通知'}偏好：${pending.desired ? '开启意向' : '关闭'}`,
      status: '原请求结果待确认，请查询或重试完全相同的意图',
    });
  }
  async setSaved(post: Post, desired: boolean): Promise<void> {
    if (!post.viewer.canSave || post.viewer.isSaved === desired) return;
    await this.apply({
      operation: 'set_post_saved',
      postId: post.id,
      desired,
      channel: null,
    });
  }
  async setPreference(channel: UpdateChannel, desired: boolean): Promise<void> {
    const preferences = this.view.preferences;
    if (
      !this.post ||
      !preferences ||
      !isUpdateChannel(channel) ||
      !preferences.canSetPreference ||
      !this.post.viewer.canSetUpdatePreference ||
      preferences[
        channel === 'saved' ? 'savedUpdatesEnabled' : 'externalUpdatesEnabled'
      ] === desired
    )
      return;
    await this.apply({
      operation: 'set_post_update_preference',
      postId: this.post.id,
      desired,
      channel,
    });
  }
  private async apply(
    intent: Omit<SavedIntent, 'clientRequestId'>,
  ): Promise<void> {
    if (
      this.view.busy ||
      this.view.frozen ||
      !this.available() ||
      typeof intent.desired !== 'boolean'
    )
      return;
    const accountId = this.accountId()!,
      owner = this.runtime.sessions.snapshot();
    try {
      const old = this.runtime.pendingSaved.load(accountId);
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
        const pending = this.runtime.pendingSaved.freeze({
          version: 1,
          accountId,
          clientRequestId,
          ...intent,
        });
        this.show(pending);
        return this.dispatch(pending, cancel);
      },
      (receipt) => this.settle(receipt),
      () => this.update({ status: '收藏或设置结果未知，请保留原请求' }),
    );
  }
  private dispatch(
    attempt: PendingSaved,
    cancel: Cancellation,
  ): Promise<SavedReceipt> {
    if (attempt.accountId !== this.accountId())
      throw new ClientError('stale-session', 'Account changed');
    if (
      JSON.stringify(this.runtime.pendingSaved.load(attempt.accountId)) !==
      JSON.stringify(attempt)
    )
      throw new ClientError('storage', 'Pending intent changed');
    return this.runtime.gateway!.applySaved(
      {
        clientRequestId: attempt.clientRequestId,
        operation: attempt.operation,
        postId: attempt.postId,
        desired: attempt.desired,
        channel: attempt.channel,
      },
      cancel,
    );
  }
  async recover(retry = false): Promise<void> {
    if (this.view.busy || !this.available()) return;
    try {
      const pending = this.runtime.pendingSaved.load(this.accountId()!);
      if (!pending) {
        this.update({ error: '未找到原收藏设置记录，请重新打开页面' });
        return;
      }
      this.show(pending);
      await this.run(
        (cancel) =>
          retry
            ? this.dispatch(pending, cancel)
            : this.runtime.gateway!.savedReceipt(
                pending.clientRequestId,
                cancel,
              ),
        (receipt) => this.settle(receipt),
        () => this.update({ frozen: true, status: '原收藏或设置请求仍待确认' }),
      );
    } catch (error) {
      this.update({ frozen: true, error: communityError(error) });
    }
  }
  private settle(receipt: SavedReceipt): void {
    if (!this.pending || this.pending.accountId !== this.accountId())
      throw new ClientError('protocol', 'Missing original saved intent');
    const settled = this.runtime.pendingSaved.settle(this.pending, receipt);
    this.pending = null;
    this.update({
      frozen: false,
      recoveryPostId: '',
      actionLabel: '',
      preferences: null,
      processingStatus: '',
      receiptStatus:
        settled.outcome === 'applied'
          ? '原请求已确认，正在重新读取当前状态'
          : reasonMessage(settled.code),
      status: '原请求已确认',
      error: '',
    });
    // A receipt acknowledges a historical intent; never apply its desired bit over current live state.
    this.onSettled();
  }
}
