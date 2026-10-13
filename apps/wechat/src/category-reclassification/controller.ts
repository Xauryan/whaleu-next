import { ClientError } from '../api/errors';
import {
  CommunityController,
  communityError,
  initialCommunityView,
} from '../community/controller';
import type { CommunityView } from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import type { Cancellation } from '../platform/contracts';
import {
  decodeReclassificationCommand,
  decodeCategoryManagement,
  decodeReclassificationRecovery,
  isReclassificationCategory,
} from './contract';
import type {
  CategoryManagement,
  ReclassificationCategory,
  ReclassificationReceipt,
} from './contract';
import type { PendingCategoryReclassification } from './pending';
import type { CategoryReclassificationGateway } from './gateway';
import type { PendingCategoryReclassificationStore } from './pending';
export interface CategoryReclassificationView extends CommunityView {
  readonly postId: string;
  readonly management: CategoryManagement | null;
  readonly frozen: boolean;
  readonly confirming: 'change' | 'cancel' | null;
  readonly desired: ReclassificationCategory | null;
  readonly pendingPostId: string;
  readonly pendingRequestId: string;
  readonly recovering: boolean;
  readonly pendingTargetCategory: ReclassificationCategory | null;
  readonly pendingPhase: 'submit' | 'cancel' | '';
  readonly receiptStatus: string;
}
export const initialCategoryReclassificationView =
  (): CategoryReclassificationView => ({
    ...initialCommunityView(),
    postId: '',
    management: null,
    frozen: false,
    confirming: null,
    desired: null,
    pendingPostId: '',
    pendingRequestId: '',
    recovering: false,
    pendingTargetCategory: null,
    pendingPhase: '',
    receiptStatus: '',
  });
