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
  isTradingResolution,
  type TradingContacts,
  type TradingReceipt,
  type TradingResolution,
} from './trading-contract';
import type { PendingTrading } from './trading-pending';
import type { CommunityRuntime } from './runtime';
export interface TradingMutationView extends CommunityView {
  readonly frozen: boolean;
  readonly recoveryPostId: string;
  readonly actionLabel: string;
  readonly receiptStatus: string;
}
export const initialTradingMutationView = (): TradingMutationView => ({
  ...initialCommunityView(),
  frozen: false,
  recoveryPostId: '',
  actionLabel: '',
  receiptStatus: '',
});
export class TradingMutationController extends CommunityController<TradingMutationView> {
  private pending: PendingTrading | null = null;
  constructor(
    runtime: CommunityRuntime,
    render: (view: TradingMutationView) => void,
    private readonly onSettled: () => void = () => undefined,
  ) {
    super(runtime, initialTradingMutationView, render);
  }
  protected override resetPrivate(): void {
    this.pending = null;
  }
  load(): void {
    if (!this.available()) return;
    try {
      const pending = this.runtime.pendingTrading.load(this.accountId()!);
      if (pending) this.show(pending);
    } catch (error) {
      this.update({
        frozen: true,
        error: communityError(error),
        status: '无法读取原交易状态请求，禁止新建请求',
      });
    }
  }
  private show(pending: PendingTrading): void {
    this.pending = pending;
    this.update({
      frozen: true,
      recoveryPostId: pending.postId,
      actionLabel:
        pending.resolution === 'resolved' ? '标记售出／已解决' : '恢复未解决',
      status: '原交易状态结果待确认，仅可查询或重试原意图',
    });
  }
  async apply(post: Post, resolution: TradingResolution): Promise<void> {
    if (
      this.view.busy ||
      this.view.frozen ||
      !this.available() ||
      !isTradingResolution(resolution) ||
      !post.trading?.viewer.canSetResolution ||
      !post.viewer.isSelf ||
      post.trading.resolution === resolution
    )
      return;
    const accountId = this.accountId()!,
      owner = this.runtime.sessions.snapshot();
    try {
      const old = this.runtime.pendingTrading.load(accountId);
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
        const pending = this.runtime.pendingTrading.freeze({
          version: 1,
          accountId,
          postId: post.id,
          resolution,
          clientRequestId,
        });
        this.show(pending);
        return this.dispatch(pending, cancel);
      },
      (receipt) => this.settle(receipt),
      () => this.update({ status: '交易状态结果未知，请保留原请求' }),
    );
  }
  private dispatch(
    attempt: PendingTrading,
    cancel: Cancellation,
  ): Promise<TradingReceipt> {
    if (attempt.accountId !== this.accountId())
      throw new ClientError('stale-session', 'Account changed');
    if (
      JSON.stringify(this.runtime.pendingTrading.load(attempt.accountId)) !==
      JSON.stringify(attempt)
    )
      throw new ClientError('storage', 'Pending intent changed');
    return this.runtime.gateway!.setTradingResolution(
      attempt.postId,
      attempt.resolution,
      attempt.clientRequestId,
      cancel,
    );
  }
  async recover(retry = false): Promise<void> {
    if (this.view.busy || !this.available()) return;
    try {
      const pending = this.runtime.pendingTrading.load(this.accountId()!);
      if (!pending) {
        this.update({ error: '未找到原交易状态记录，请重新打开页面' });
        return;
      }
      this.show(pending);
      await this.run(
        (cancel) =>
          retry
            ? this.dispatch(pending, cancel)
            : this.runtime.gateway!.tradingReceipt(
                pending.clientRequestId,
                cancel,
              ),
        (receipt) => this.settle(receipt),
        () => this.update({ frozen: true, status: '原交易状态仍待确认' }),
      );
    } catch (error) {
      this.update({ frozen: true, error: communityError(error) });
    }
  }
  private settle(receipt: TradingReceipt): void {
    if (!this.pending || this.pending.accountId !== this.accountId())
      throw new ClientError('protocol', 'Missing original trading mutation');
    const settled = this.runtime.pendingTrading.settle(this.pending, receipt);
    this.pending = null;
    this.update({
      frozen: false,
      recoveryPostId: '',
      receiptStatus:
        settled.outcome === 'applied'
          ? '原交易状态请求已确认，正在重新读取当前状态'
          : reasonMessage(settled.code),
      status: '原交易状态请求已确认',
      error: '',
    });
    // Immutable receipts are historical acknowledgments, never current listing state.
    this.onSettled();
  }
}
export interface TradingContactsView extends CommunityView {
  readonly enabled: boolean;
  readonly contacts: TradingContacts | null;
}
export const initialTradingContactsView = (): TradingContactsView => ({
  ...initialCommunityView(),
  enabled: false,
  contacts: null,
});
/** Contact values only come from a fresh authorized endpoint; never from profiles, feed, or stored preferences. */
export class TradingContactsController extends CommunityController<TradingContactsView> {
  private postId: string | null = null;
  constructor(
    runtime: CommunityRuntime,
    render: (view: TradingContactsView) => void,
    private readonly copyText: (text: string) => Promise<void>,
  ) {
    super(runtime, initialTradingContactsView, render);
  }
  protected override resetPrivate(): void {
    this.postId = null;
  }
  load(post: Post | null): void {
    this.stop();
    this.postId = post?.trading ? post.id : null;
    this.update({
      contacts: null,
      enabled: !!this.postId,
      busy: false,
      error: '',
      status: '联系方式由发布者自愿公开，点击后重新检查查看权限',
    });
  }
  async reveal(): Promise<void> {
    await this.read();
  }
  async copy(field: string): Promise<void> {
    if (field !== 'wechat' && field !== 'qq' && field !== 'phone') return;
    await this.read(field);
  }
  private async read(field?: keyof TradingContacts): Promise<void> {
    if (!this.postId || this.view.busy || !this.available()) return;
    const postId = this.postId,
      owner = this.runtime.sessions.snapshot();
    this.update({ contacts: null });
    await this.run(
      async (cancel) => {
        const result = await this.runtime.gateway!.tradingContacts(
          postId,
          cancel,
        );
        this.runtime.sessions.assertCurrent(owner);
        if (
          cancel.isCancelled ||
          this.postId !== postId ||
          result.postId !== postId
        )
          throw new ClientError('cancelled', 'Contact request was replaced');
        if (field) {
          const text = result.contacts[field];
          if (!text)
            throw new ClientError('protocol', 'Contact no longer available');
          await this.copyText(text);
        }
        return result;
      },
      (result) =>
        this.update({
          contacts: result.contacts,
          status: field
            ? '已复制发布者公开填写的联系方式'
            : '发布者自愿公开的联系方式，不代表已认证',
        }),
      () => this.update({ contacts: null }),
    );
  }
  override cancel(): void {
    super.cancel();
    this.update({ contacts: null });
  }
}
