import { decodeRemovalPunishmentSelection } from './punishment';
import type { RemovalPunishmentSelection } from './punishment';
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
  decodeAdminPostRemovalCommand,
  decodeAdminPostRemovalManagement,
  decodeAdminPostRemovalRecovery,
  decodeAdminPostRemovalReceipt,
  matchAdminPostRemovalReceipt,
  decodeAdminPostRemovalTarget,
  sameAdminPostRemovalTarget,
} from './contract';
import type {
  AdminPostRemovalManagement,
  AdminPostRemovalTarget,
  AdminPostRemovalReceipt,
} from './contract';
import type { PendingAdminPostRemoval } from './pending';
import type { AdminPostRemovalGateway } from './gateway';
import type { PendingAdminPostRemovalStore } from './pending';
export interface AdminPostRemovalView extends CommunityView {
  /** True only while an exact-target management read is available. */
  readonly loaded: boolean;
  readonly selectedPunishment: RemovalPunishmentSelection | null;
  readonly ownPost: boolean;
  readonly applied: boolean;
  readonly target: AdminPostRemovalTarget | null;
  readonly management: AdminPostRemovalManagement | null;
  readonly frozen: boolean;
  readonly confirming: 'remove' | 'cancel' | null;
  readonly pendingTarget: AdminPostRemovalTarget | null;
  readonly pendingRequestId: string;
  readonly recovering: boolean;
  readonly pendingPhase: 'submit' | 'cancel' | '';
  readonly receiptStatus: string;
}
export const initialAdminPostRemovalView = (): AdminPostRemovalView => ({
  ...initialCommunityView(),
  selectedPunishment: null,
  loaded: false,
  ownPost: false,
  applied: false,
  target: null,
  management: null,
  frozen: false,
  confirming: null,
  pendingTarget: null,
  pendingRequestId: '',
  recovering: false,
  pendingPhase: '',
  receiptStatus: '',
});
/** Recovery is actor/request-owned; it does not depend on a readable post DTO. */
export class AdminPostRemovalController extends CommunityController<AdminPostRemovalView> {
  private pending: PendingAdminPostRemoval | null = null;
  private receiptRead: object | null = null;
  private readonly gateway: AdminPostRemovalGateway | undefined;
  private readonly store: PendingAdminPostRemovalStore | undefined;
  constructor(
    runtime: CommunityRuntime,
    render: (view: AdminPostRemovalView) => void,
    private readonly onSettled: () => void = () => undefined,
  ) {
    super(runtime, initialAdminPostRemovalView, render);
    this.gateway = runtime.adminPostRemoval;
    this.store = runtime.pendingAdminPostRemoval;
  }
  protected override resetPrivate(): void {
    // Same-owner content invalidation must not discard the unresolved intent
    // anchor: otherwise missing or replaced storage could release its key.
    // Network callbacks remain isolated by the base session/generation owner.
    if (this.pending?.accountId !== this.accountId()) this.pending = null;
    this.receiptRead = null;
  }
  override dispose(): void {
    super.dispose();
    this.pending = null;
  }
  protected override onSafetyInvalidated(previous: AdminPostRemovalView): void {
    this.update({
      target: previous.target,
      receiptStatus: previous.receiptStatus,
      applied: previous.applied,
    });
    // Our own invalidation must not reinterpret an applied deletion as a failed
    // management read of the now-unavailable source.
    if (previous.applied) {
      if (previous.frozen) this.restore();
      return;
    }
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
    void this.load(previous.target ?? undefined);
  }
  private assertEnvironment(): void {
    if (
      !this.gateway ||
      !this.store ||
      this.runtime.adminPostRemoval !== this.gateway ||
      this.runtime.pendingAdminPostRemoval !== this.store
    ) {
      throw new ClientError(
        'configuration',
        'Admin post removal environment changed',
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
          'Original admin post removal journal disappeared',
        );
      if (this.pending) this.store!.assertOriginal(this.pending);
      this.pending = restored;
      this.update({
        frozen: !!this.pending,
        pendingTarget: this.pending?.command.target ?? null,
        pendingRequestId: this.pending?.command.clientRequestId ?? '',
        pendingPhase: this.pending?.phase ?? '',
      });
      return true;
    } catch (error) {
      this.update({ frozen: true, error: communityError(error) });
      return false;
    }
  }
  async load(raw?: AdminPostRemovalTarget): Promise<void> {
    if (this.view.busy || !this.available()) return;
    if (!this.gateway || !this.store) {
      this.update({
        error: '当前构建尚未配置帖子管理 API 环境',
        configured: false,
      });
      return;
    }
    let target: AdminPostRemovalTarget | null = null;
    try {
      target = raw === undefined ? null : decodeAdminPostRemovalTarget(raw);
    } catch (error) {
      this.update({
        target: null,
        loaded: false,
        management: null,
        confirming: null,
        error: communityError(error),
      });
      this.restore();
      return;
    }
    this.update({
      target,
      loaded: false,
      management: null,
      confirming: null,
      ownPost: false,
      applied: false,
    });
    // Recovery does not depend on the target still being readable or manageable.
    if (!this.restore() || !target || this.pending) return;
    await this.run(
      (cancel) => {
        this.assertEnvironment();
        return this.gateway!.management(target, cancel);
      },
      (raw) => {
        this.assertEnvironment();
        const management = decodeAdminPostRemovalManagement(raw);
        if (!sameAdminPostRemovalTarget(management.target, target))
          throw new ClientError(
            'protocol',
            'Admin post removal target mismatch',
          );
        this.update({
          loaded: true,
          management,
          status: '已核验此帖原发布地区的管理员删除权限',
        });
      },
      (error) =>
        this.update({
          loaded: false,
          management: null,
          ownPost: error.details.serverCode === 'ADMIN_POST_REMOVAL_OWN_POST',
        }),
    );
  }
  async request(target: AdminPostRemovalTarget): Promise<void> {
    if (this.view.busy || !this.available() || !this.restore() || this.pending)
      return;
    await this.load(target);
    const management = this.view.management;
    if (
      this.view.busy ||
      !this.available() ||
      !this.restore() ||
      this.pending ||
      !management?.canRemove ||
      !sameAdminPostRemovalTarget(management.target, target)
    )
      return;
    this.update({ confirming: 'remove', selectedPunishment: null });
  }
  closeConfirmation(): void {
    if (!this.view.busy)
      this.update({ confirming: null, selectedPunishment: null });
  }
  selectPunishment(raw: unknown | null): boolean {
    if (this.view.busy || this.view.frozen || this.view.confirming !== 'remove')
      return false;
    try {
      if (raw === null) {
        this.update({ selectedPunishment: null });
        return true;
      }
      const selected = decodeRemovalPunishmentSelection(raw, true);
      if (
        !this.view.management?.punishmentOptions ||
        selected.expectedRevision !==
          this.view.management.punishmentOptions[selected.kind].revision
      )
        throw new ClientError(
          'protocol',
          'Current punishment revision required',
        );
      this.update({ selectedPunishment: selected, error: '' });
      return true;
    } catch (error) {
      this.update({ error: communityError(error) });
      return false;
    }
  }
  async submit(): Promise<void> {
    if (
      this.view.busy ||
      !this.available() ||
      this.view.confirming !== 'remove' ||
      !this.restore() ||
      this.pending ||
      !this.view.management?.canRemove
    )
      return;
    const selection = this.view.selectedPunishment;
    const management = this.view.management,
      account = this.accountId()!,
      owner = this.owner;
    await this.run(
      async (cancel) => {
        const clientRequestId = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        this.assertEnvironment();
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Cancelled before persistence');
        const command = decodeAdminPostRemovalCommand({
          clientRequestId,
          ...(selection ? { version: 2, punishment: selection } : {}),
          target: management.target,
          action: 'remove_post',
          expectedTargetVersion: management.targetVersion,
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
  private showPending(pending: PendingAdminPostRemoval): void {
    this.update({
      frozen: true,
      loaded: false,
      confirming: null,
      pendingTarget: pending.command.target,
      pendingRequestId: pending.command.clientRequestId,
      pendingPhase: pending.phase,
      receiptStatus: '',
      management: null,
    });
  }
  private dispatch(
    pending: PendingAdminPostRemoval,
    cancel: Cancellation,
  ): Promise<AdminPostRemovalReceipt> {
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
  private finish(raw: AdminPostRemovalReceipt): void {
    this.assertEnvironment();
    if (!this.pending || this.pending.accountId !== this.accountId())
      throw new ClientError('protocol', 'Original actor unavailable');
    const receipt = decodeAdminPostRemovalReceipt(raw),
      account = this.accountId()!;
    matchAdminPostRemovalReceipt(this.pending.command, receipt);
    try {
      this.store!.settle(this.pending, receipt);
    } catch (error) {
      // A matching applied receipt already proves this content is unavailable.
      // Failed local cleanup must keep recovery blocked, not retain old readers.
      if (receipt.outcome === 'applied') {
        // Mark the known terminal outcome before synchronous invalidation so a
        // failed recovery settle cannot recursively resume its own receipt GET.
        this.update({
          frozen: true,
          loaded: false,
          management: null,
          confirming: null,
          error: communityError(error),
          applied: true,
          receiptStatus:
            '已确认帖子删除；本机回执清理失败，请保留数据并继续查询原回执',
        });
        this.runtime.safetyChanges?.invalidate(account);
        this.onSettled();
        this.update({ error: communityError(error) });
      }
      throw error;
    }
    this.pending = null;
    this.update({
      frozen: false,
      pendingTarget: null,
      pendingRequestId: '',
      pendingPhase: '',
      confirming: null,
      loaded: false,
      management: null,
      applied: receipt.outcome === 'applied',
      receiptStatus:
        receipt.outcome === 'applied' && receipt.version === 2
          ? `已确认删除及${receipt.punishment?.kind === 'access_suspension' ? '封号' : '禁言'}；作者已收到私有删除通知和处罚通知`
          : receipt.outcome === 'applied'
            ? '已确认删除帖子；帖子和讨论现已不可访问，作者已收到私有系统通知。没有恢复此帖的管理入口'
            : receipt.code === 'ADMIN_POST_REMOVAL_STALE'
              ? '帖子状态已变化，原请求未删除新状态，请重新加载并确认'
              : '原管理员删除请求已取消；已经删除的帖子不会恢复',
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
          const result = decodeAdminPostRemovalRecovery(
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
          throw new ClientError(
            'http',
            'Admin post removal receipt not settled',
            {
              httpStatus: 404,
              serverCode: 'REQUEST_NOT_FOUND',
            },
          );
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