/** Recovery is actor/request-owned; it does not depend on a readable post DTO. */
export class CategoryReclassificationController extends CommunityController<CategoryReclassificationView> {
  private pending: PendingCategoryReclassification | null = null;
  private receiptRead: object | null = null;
  private readonly gateway: CategoryReclassificationGateway | undefined;
  private readonly store: PendingCategoryReclassificationStore | undefined;
  constructor(
    runtime: CommunityRuntime,
    render: (view: CategoryReclassificationView) => void,
    private readonly onSettled: () => void = () => undefined,
  ) {
    super(runtime, initialCategoryReclassificationView, render);
    this.gateway = runtime.categoryReclassification;
    this.store = runtime.pendingCategoryReclassification;
  }
  protected override resetPrivate(): void {
    this.pending = null;
    this.receiptRead = null;
  }
  protected override onSafetyInvalidated(
    previous: CategoryReclassificationView,
  ): void {
    this.update({
      postId: previous.postId,
      receiptStatus: previous.receiptStatus,
    });
    // A late report-progress visibility denial can invalidate a receipt GET.
    // Content invalidation must not strand an explicit original-key recovery.
    // Resume only that actor's exact durable receipt read, never its mutation,
    // cancellation or a new key; no readable post/management response is needed.
    if (
      previous.recovering &&
      previous.frozen &&
      this.restore() &&
      this.pending?.command.clientRequestId === previous.pendingRequestId
    ) {
      void this.recover();
      return;
    }
    void this.load(previous.postId || undefined);
  }
  private assertEnvironment(): void {
    if (
      !this.gateway ||
      !this.store ||
      this.runtime.categoryReclassification !== this.gateway ||
      this.runtime.pendingCategoryReclassification !== this.store
    ) {
      throw new ClientError(
        'configuration',
        'Category reclassification environment changed',
      );
    }
  }
  private restore(): boolean {
    const account = this.accountId();
    if (!account) return false;
    try {
      this.assertEnvironment();
      const restored = this.store!.load(account);
      if (this.pending && !restored)
        throw new ClientError(
          'storage',
          'Original category journal disappeared',
        );
      this.pending = restored;
      this.update({
        frozen: !!this.pending,
        pendingPostId: this.pending?.command.postId ?? '',
        pendingRequestId: this.pending?.command.clientRequestId ?? '',
        pendingTargetCategory: this.pending?.command.targetCategory ?? null,
        pendingPhase: this.pending?.phase ?? '',
      });
      return true;
    } catch (error) {
      this.update({ frozen: true, error: communityError(error) });
      return false;
    }
  }
  async load(postId?: string): Promise<void> {
    if (this.view.busy || !this.available() || !this.gateway || !this.store)
      return;
    this.update({
      postId: postId ?? '',
      management: null,
      confirming: null,
      desired: null,
    });
    // Recovery still works if this read fails, the post is hidden, or it has been deleted.
    if (!this.restore() || !postId || this.pending) return;
    await this.run(
      (cancel) => {
        this.assertEnvironment();
        return this.gateway!.management(postId, cancel);
      },
      (raw) => {
        this.assertEnvironment();
        const management = decodeCategoryManagement(raw);
        if (management.postId !== postId)
          throw new ClientError(
            'protocol',
            'Category reclassification target mismatch',
          );
        this.update({
          management,
          status:
            management.blocker === 'related_sync_unsupported'
              ? '关联校区同步内容暂不支持更改分类'
              : management.canChange
                ? ''
                : '此帖子当前不能更改分类',
        });
      },
      (error) => {
        this.update({ management: null });
        if (
          error.details.serverCode === 'POST_NOT_FOUND' &&
          error.details.httpStatus === 404 &&
          error.kind !== 'protocol'
        )
          this.update({ error: '' });
      },
    );
  }
  async request(postId: string, targetCategory: unknown): Promise<void> {
    if (
      !isReclassificationCategory(targetCategory) ||
      this.view.busy ||
      !this.available() ||
      !this.restore() ||
      this.pending
    )
      return;
    await this.load(postId);
    const management = this.view.management;
    if (
      this.view.busy ||
      !this.available() ||
      !this.restore() ||
      this.pending ||
      management?.postId !== postId ||
      !management.canChange ||
      !management.targets.includes(targetCategory)
    )
      return;
    this.update({ confirming: 'change', desired: targetCategory });
  }
  closeConfirmation(): void {
    if (!this.view.busy) this.update({ confirming: null, desired: null });
  }
  async submit(): Promise<void> {
    if (
      this.view.busy ||
      !this.available() ||
      this.view.confirming !== 'change' ||
      !this.restore() ||
      this.pending ||
      this.view.desired === null ||
      !this.view.management?.canChange ||
      !this.view.management.targets.includes(this.view.desired)
    )
      return;
    const management = this.view.management,
      targetCategory = this.view.desired,
      account = this.accountId()!,
      owner = this.owner;
    await this.run(
      async (cancel) => {
        const clientRequestId = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        this.assertEnvironment();
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Cancelled before persistence');
        const command = decodeReclassificationCommand({
          clientRequestId,
          postId: management.postId,
          targetCategory,
          expectedRevision: management.revision,
        });
        this.pending = this.store!.freeze({
          version: 1,
          accountId: account,
          origin: this.store!.origin,
          phase: 'submit',
          command,
        });
        this.showPending(this.pending);
        return this.dispatch(this.pending, cancel);
      },
      (receipt) => this.finish(receipt),
      () => this.restore(),
    );
  }
  private showPending(pending: PendingCategoryReclassification): void {
    this.update({
      frozen: true,
      confirming: null,
      desired: null,
      pendingPostId: pending.command.postId,
      pendingRequestId: pending.command.clientRequestId,
      pendingTargetCategory: pending.command.targetCategory,
      pendingPhase: pending.phase,
      receiptStatus: '',
    });
  }
  private dispatch(
    pending: PendingCategoryReclassification,
    cancel: Cancellation,
  ): Promise<ReclassificationReceipt> {
    this.assertEnvironment();
    this.runtime.sessions.assertCurrent(this.owner);
    if (pending.accountId !== this.accountId() || cancel.isCancelled)
      throw new ClientError('cancelled', 'Original actor unavailable');
    this.store!.assertOriginal(pending);
    return this.gateway!.submit(
      pending.command,
      cancel,
      pending.phase === 'cancel',
    );
  }
  private finish(raw: ReclassificationReceipt): void {
    this.assertEnvironment();
    if (!this.pending || this.pending.accountId !== this.accountId())
      throw new ClientError('protocol', 'Original actor unavailable');
    const receipt = this.store!.settle(this.pending, raw),
      account = this.accountId()!;
    this.pending = null;
    this.update({
      frozen: false,
      pendingPostId: '',
      pendingRequestId: '',
      pendingTargetCategory: null,
      pendingPhase: '',
      confirming: null,
      desired: null,
      management: null,
      receiptStatus:
        receipt.outcome === 'applied'
          ? '已确认分类变更，正在重新核验内容与列表'
          : receipt.outcome === 'unchanged'
            ? '已确认当前分类，无需变更'
            : receipt.code === 'POST_CATEGORY_STALE'
              ? '分类版本已变化，原请求未覆盖新状态，请重新加载'
              : receipt.code === 'POST_CATEGORY_CANCELLED'
                ? '原分类请求已取消'
                : '当前不能更改分类，请重新加载',
    });
    // Clear pooled media, identity overlays and list snapshots before fresh reads.
    this.runtime.safetyChanges?.invalidate(account);
    this.onSettled();
  }
  async recover(retry = false): Promise<void> {
    if (this.view.busy || !this.available() || !this.restore() || !this.pending)
      return;
    const pending = this.pending,
      ticket = {};
    this.receiptRead = ticket;
    this.update({ recovering: true });
    try {
      await this.run(
        async (cancel) => {
          this.assertEnvironment();
          this.store!.assertOriginal(pending);
          const result = decodeReclassificationRecovery(
            await this.gateway!.receipt(
              pending.command.clientRequestId,
              cancel,
            ),
          );
          // A snapshot of absence never permits a fresh key. An explicit retry
          // can only replay this durable exact command, including its cancel phase.
          if (result.state === 'recorded') return result.receipt;
          if (result.state === 'not_recorded' && retry)
            return this.dispatch(pending, cancel);
          throw new ClientError('http', 'Category receipt not settled', {
            httpStatus: result.state === 'not_recorded' ? 404 : 503,
            serverCode:
              result.state === 'not_recorded'
                ? 'REQUEST_NOT_FOUND'
                : 'POST_CATEGORY_UNAVAILABLE',
          });
        },
        (receipt) => this.finish(receipt),
        () => this.restore(),
      );
    } finally {
      if (this.receiptRead === ticket) {
        this.receiptRead = null;
        this.update({ recovering: false });
      }
    }
  }
  requestCancellation(): void {
    if (!this.view.busy && this.available() && this.restore() && this.pending)
      this.update({ confirming: 'cancel' });
  }
  async confirmCancellation(): Promise<void> {
    if (
      this.view.busy ||
      !this.available() ||
      this.view.confirming !== 'cancel' ||
      !this.restore() ||
      !this.pending
    )
      return;
    try {
      this.pending = this.store!.cancel(this.pending);
      this.showPending(this.pending);
    } catch (error) {
      this.update({ frozen: true, error: communityError(error) });
      return;
    }
    const pending = this.pending;
    await this.run(
      (cancel) => this.dispatch(pending, cancel),
      (receipt) => this.finish(receipt),
      () => this.restore(),
    );
  }
}
