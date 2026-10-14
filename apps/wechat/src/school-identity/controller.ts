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
import { isUuid, type Campus } from '../profile/contract';
import {
  decodeSchoolIdentityManagement,
  decodeSchoolIdentityCommand,
  decodeSchoolIdentityReceipt,
  decodeSchoolIdentityRecovery,
  matchSchoolIdentityReceipt,
  type SchoolIdentityAction,
  type SchoolIdentityManagement,
  type SchoolIdentityReceipt,
} from './contract';
import type { SchoolIdentityGateway } from './gateway';
import type {
  PendingSchoolIdentity,
  PendingSchoolIdentityStore,
} from './pending';
export interface SchoolIdentityView extends CommunityView {
  readonly loaded: boolean;
  readonly capabilityKnown: boolean;
  readonly canManage: boolean;
  readonly targetProfileId: string;
  readonly management: SchoolIdentityManagement | null;
  readonly campusQuery: string;
  readonly campuses: readonly Campus[];
  readonly campusPage: number;
  readonly campusTotal: number;
  readonly frozen: boolean;
  readonly confirming: SchoolIdentityAction | 'cancel' | null;
  readonly pendingTargetProfileId: string;
  readonly pendingAction: SchoolIdentityAction | '';
  readonly pendingRequestId: string;
  readonly pendingPhase: 'submit' | 'cancel' | '';
  readonly recovering: boolean;
  readonly receiptStatus: string;
}
export const initialSchoolIdentityView = (): SchoolIdentityView => ({
  ...initialCommunityView(),
  loaded: false,
  capabilityKnown: false,
  canManage: false,
  targetProfileId: '',
  management: null,
  campusQuery: '',
  campuses: [],
  campusPage: 1,
  campusTotal: 0,
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
export class SchoolIdentityController extends CommunityController<SchoolIdentityView> {
  private pending: PendingSchoolIdentity | null = null;
  private receiptRead: object | null = null;
  private readonly gateway: SchoolIdentityGateway | undefined;
  private readonly store: PendingSchoolIdentityStore | undefined;
  constructor(
    runtime: CommunityRuntime,
    render: (view: SchoolIdentityView) => void,
    private readonly onSettled: () => void = () => undefined,
  ) {
    super(runtime, initialSchoolIdentityView, render);
    this.gateway = runtime.schoolIdentity;
    this.store = runtime.pendingSchoolIdentity;
  }
  protected override resetPrivate(): void {
    if (this.pending?.accountId !== this.accountId()) this.pending = null;
    this.receiptRead = null;
  }
  override dispose(): void {
    super.dispose();
    this.pending = null;
  }
  protected override onSafetyInvalidated(previous: SchoolIdentityView): void {
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
      this.runtime.schoolIdentity !== this.gateway ||
      this.runtime.pendingSchoolIdentity !== this.store
    )
      throw new ClientError(
        'configuration',
        'School identity environment changed',
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
          'Original school identity journal disappeared',
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
      campuses: [],
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
      campuses: [],
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
          capability.schoolIdentityManagement && targetProfileId
            ? decodeSchoolIdentityManagement(
                await this.gateway!.management(targetProfileId, cancel),
              )
            : null;
        if (management && management.target.profileId !== targetProfileId)
          throw new ClientError('protocol', 'School identity target mismatch');
        return { canManage: capability.schoolIdentityManagement, management };
      },
      ({ canManage, management }) => {
        this.assertEnvironment();
        this.update({
          capabilityKnown: true,
          canManage,
          loaded: !!management,
          management,
          campuses: [],
          status: !canManage
            ? '当前账号没有学校归属管理权限；仍可恢复原请求'
            : !management
              ? '输入已知公开主页 ID 后核验'
              : '已核验当前学校与 UID；请明确选择操作和目标校区',
        });
      },
    );
  }
  setCampusQuery(value: string): void {
    if (this.view.busy || this.view.frozen) return;
    this.update({
      campusQuery: value,
      management: this.view.management
        ? { ...this.view.management, destination: null }
        : null,
      campuses: [],
      campusPage: 1,
      campusTotal: 0,
      confirming: null,
    });
  }
  async searchCampuses(page = 1): Promise<void> {
    if (
      this.view.busy ||
      !this.available() ||
      !this.restore() ||
      this.pending ||
      !this.view.canManage ||
      !this.runtime.profiles
    )
      return;
    const q = this.view.campusQuery.trim();
    await this.run(
      (cancel) =>
        this.runtime.profiles!.campuses(
          { q, district: '', page, pageSize: 20 },
          cancel,
        ),
      (result) =>
        this.update({
          campuses: result.items.filter(
            (item) => item.isActive && item.institutionId !== null,
          ),
          campusPage: result.page,
          campusTotal: result.total,
          confirming: null,
        }),
    );
  }
  async selectCampus(campusId: string): Promise<void> {
    if (
      this.view.busy ||
      !this.available() ||
      !this.restore() ||
      this.pending ||
      !this.view.management ||
      !this.view.campuses.some((item) => item.id === campusId)
    )
      return;
    const target = this.view.management.target.profileId;
    this.update({ management: null, loaded: false, confirming: null });
    await this.run(
      async (cancel) =>
        decodeSchoolIdentityManagement(
          await this.gateway!.management(target, cancel, campusId),
        ),
      (management) => {
        if (
          management.target.profileId !== target ||
          management.destination?.campusId !== campusId
        )
          throw new ClientError(
            'protocol',
            'School identity destination mismatch',
          );
        this.update({
          management,
          loaded: true,
          status:
            management.current.school?.code ===
            management.destination.school.code
              ? '所选校区属于同一学校；确认后不会变更学校或分配新 UID'
              : '已核验原学校和目标学校，请确认更正',
        });
      },
    );
  }
  request(action: SchoolIdentityAction): void {
    if (
      this.view.busy ||
      !this.available() ||
      !this.restore() ||
      this.pending ||
      !this.view.management
    )
      return;
    const management = this.view.management;
    if (
      action === 'correct_school'
        ? !management.actions.correctSchool || !management.destination
        : !management.actions.completeUid
    )
      return;
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
      !this.view.management ||
      (action === 'correct_school'
        ? !this.view.management.actions.correctSchool
        : !this.view.management.actions.completeUid)
    )
      return;
    const management = this.view.management,
      account = this.accountId()!,
      owner = this.owner;
    if (action === 'correct_school' && !management.destination) return;
    let settled = false;
    await this.run(
      async (cancel) => {
        const clientRequestId = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        this.assertEnvironment();
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Cancelled before persistence');
        const command = decodeSchoolIdentityCommand({
          version: 1,
          clientRequestId,
          targetProfileId: management.target.profileId,
          expectedStateVersion: management.stateVersion,
          action,
          ...(action === 'correct_school'
            ? {
                destinationCampusId: management.destination!.campusId,
                expectedDestinationVersion:
                  management.destination!.destinationVersion,
              }
            : {}),
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
  private showPending(pending: PendingSchoolIdentity): void {
    this.update({
      frozen: true,
      loaded: false,
      confirming: null,
      management: null,
      campuses: [],
      pendingTargetProfileId: pending.command.targetProfileId,
      pendingRequestId: pending.command.clientRequestId,
      pendingAction: pending.command.action,
      pendingPhase: pending.phase,
      receiptStatus: '',
    });
  }
  private dispatch(
    pending: PendingSchoolIdentity,
    cancel: Cancellation,
  ): Promise<SchoolIdentityReceipt> {
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
  private finish(raw: SchoolIdentityReceipt): void {
    this.assertEnvironment();
    if (!this.pending || this.pending.accountId !== this.accountId())
      throw new ClientError('protocol', 'Original actor unavailable');
    const receipt = decodeSchoolIdentityReceipt(raw);
    matchSchoolIdentityReceipt(this.pending.command, receipt);
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
          ? receipt.code === 'SCHOOL_IDENTITY_STALE'
            ? '状态已变化，原请求未执行；请重新核验并确认'
            : '原请求已取消；已经完成的操作不会回滚'
          : `${receipt.outcome === 'unchanged' ? (receipt.action === 'correct_school' ? '所选校区属于同一学校，未更正学校，也未重新分配 UID' : '当前校内 UID 无需补发') : receipt.action === 'correct_school' ? '学校归属已更正，新学校 UID 已分配；如有原 UID，其历史记录仍保留' : '校内 UID 已补发'}。此回执是历史结果，当前学校与 UID 以重新查询为准`,
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
          const result = decodeSchoolIdentityRecovery(
            await this.gateway!.receipt(
              pending.command.clientRequestId,
              cancel,
            ),
          );
          if (result.state === 'recorded') return result.receipt;
          if (retry) return this.dispatch(pending, cancel);
          throw new ClientError('http', 'School identity receipt not settled', {
            httpStatus: 404,
            serverCode: 'REQUEST_NOT_FOUND',
          });
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
