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
  decodeProfileModerationCommand,
  decodeProfileModerationManagement,
  decodeProfileModerationRecovery,
  decodeProfileModerationTarget,
  sameProfileModerationTarget,
} from './contract';
import type {
  ProfileModerationManagement,
  ProfileModerationTarget,
  ProfileModerationReceipt,
} from './contract';
import type { PendingProfileModeration } from './pending';
import type { ProfileModerationGateway } from './gateway';
import type { PendingProfileModerationStore } from './pending';
export interface ProfileModerationView extends CommunityView {
  /** True only while an exact-target management read is available. */
  readonly loaded: boolean;
  readonly target: ProfileModerationTarget | null;
  readonly management: ProfileModerationManagement | null;
  readonly frozen: boolean;
  readonly confirming: 'reset' | 'cancel' | null;
  readonly pendingTarget: ProfileModerationTarget | null;
  readonly pendingRequestId: string;
  readonly recovering: boolean;
  readonly pendingPhase: 'submit' | 'cancel' | '';
  readonly receiptStatus: string;
}
export const initialProfileModerationView = (): ProfileModerationView => ({
  ...initialCommunityView(),
  loaded: false,
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
export class ProfileModerationController extends CommunityController<ProfileModerationView> {
  private pending: PendingProfileModeration | null = null;
  private receiptRead: object | null = null;
  private readonly gateway: ProfileModerationGateway | undefined;
  private readonly store: PendingProfileModerationStore | undefined;
  constructor(
    runtime: CommunityRuntime,
    render: (view: ProfileModerationView) => void,
    private readonly onSettled: () => void = () => undefined,
  ) {
    super(runtime, initialProfileModerationView, render);
    this.gateway = runtime.profileModeration;
    this.store = runtime.pendingProfileModeration;
  }
  protected override resetPrivate(): void {
    this.pending = null;
    this.receiptRead = null;
  }
  protected override onSafetyInvalidated(
    previous: ProfileModerationView,
  ): void {
    this.update({
      target: previous.target,
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
    void this.load(previous.target ?? undefined);
  }
  private assertEnvironment(): void {
    if (
      !this.gateway ||
      !this.store ||
      this.runtime.profileModeration !== this.gateway ||
      this.runtime.pendingProfileModeration !== this.store
    ) {
      throw new ClientError(
        'configuration',
        'Profile moderation environment changed',
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
          'Original profile moderation journal disappeared',
        );
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
  async load(raw?: ProfileModerationTarget): Promise<void> {
    if (this.view.busy || !this.available()) return;
    if (!this.gateway || !this.store) {
      this.update({
        error: '当前构建尚未配置昵称管理 API 环境',
        configured: false,
      });
      return;
    }
    let target: ProfileModerationTarget | null = null;
    try {
      target = raw === undefined ? null : decodeProfileModerationTarget(raw);
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
    this.update({ target, loaded: false, management: null, confirming: null });
    // Recovery does not depend on the target still being readable or manageable.
    if (!this.restore() || !target || this.pending) return;
    await this.run(
      (cancel) => {
        this.assertEnvironment();
        return this.gateway!.management(target, cancel);
      },
      (raw) => {
        this.assertEnvironment();
        const management = decodeProfileModerationManagement(raw);
        if (!sameProfileModerationTarget(management.target, target))
          throw new ClientError(
            'protocol',
            'Profile moderation target mismatch',
          );
        this.update({
          loaded: true,
          management,
          status: management.canReset
            ? '已核验此内容的昵称管理权限'
            : '关联校区同步内容暂不支持昵称管理',
        });
      },
      () => this.update({ loaded: false, management: null }),
    );
  }
  async request(target: ProfileModerationTarget): Promise<void> {
    if (this.view.busy || !this.available() || !this.restore() || this.pending)
      return;
    await this.load(target);
    const management = this.view.management;
    if (
      this.view.busy ||
      !this.available() ||
      !this.restore() ||
      this.pending ||
      !management?.canReset ||
      !sameProfileModerationTarget(management.target, target)
    )
      return;
    this.update({ confirming: 'reset' });
  }
  closeConfirmation(): void {
    if (!this.view.busy) this.update({ confirming: null });
  }
  async submit(): Promise<void> {
    if (
      this.view.busy ||
      !this.available() ||
      this.view.confirming !== 'reset' ||
      !this.restore() ||
      this.pending ||
      !this.view.management?.canReset
    )
      return;
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
        const command = decodeProfileModerationCommand({
          clientRequestId,
          target: management.target,
          action: 'reset_nickname',
          expectedProfileRevision: management.revision,
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
  private showPending(pending: PendingProfileModeration): void {
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
    pending: PendingProfileModeration,
    cancel: Cancellation,
  ): Promise<ProfileModerationReceipt> {
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
  private finish(raw: ProfileModerationReceipt): void {
    this.assertEnvironment();
    if (!this.pending || this.pending.accountId !== this.accountId())
      throw new ClientError('protocol', 'Original actor unavailable');
    const receipt = this.store!.settle(this.pending, raw),
      account = this.accountId()!;
    this.pending = null;
    this.update({
      frozen: false,
      pendingTarget: null,
      pendingRequestId: '',
      pendingPhase: '',
      confirming: null,
      loaded: false,
      management: null,
      receiptStatus:
        receipt.outcome === 'applied'
          ? '已确认公开昵称重置，对方会收到私有系统通知。返回内容页可查看最新昵称'
          : receipt.code === 'PROFILE_MODERATION_STALE'
            ? '资料版本已变化，原请求未覆盖新状态，请重新加载并确认'
            : '原昵称重置请求已取消',
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
          const result = decodeProfileModerationRecovery(
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
            'Profile moderation receipt not settled',
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
