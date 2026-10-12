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
  decodeProfileAvatarModerationCommand,
  decodeProfileAvatarModerationManagement,
  decodeProfileAvatarModerationRecovery,
  decodeProfileAvatarModerationTarget,
  sameProfileAvatarModerationTarget,
} from './contract';
import type {
  ProfileAvatarModerationManagement,
  ProfileAvatarModerationTarget,
  ProfileAvatarModerationReceipt,
} from './contract';
import type { PendingProfileAvatarModeration } from './pending';
import type { ProfileAvatarModerationGateway } from './gateway';
import type { PendingProfileAvatarModerationStore } from './pending';
export interface ProfileAvatarModerationView extends CommunityView {
  /** True only while an exact-target management read is available. */
  readonly loaded: boolean;
  readonly target: ProfileAvatarModerationTarget | null;
  readonly management: ProfileAvatarModerationManagement | null;
  readonly frozen: boolean;
  readonly confirming: 'clear' | 'cancel' | null;
  readonly pendingTarget: ProfileAvatarModerationTarget | null;
  readonly pendingRequestId: string;
  readonly recovering: boolean;
  readonly pendingPhase: 'submit' | 'cancel' | '';
  readonly receiptStatus: string;
}
export const initialProfileAvatarModerationView =
  (): ProfileAvatarModerationView => ({
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
export class ProfileAvatarModerationController extends CommunityController<ProfileAvatarModerationView> {
  private pending: PendingProfileAvatarModeration | null = null;
  private receiptRead: object | null = null;
  private readonly gateway: ProfileAvatarModerationGateway | undefined;
  private readonly store: PendingProfileAvatarModerationStore | undefined;
  constructor(
    runtime: CommunityRuntime,
    render: (view: ProfileAvatarModerationView) => void,
    private readonly onSettled: () => void = () => undefined,
  ) {
    super(runtime, initialProfileAvatarModerationView, render);
    this.gateway = runtime.profileAvatarModeration;
    this.store = runtime.pendingProfileAvatarModeration;
  }
  protected override resetPrivate(): void {
    this.pending = null;
    this.receiptRead = null;
  }
  protected override onSafetyInvalidated(
    previous: ProfileAvatarModerationView,
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
      this.runtime.profileAvatarModeration !== this.gateway ||
      this.runtime.pendingProfileAvatarModeration !== this.store
    ) {
      throw new ClientError(
        'configuration',
        'Profile avatar moderation environment changed',
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
          'Original profile avatar moderation journal disappeared',
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
  async load(raw?: ProfileAvatarModerationTarget): Promise<void> {
    if (this.view.busy || !this.available()) return;
    if (!this.gateway || !this.store) {
      this.update({
        error: '当前构建尚未配置头像管理 API 环境',
        configured: false,
      });
      return;
    }
    let target: ProfileAvatarModerationTarget | null = null;
    try {
      target =
        raw === undefined ? null : decodeProfileAvatarModerationTarget(raw);
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
        const management = decodeProfileAvatarModerationManagement(raw);
        if (!sameProfileAvatarModerationTarget(management.target, target))
          throw new ClientError(
            'protocol',
            'Profile avatar moderation target mismatch',
          );
        this.update({
          loaded: true,
          management,
          status: management.canClearCustomAvatar
            ? '已核验此内容的头像管理权限'
            : '当前没有可清除的自定义头像；未选择头像或目录头像不适用此操作',
        });
      },
      () => this.update({ loaded: false, management: null }),
    );
  }
  async request(target: ProfileAvatarModerationTarget): Promise<void> {
    if (this.view.busy || !this.available() || !this.restore() || this.pending)
      return;
    await this.load(target);
    const management = this.view.management;
    if (
      this.view.busy ||
      !this.available() ||
      !this.restore() ||
      this.pending ||
      !management?.canClearCustomAvatar ||
      !management.expectedAppearanceId ||
      !sameProfileAvatarModerationTarget(management.target, target)
    )
      return;
    this.update({ confirming: 'clear' });
  }
  closeConfirmation(): void {
    if (!this.view.busy) this.update({ confirming: null });
  }
  async submit(): Promise<void> {
    if (
      this.view.busy ||
      !this.available() ||
      this.view.confirming !== 'clear' ||
      !this.restore() ||
      this.pending ||
      !this.view.management?.canClearCustomAvatar ||
      !this.view.management.expectedAppearanceId
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
        const command = decodeProfileAvatarModerationCommand({
          clientRequestId,
          target: management.target,
          action: 'clear_custom_avatar',
          expectedProfileRevision: management.revision,
          expectedAppearanceId: management.expectedAppearanceId,
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
  private showPending(pending: PendingProfileAvatarModeration): void {
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
    pending: PendingProfileAvatarModeration,
    cancel: Cancellation,
  ): Promise<ProfileAvatarModerationReceipt> {
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
  private finish(raw: ProfileAvatarModerationReceipt): void {
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
          ? '已确认清除当前自定义头像，清除后显示未选择头像，对方会收到私有系统通知。返回内容页可重新查看当前头像'
          : receipt.code === 'PROFILE_AVATAR_MODERATION_STALE'
            ? '资料版本已变化，原请求未覆盖新状态，请重新加载并确认'
            : receipt.code === 'PROFILE_AVATAR_MODERATION_NOT_APPLICABLE'
              ? '当前自定义头像已变化或不再适用，原请求未清除头像，请重新核验'
              : '原头像清除请求已取消',
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
          const result = decodeProfileAvatarModerationRecovery(
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
            'Profile avatar moderation receipt not settled',
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
