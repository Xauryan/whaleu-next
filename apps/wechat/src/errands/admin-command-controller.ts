import { ClientError, clientError } from '../api/errors';
import {
  CommunityController,
  communityError,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { Cancellation } from '../platform/contracts';
import {
  coversErrandAdminTarget,
  decodeErrandAdminAuthority,
  sameErrandAdminAuthority,
  type ErrandAdminAuthority,
} from './admin-authority';
import {
  decodeErrandAdminOrder,
  type ErrandAdminOrder,
} from './admin-contract';
import {
  decodeErrandAdminIntent,
  errandAdminOperationLabels,
  errandRestrictionAction,
  errandRestrictionDurations,
  type ErrandAdminIntent,
  type ErrandAdminOperation,
  type ErrandAdminReceipt,
  type ErrandRestrictionAction,
} from './admin-command-contract';
import type { PendingErrandAdmin } from './admin-pending';
import type { ErrandAdminRuntime } from './admin-runtime';
import {
  decodeErrandRestriction,
  type ErrandRestriction,
} from './restriction-contract';
import { invalidErrand } from './contract';
export interface ErrandAdminModal {
  readonly operation: ErrandAdminOperation;
  readonly orderId: string;
  readonly restrictionId: string;
  readonly title: string;
  readonly participantLabel: string;
  readonly regionId: string | null;
  readonly targetProfileId: string;
  readonly action: ErrandRestrictionAction;
}
export interface ErrandAdminCommandView extends CommunityView {
  readonly frozen: boolean;
  readonly modal: ErrandAdminModal | null;
  readonly reason: string;
  readonly durationIndex: number;
  readonly publisherRestriction: boolean;
  readonly targetProfileId: string;
  readonly action: ErrandRestrictionAction;
  readonly recoveryOperation: string;
  readonly recoveryTarget: string;
  readonly receiptStatus: string;
}
export const initialErrandAdminCommandView = (): ErrandAdminCommandView => ({
  ...initialCommunityView(),
  frozen: false,
  modal: null,
  reason: '',
  durationIndex: -1,
  publisherRestriction: false,
  targetProfileId: '',
  action: 'all',
  recoveryOperation: '',
  recoveryTarget: '',
  receiptStatus: '',
});
export function errandAdminCommandError(error: unknown): string {
  const code = clientError(error).details.serverCode;
  return (
    (
      {
        ERRAND_ADMIN_SCOPE_CHANGED:
          '管理角色或范围已变化，请重新核验；原请求仍保留',
        ERRAND_REVISION_CONFLICT: '订单已变化，请刷新并重新确认',
        ERRAND_STATE_CONFLICT: '订单状态不再允许此操作，请刷新',
        ERRAND_USE_OWNER_COMMAND: '自己的订单请进入订单详情，按发布者流程操作',
        ERRAND_RESTRICTION_TARGET_PROTECTED:
          '此账号当前受管理员身份保护，不能新增跑腿限制',
        ERRAND_RESTRICTION_TARGET_NOT_FOUND: '找不到此公开资料，请核对编号',
        ERRAND_RESTRICTION_NOT_FOUND: '此限制记录不存在或当前不可查看',
        ERRAND_RESTRICTION_NOT_ACTIVE: '此项限制已结束；其他限制可能仍然生效',
        REQUEST_NOT_FOUND:
          '暂未查到原回执，原操作仍可能完成；请继续查询或重试原请求',
        AUTHORIZATION_UNAVAILABLE:
          '当前管理权限暂不能确认；原请求保留，请稍后重新核验',
        FORBIDDEN: '当前没有管理此目标的权限，原请求保留',
      } as Record<string, string>
    )[code ?? ''] ?? communityError(error)
  );
}
function changed(): never {
  throw new ClientError('forbidden', 'Administrative scope changed', {
    serverCode: 'ERRAND_ADMIN_SCOPE_CHANGED',
  });
}
/** Modal state is transient. A frozen command survives dismissal and is settled only by its current authorized owner. */
export class ErrandAdminCommandController extends CommunityController<ErrandAdminCommandView> {
  private inactive = false;
  private sequence = 0;
  private pending: PendingErrandAdmin | null = null;
  private authority: ErrandAdminAuthority | null = null;
  private order: ErrandAdminOrder | null = null;
  private readonly unsubscribeScope: () => void;
  private readonly unsubscribeBrowse: () => void;
  constructor(
    private readonly adminRuntime: ErrandAdminRuntime,
    render: (view: ErrandAdminCommandView) => void,
    private readonly onSettled: (receipt: ErrandAdminReceipt) => void = () =>
      undefined,
    private readonly onAuthorityLost: () => void = () => undefined,
  ) {
    super(adminRuntime, initialErrandAdminCommandView, render);
    const invalidate = (accountId?: string) => {
      if (accountId !== undefined && accountId !== this.accountId()) return;
      this.invalidateContext('管理范围已变化，请重新核验；原请求仍保留');
    };
    this.unsubscribeScope =
      adminRuntime.directoryScopeChanges?.subscribe(invalidate) ??
      (() => undefined);
    this.unsubscribeBrowse =
      adminRuntime.browsingScopeChanges?.subscribe(invalidate) ??
      (() => undefined);
    this.update({
      configured:
        !!adminRuntime.errandAdminCommands && !!adminRuntime.pendingErrandAdmin,
    });
  }
  protected override resetPrivate(): void {
    this.sequence++;
    this.pending = null;
    this.authority = null;
    this.order = null;
  }
  protected override onSafetyInvalidated(): void {
    this.update({ status: '安全状态已变化，请重新核验；原管理请求仍保留' });
  }
  protected override available(): boolean {
    if (this.inactive) return false;
    if (
      !this.accountId() ||
      !this.adminRuntime.errandAdminCommands ||
      !this.adminRuntime.pendingErrandAdmin
    ) {
      this.update({
        configured:
          !!this.adminRuntime.errandAdminCommands &&
          !!this.adminRuntime.pendingErrandAdmin,
        error: !this.accountId()
          ? '请先登录后核验管理权限'
          : '管理操作服务尚未配置',
      });
      return false;
    }
    return true;
  }
  load(): void {
    if (!this.available()) return;
    try {
      this.pending = this.adminRuntime.pendingErrandAdmin!.load(
        this.accountId()!,
      );
      if (this.pending) this.showPending(this.pending);
    } catch (error) {
      this.update({
        frozen: true,
        error: errandAdminCommandError(error),
        status: '原管理请求无法读取，禁止发送新请求',
      });
    }
  }
  private showPending(attempt: PendingErrandAdmin): void {
    this.pending = attempt;
    this.update({
      frozen: true,
      modal: null,
      reason: '',
      publisherRestriction: false,
      targetProfileId: '',
      durationIndex: -1,
      recoveryOperation: errandAdminOperationLabels[attempt.intent.operation],
      recoveryTarget: attempt.authority.regionId
        ? `原订单目标地区：${attempt.authority.regionId}`
        : '原全局管理请求',
      status: '原管理操作结果待确认。恢复会重新核验当前账号对原目标的管理权限',
    });
  }
  private canOpen(authority: ErrandAdminAuthority): boolean {
    if (this.view.busy || this.view.frozen || !this.available()) return false;
    this.load();
    if (this.view.frozen) return false;
    this.authority = decodeErrandAdminAuthority(authority);
    this.sequence++;
    return true;
  }
  openOrder(
    raw: ErrandAdminOrder,
    authority: ErrandAdminAuthority,
    operation: 'admin_delete' | 'restrict_accepter',
  ): void {
    if (!this.canOpen(authority)) return;
    const order = decodeErrandAdminOrder(raw);
    if (
      order.targetRegion.id !== authority.regionId ||
      order.deletedAt !== null ||
      (operation === 'admin_delete' && order.relation === 'publisher') ||
      (operation === 'restrict_accepter' &&
        (!order.accepter || !['accepted', 'completed'].includes(order.state)))
    )
      return;
    this.order = order;
    const participant =
      operation === 'admin_delete' ? order.publisher : order.accepter!;
    this.update({
      modal: {
        operation,
        orderId: order.id,
        restrictionId: '',
        title: order.title,
        participantLabel:
          participant.status === 'available'
            ? participant.displayName
            : '公开资料暂不可用',
        regionId: order.targetRegion.id,
        targetProfileId:
          participant.status === 'available' ? participant.profileId : '',
        action: 'all',
      },
      reason: '',
      publisherRestriction: false,
      durationIndex: operation === 'restrict_accepter' ? 5 : -1,
      targetProfileId: '',
      action: 'all',
      error: '',
      receiptStatus: '',
    });
  }
  openIssue(authority: ErrandAdminAuthority): void {
    if (
      authority.regionId !== null ||
      authority.role === 'school_admin' ||
      !this.canOpen(authority)
    )
      return;
    this.order = null;
    this.update({
      modal: {
        operation: 'issue',
        orderId: '',
        restrictionId: '',
        title: '全局签发跑腿限制',
        participantLabel: '',
        regionId: null,
        targetProfileId: '',
        action: 'all',
      },
      reason: '',
      publisherRestriction: false,
      durationIndex: -1,
      targetProfileId: '',
      action: 'all',
      error: '',
      receiptStatus: '',
    });
  }
  openRelease(raw: ErrandRestriction, authority: ErrandAdminAuthority): void {
    if (
      authority.regionId !== null ||
      authority.role === 'school_admin' ||
      !this.canOpen(authority)
    )
      return;
    const restriction = decodeErrandRestriction(raw);
    if (restriction.state !== 'active') return;
    this.order = null;
    this.update({
      modal: {
        operation: 'release',
        orderId: '',
        restrictionId: restriction.restrictionId,
        title: '仅解除此项限制',
        participantLabel:
          restriction.subject.status === 'available'
            ? restriction.subject.displayName
            : '公开资料暂不可用',
        regionId: null,
        targetProfileId:
          restriction.subject.status === 'available'
            ? restriction.subject.profileId
            : '',
        action: restriction.action,
      },
      reason: '',
      publisherRestriction: false,
      durationIndex: -1,
      targetProfileId: '',
      action: restriction.action,
      error: '',
      receiptStatus: '',
    });
  }
  setReason(reason: string): void {
    if (this.view.modal && !this.view.busy && !this.view.frozen)
      this.update({ reason });
  }
  setTargetProfileId(targetProfileId: string): void {
    if (
      this.view.modal?.operation === 'issue' &&
      !this.view.busy &&
      !this.view.frozen
    )
      this.update({ targetProfileId });
  }
  setAction(action: string): void {
    if (
      this.view.modal?.operation !== 'issue' ||
      this.view.busy ||
      this.view.frozen
    )
      return;
    try {
      this.update({ action: errandRestrictionAction(action) });
    } catch {
      /* Ignore invalid native event values. */
    }
  }
  setDuration(value: string): void {
    if (
      !this.view.modal ||
      this.view.busy ||
      this.view.frozen ||
      !/^(0|[1-9][0-9]*)$/.test(value)
    )
      return;
    const index = Number(value);
    if (index < errandRestrictionDurations.length)
      this.update({ durationIndex: index });
  }
  setPublisherRestriction(checked: boolean): void {
    if (
      this.view.modal?.operation === 'admin_delete' &&
      !this.view.busy &&
      !this.view.frozen &&
      checked !== this.view.publisherRestriction
    )
      this.update({ publisherRestriction: checked, durationIndex: -1 });
  }
  togglePublisherRestriction(): void {
    this.setPublisherRestriction(!this.view.publisherRestriction);
  }

  private intent(requestId: string): ErrandAdminIntent {
    const modal = this.view.modal;
    if (!modal) invalidErrand();
    const duration =
      errandRestrictionDurations[this.view.durationIndex]?.duration;
    if (modal.operation === 'admin_delete')
      return decodeErrandAdminIntent({
        operation: 'admin_delete',
        orderId: modal.orderId,
        payload: {
          clientRequestId: requestId,
          expectedRevision: this.order?.revision,
          deleteReason: this.view.reason,
          publisherRestriction: this.view.publisherRestriction
            ? duration
            : null,
        },
      });
    if (modal.operation === 'restrict_accepter')
      return decodeErrandAdminIntent({
        operation: 'restrict_accepter',
        orderId: modal.orderId,
        payload: {
          clientRequestId: requestId,
          expectedRevision: this.order?.revision,
          reason: this.view.reason,
          duration,
        },
      });
    if (modal.operation === 'issue')
      return decodeErrandAdminIntent({
        operation: 'issue',
        payload: {
          clientRequestId: requestId,
          targetProfileId: this.view.targetProfileId.trim(),
          action: this.view.action,
          reason: this.view.reason,
          duration,
        },
      });
    return decodeErrandAdminIntent({
      operation: 'release',
      restrictionId: modal.restrictionId,
      payload: { clientRequestId: requestId, reason: this.view.reason },
    });
  }
  private assertActive(cancel: Cancellation, sequence: number): void {
    if (
      this.inactive ||
      cancel.isCancelled ||
      sequence !== this.sequence ||
      !this.accountId()
    )
      throw new ClientError(
        'cancelled',
        'Administrative confirmation replaced',
      );
  }
  async confirm(): Promise<void> {
    if (
      !this.view.modal ||
      !this.authority ||
      this.view.busy ||
      this.view.frozen ||
      !this.available()
    )
      return;
    let intent: ErrandAdminIntent;
    try {
      intent = this.intent('00000000-0000-4000-8000-000000000000');
    } catch {
      this.update({
        error:
          '请核对目标，选择期限或永久限制，并填写原因（限制及解除1–255字；仅删除最多500字）',
      });
      return;
    }
    const authority = this.authority,
      sequence = this.sequence,
      accountId = this.accountId()!;
    await this.run(
      async (cancel) => {
        const auth =
          await this.adminRuntime.errandAdminCommands!.authorization(cancel);
        this.assertActive(cancel, sequence);
        if (!sameErrandAdminAuthority(authority, auth)) changed();
        const clientRequestId = await this.runtime.newRequestId();
        this.assertActive(cancel, sequence);
        const attempt = this.adminRuntime.pendingErrandAdmin!.freeze({
          version: 1,
          kind: 'errand_admin',
          accountId,
          authority,
          intent: decodeErrandAdminIntent({
            ...intent,
            payload: { ...intent.payload, clientRequestId },
          }),
        });
        this.assertActive(cancel, sequence);
        this.showPending(attempt);
        return this.adminRuntime.errandAdminCommands!.command(
          attempt.intent,
          cancel,
        );
      },
      (receipt) => this.settle(receipt),
      (error) => this.failed(error),
    );
  }
  async recover(replay = false): Promise<void> {
    if (this.view.busy || !this.available()) return;
    this.load();
    const attempt = this.pending;
    if (!attempt) return;
    const sequence = this.sequence;
    await this.run(
      async (cancel) => {
        const auth =
          await this.adminRuntime.errandAdminCommands!.authorization(cancel);
        this.assertActive(cancel, sequence);
        if (!coversErrandAdminTarget(auth, attempt.authority.regionId))
          changed();
        this.adminRuntime.pendingErrandAdmin!.assertOriginal(attempt);
        // Explicit replay always carries the same original payload and key. No historical participant checks are repeated here.
        return replay
          ? this.adminRuntime.errandAdminCommands!.command(
              attempt.intent,
              cancel,
            )
          : this.adminRuntime.errandAdminCommands!.receipt(
              attempt.intent,
              cancel,
            );
      },
      (receipt) => this.settle(receipt),
      (error) => this.failed(error),
    );
  }
  private settle(receipt: ErrandAdminReceipt): void {
    if (!this.pending) invalidErrand();
    const result = this.adminRuntime.pendingErrandAdmin!.settle(
      this.pending,
      receipt,
    );
    this.pending = null;
    this.authority = null;
    this.order = null;
    this.update({
      ...initialErrandAdminCommandView(),
      configured: true,
      hasSession: !!this.accountId(),
      receiptStatus:
        result.outcome === 'applied'
          ? '原管理请求已确认完成'
          : errandAdminCommandError(
              new ClientError('business', 'Rejected command', {
                serverCode: result.code,
              }),
            ),
      status: '回执已确认，请以重新核验的数据为准',
    });
    this.onSettled(result);
  }
  private failed(error: ClientError): void {
    const authorityFailure =
      [
        'forbidden',
        'auth-required',
        'auth-expired',
        'protocol',
        'phone-verification-required',
      ].includes(error.kind) ||
      [
        'AUTHORIZATION_UNAVAILABLE',
        'AUTHORIZATION_REQUIRED',
        'ERRAND_ADMIN_SCOPE_CHANGED',
        'MANAGEMENT_SCOPE_REQUIRED',
        'ERRAND_SCOPE_UNAVAILABLE',
        'VERIFICATION_UNAVAILABLE',
        'PHONE_VERIFICATION_REQUIRED',
        'SAFETY_UNAVAILABLE',
        'ACCOUNT_BLOCKED',
      ].includes(error.details.serverCode ?? '');
    this.authority = null;
    this.order = null;
    this.update({
      modal: null,
      reason: '',
      targetProfileId: '',
      durationIndex: -1,
      publisherRestriction: false,
      frozen: !!this.pending || error.kind === 'storage',
      error: errandAdminCommandError(error),
      status: this.pending
        ? '结果尚未确认，原请求仍保留。不会创建替代请求'
        : '本次操作未发送或未确认，请重新核验',
    });
    if (authorityFailure) this.onAuthorityLost();
  }
  invalidateContext(status = '已关闭管理确认；已发送的原请求仍可能完成'): void {
    this.sequence++;
    this.stop();
    this.authority = null;
    this.order = null;
    this.update({
      ...initialErrandAdminCommandView(),
      configured:
        !!this.adminRuntime.errandAdminCommands &&
        !!this.adminRuntime.pendingErrandAdmin,
      hasSession: !!this.accountId(),
      status,
    });
    this.load();
  }
  dismiss(): void {
    this.invalidateContext();
  }
  override cancel(): void {
    this.invalidateContext('已停止等待；原管理请求保留，稍后请核验回执');
  }
  override dispose(): void {
    this.inactive = true;
    this.sequence++;
    this.unsubscribeScope();
    this.unsubscribeBrowse();
    super.dispose();
  }
}
