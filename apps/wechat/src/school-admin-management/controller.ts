import { ClientError } from '../api/errors';
import {
  CommunityController,
  communityError,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import { decodeAuthorization } from '../identity-privacy/overlay';
import type { Cancellation } from '../platform/contracts';
import { isUuid } from '../profile/contract';
import {
  decodeSchoolAdminManagement,
  decodeSchoolAdminManagementCommand,
  decodeSchoolAdminManagementReceipt,
  decodeSchoolAdminManagementRecovery,
  matchSchoolAdminManagementReceipt,
  type SchoolAdminAction,
  type SchoolAdminManagement,
  type SchoolAdminManagementReceipt,
} from './contract';
import type { SchoolAdminManagementGateway } from './gateway';
import type {
  PendingSchoolAdminManagement,
  PendingSchoolAdminManagementStore,
} from './pending';
export interface SchoolAdminManagementView extends CommunityView {
  readonly loaded: boolean;
  readonly capabilityKnown: boolean;
  readonly canManage: boolean;
  readonly targetProfileId: string;
  readonly management: SchoolAdminManagement | null;
  readonly selectedRegionId: string;
  readonly selectedRegionName: string;
  readonly frozen: boolean;
  readonly confirming: SchoolAdminAction | 'cancel' | null;
  readonly pendingTargetProfileId: string;
  readonly pendingAction: SchoolAdminAction | '';
  readonly pendingRequestId: string;
  readonly pendingPhase: 'submit' | 'cancel' | '';
  readonly recovering: boolean;
  readonly receiptStatus: string;
}
export const initialSchoolAdminManagementView =
  (): SchoolAdminManagementView => ({
    ...initialCommunityView(),
    loaded: false,
    capabilityKnown: false,
    canManage: false,
    targetProfileId: '',
    management: null,
    selectedRegionId: '',
    selectedRegionName: '',
    frozen: false,
    confirming: null,
    pendingTargetProfileId: '',
    pendingAction: '',
    pendingRequestId: '',
    pendingPhase: '',
    recovering: false,
    receiptStatus: '',
  });
/** Active actor + original key own recovery. Current capability never gates it. */
export class SchoolAdminManagementController extends CommunityController<SchoolAdminManagementView> {
  private pending: PendingSchoolAdminManagement | null = null;
  private receiptRead: object | null = null;
  private readonly gateway: SchoolAdminManagementGateway | undefined;
  private readonly store: PendingSchoolAdminManagementStore | undefined;
  constructor(
    runtime: CommunityRuntime,
    render: (view: SchoolAdminManagementView) => void,
    private readonly onSettled: () => void = () => undefined,
  ) {
    super(runtime, initialSchoolAdminManagementView, render);
    this.gateway = runtime.schoolAdminManagement;
    this.store = runtime.pendingSchoolAdminManagement;
  }
  protected override resetPrivate(): void {
    if (this.pending?.accountId !== this.accountId()) this.pending = null;
    this.receiptRead = null;
  }
  override dispose(): void {
    super.dispose();
    this.pending = null;
  }
  protected override onSafetyInvalidated(
    previous: SchoolAdminManagementView,
  ): void {
    this.update({
      targetProfileId: previous.targetProfileId,
      receiptStatus: previous.receiptStatus,
    });
    if (!this.restore()) return;
    if (this.pending) {
      if (
        previous.recovering &&
        previous.pendingRequestId === this.pending.command.clientRequestId
      )
        void this.recover();
      return;
    }
    void this.load(previous.targetProfileId || undefined);
  }
  private assertEnvironment(): void {
    if (
      !this.gateway ||
      !this.store ||
      this.runtime.schoolAdminManagement !== this.gateway ||
      this.runtime.pendingSchoolAdminManagement !== this.store
    )
      throw new ClientError(
        'configuration',
        'School administrator management environment changed',
      );
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
          'Original school administrator management journal disappeared',
        );
      if (this.pending) this.store!.assertOriginal(this.pending);
      this.pending = restored;
      this.update({
        frozen: !!restored,
        pendingTargetProfileId: restored?.command.targetProfileId ?? '',
        pendingRequestId: restored?.command.clientRequestId ?? '',
        pendingAction: restored?.command.action ?? '',
        pendingPhase: restored?.phase ?? '',
      });
      return true;
    } catch (error) {
      this.update({
        frozen: true,
        loaded: false,
        management: null,
        confirming: null,
        error: communityError(error),
      });
      return false;
    }
  }
  setTarget(value: string): void {
    if (
      this.view.busy ||
      this.view.frozen ||
      !this.available() ||
      !this.restore() ||
      this.pending
    )
      return;
    this.stop();
    this.update({
      targetProfileId: value,
      loaded: false,
      management: null,
      selectedRegionId: '',
      selectedRegionName: '',
      confirming: null,
      error: '',
    });
  }
  async load(raw = this.view.targetProfileId): Promise<void> {
    if (this.view.busy || !this.available()) return;
    this.update({
      loaded: false,
      management: null,
      confirming: null,
      selectedRegionId: '',
      selectedRegionName: '',
    });
    // Even invalid navigation, absent target and lost super authority preserve recovery.
    if (!this.restore() || this.pending) return;
    const targetProfileId = raw.trim();
    if (targetProfileId && !isUuid(targetProfileId)) {
      this.update({ targetProfileId, error: '请输入有效的公开主页 ID' });
      return;
    }
    this.update({ targetProfileId });
    await this.run(
      async (cancel) => {
        this.assertEnvironment();
        const capability = decodeAuthorization(
          await this.gateway!.capabilities(cancel),
        );
        this.assertEnvironment();
        const management =
          capability.schoolAdminManagement && targetProfileId
            ? decodeSchoolAdminManagement(
                await this.gateway!.management(targetProfileId, cancel),
              )
            : null;
        if (management && management.target.profileId !== targetProfileId)
          throw new ClientError(
            'protocol',
            'School administrator management target mismatch',
          );
        return { canManage: capability.schoolAdminManagement, management };
      },
      ({ canManage, management }) => {
        this.assertEnvironment();
        this.update({
          capabilityKnown: true,
          canManage,
          loaded: !!management,
          management,
          // A default is only a hint. Even a singleton requires an explicit selection.
          selectedRegionId: '',
          selectedRegionName: '',
          status: !canManage
            ? '当前账号没有学校管理员任命权限；仍可恢复原请求'
            : !management
              ? '输入已知公开主页 ID 后核验'
              : '已核验当前管理状态；请明确选择操作和地区',
        });
      },
    );
  }
  selectRegion(regionId: string): void {
    if (
      this.view.busy ||
      !this.available() ||
      !this.restore() ||
      this.pending ||
      !this.view.management
    )
      return;
    const region = this.view.management.eligibility.regions.find(
      (item) => item.id === regionId,
    );
    if (!region) return;
    this.update({
      selectedRegionId: region.id,
      selectedRegionName: region.name,
      confirming: null,
      error: '',
    });
  }
  request(action: SchoolAdminAction): void {
    if (
      this.view.busy ||
      !this.available() ||
      !this.restore() ||
      this.pending ||
      !this.view.management?.actions[action]
    )
      return;
    if (
      action !== 'revoke' &&
      !this.view.management.eligibility.regions.some(
        (item) => item.id === this.view.selectedRegionId,
      )
    ) {
      this.update({ error: '请明确选择一个可管理地区' });
      return;
    }
    this.update({ confirming: action, error: '' });
  }
  closeConfirmation(): void {
    if (!this.view.busy) this.update({ confirming: null });
  }
  async submit(): Promise<void> {
    const action = this.view.confirming;
    if (
      this.view.busy ||
      !this.available() ||
      !action ||
      action === 'cancel' ||
      !this.restore() ||
      this.pending ||
      !this.view.management?.actions[action]
    )
      return;
    const management = this.view.management,
      regionId = this.view.selectedRegionId,
      account = this.accountId()!,
      owner = this.owner;
    if (
      action !== 'revoke' &&
      !management.eligibility.regions.some((item) => item.id === regionId)
    )
      return;
    let settled = false;
    await this.run(
      async (cancel) => {
        const clientRequestId = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        this.assertEnvironment();
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Cancelled before persistence');
        const command = decodeSchoolAdminManagementCommand({
          clientRequestId,
          targetProfileId: management.target.profileId,
          expectedStateVersion: management.stateVersion,
          action,
          ...(action === 'revoke' ? {} : { regionId }),
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
      (receipt) => {
        this.finish(receipt);
        settled = true;
      },
      () => this.restore(),
    );
    if (settled)
      await this.refreshAfterSettlement(owner, management.target.profileId);
  }
  private showPending(pending: PendingSchoolAdminManagement): void {
    this.update({
      frozen: true,
      loaded: false,
      confirming: null,
      management: null,
      selectedRegionId: '',
      selectedRegionName: '',
      pendingTargetProfileId: pending.command.targetProfileId,
      pendingRequestId: pending.command.clientRequestId,
      pendingAction: pending.command.action,
      pendingPhase: pending.phase,
      receiptStatus: '',
    });
  }
  private dispatch(
    pending: PendingSchoolAdminManagement,
    cancel: Cancellation,
  ): Promise<SchoolAdminManagementReceipt> {
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
  private finish(raw: SchoolAdminManagementReceipt): void {
    this.assertEnvironment();
    if (!this.pending || this.pending.accountId !== this.accountId())
      throw new ClientError('protocol', 'Original actor unavailable');
    const receipt = decodeSchoolAdminManagementReceipt(raw);
    matchSchoolAdminManagementReceipt(this.pending.command, receipt);
    try {
      this.store!.settle(this.pending, receipt);
    } catch (error) {
      this.update({
        frozen: true,
        loaded: false,
        management: null,
        confirming: null,
        receiptStatus:
          '已取得原请求终态；本机回执清理失败，请保留数据并继续查询原回执',
        error: communityError(error),
      });
      this.onSettled();
      throw error;
    }
    this.pending = null;
    this.update({
      frozen: false,
      loaded: false,
      management: null,
      confirming: null,
      pendingTargetProfileId: '',
      pendingRequestId: '',
      pendingAction: '',
      pendingPhase: '',
      receiptStatus:
        receipt.outcome === 'rejected'
          ? receipt.code === 'SCHOOL_ADMIN_MANAGEMENT_STALE'
            ? '状态已变化，原请求未执行；请重新核验并确认'
            : '原请求已取消；已经完成的操作不会回滚'
          : `${receipt.outcome === 'unchanged' ? '已确认原状态无需变更' : receipt.action === 'revoke' ? '已确认撤销学校管理权限' : receipt.action === 'reassign' ? '已确认改派管理地区' : '已确认任命学校管理员'}${receipt.titleGranted ? '；已获得可选管理员头衔，不会自动佩戴' : ''}。此回执是历史结果，当前权限以重新核验为准`,
    });
    this.onSettled();
  }
  private async refreshAfterSettlement(
    owner: typeof this.owner,
    targetProfileId: string,
  ): Promise<void> {
    try {
      this.runtime.sessions.assertCurrent(owner);
    } catch {
      return;
    }
    // Receipt success never becomes present authority. Fresh capability + target read.
    await this.load(targetProfileId);
  }
  async recover(retry = false): Promise<void> {
    if (this.view.busy || !this.available() || !this.restore() || !this.pending)
      return;
    const pending = this.pending,
      owner = this.owner,
      ticket = {};
    let settled = false;
    this.receiptRead = ticket;
    this.update({ recovering: true });
    try {
      await this.run(
        async (cancel) => {
          this.assertEnvironment();
          this.store!.assertOriginal(pending);
          const result = decodeSchoolAdminManagementRecovery(
            await this.gateway!.receipt(
              pending.command.clientRequestId,
              cancel,
            ),
          );
          if (result.state === 'recorded') return result.receipt;
          if (retry) return this.dispatch(pending, cancel);
          throw new ClientError(
            'http',
            'School administrator management receipt not settled',
            { httpStatus: 404, serverCode: 'REQUEST_NOT_FOUND' },
          );
        },
        (receipt) => {
          this.finish(receipt);
          settled = true;
        },
        () => this.restore(),
      );
    } finally {
      if (this.receiptRead === ticket) {
        this.receiptRead = null;
        this.update({ recovering: false });
      }
    }
    if (settled)
      await this.refreshAfterSettlement(owner, pending.command.targetProfileId);
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
    const pending = this.pending,
      owner = this.owner;
    let settled = false;
    await this.run(
      (cancel) => this.dispatch(pending, cancel),
      (receipt) => {
        this.finish(receipt);
        settled = true;
      },
      () => this.restore(),
    );
    if (settled)
      await this.refreshAfterSettlement(owner, pending.command.targetProfileId);
  }
}
