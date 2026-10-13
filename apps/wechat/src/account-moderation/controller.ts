import { ClientError } from '../api/errors';
import {
  CommunityController,
  communityError,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import type { Cancellation } from '../platform/contracts';
import { isUuid } from '../profile/contract';
import {
  decodeCommand,
  decodeReceipt,
  decodeRecovery,
  matchReceipt,
  reference,
  type Command,
  type Decision,
  type Receipt,
  type PunishmentStatus,
  type PunishmentView,
  type PunishmentManagement,
  type AppealView,
  type AppealManagement,
} from './contract';
import type { ModerationGateway } from './gateway';
import type { PendingModeration, PendingModerationStore } from './pending';
export type Mode =
  'status' | 'appeal' | 'appeal-management' | 'punishment-management';
export interface ModerationView extends CommunityView {
  readonly mode: Mode;
  readonly loaded: boolean;
  readonly accountStatus: PunishmentStatus | null;
  readonly punishments: readonly PunishmentView[];
  readonly appeals: readonly AppealView[];
  readonly selectedPunishment: PunishmentView | PunishmentManagement | null;
  readonly selectedAppeal: AppealView | AppealManagement | null;
  readonly history: readonly PunishmentView[];
  readonly historyCursor: string | null;
  readonly nextCursor: string | null;
  readonly text: string;
  readonly reason: string;
  readonly confirming: Command['action'] | 'cancel' | null;
  readonly decision: Decision;
  readonly frozen: boolean;
  readonly pendingCommand: Command | null;
  readonly recordedReceipt: Receipt | null;
  readonly pendingRequestId: string;
  readonly pendingAction: string;
  readonly pendingPhase: string;
  readonly receiptStatus: string;
  readonly canRelease: boolean;
  readonly canDecide: boolean;
}
export const initialModerationView = (
  mode: Mode = 'status',
): ModerationView => ({
  ...initialCommunityView(),
  mode,
  loaded: false,
  accountStatus: null,
  punishments: [],
  appeals: [],
  selectedPunishment: null,
  selectedAppeal: null,
  history: [],
  historyCursor: null,
  nextCursor: null,
  text: '',
  reason: '',
  confirming: null,
  decision: 'upheld',
  frozen: false,
  pendingCommand: null,
  recordedReceipt: null,
  pendingRequestId: '',
  pendingAction: '',
  pendingPhase: '',
  receiptStatus: '',
  canRelease: false,
  canDecide: false,
});
/** One origin/account journal spans all four screens. Authority is read fresh; it never gates original recovery. */
export class ModerationController extends CommunityController<ModerationView> {
  private pending: PendingModeration | null = null;
  private readonly gateway: ModerationGateway | undefined;
  private readonly store: PendingModerationStore | undefined;
  private navigation: { punishmentId?: string; appealId?: string } = {};
  constructor(
    runtime: CommunityRuntime,
    render: (view: ModerationView) => void,
    private readonly mode: Mode,
  ) {
    super(runtime, () => initialModerationView(mode), render);
    this.gateway = runtime.accountModeration;
    this.store = runtime.pendingAccountModeration;
  }
  protected override resetPrivate() {
    this.pending = null;
  }
  protected override onSafetyInvalidated() {
    void this.load(this.navigation);
  }
  private assertEnvironment() {
    if (
      !this.gateway ||
      !this.store ||
      this.runtime.accountModeration !== this.gateway ||
      this.runtime.pendingAccountModeration !== this.store
    )
      throw new ClientError('configuration', 'Moderation environment changed');
  }
  private restore(): boolean {
    const account = this.accountId();
    if (!account) return false;
    try {
      this.assertEnvironment();
      if (this.pending) this.store!.assertOriginal(this.pending);
      this.pending = this.store!.load(account);
      this.update({
        frozen: !!this.pending,
        pendingCommand: this.pending?.command ?? null,
        pendingRequestId: this.pending?.command.clientRequestId ?? '',
        pendingAction: this.pending?.command.action ?? '',
        pendingPhase: this.pending?.phase ?? '',
      });
      return true;
    } catch (error) {
      this.update({
        frozen: true,
        pendingCommand: null,
        loaded: false,
        selectedPunishment: null,
        selectedAppeal: null,
        canRelease: false,
        canDecide: false,
        confirming: null,
        error: communityError(error),
      });
      return false;
    }
  }
  async load(navigation = this.navigation): Promise<void> {
    if (this.view.busy || !this.available()) return;
    this.navigation = { ...navigation };
    this.update({
      loaded: false,
      accountStatus: null,
      text: '',
      reason: '',
      selectedPunishment: null,
      selectedAppeal: null,
      canRelease: false,
      canDecide: false,
      confirming: null,
      punishments: [],
      appeals: [],
      history: [],
      historyCursor: null,
      nextCursor: null,
    });
    if (!this.restore() || (this.pending && this.mode !== 'status')) return;
    if (
      (navigation.punishmentId && !isUuid(navigation.punishmentId)) ||
      (navigation.appealId && !isUuid(navigation.appealId))
    ) {
      this.update({ error: '地址无效；仍可恢复本账号原请求' });
      return;
    }
    await this.run(
      async (cancel) => {
        this.assertEnvironment();
        if (this.mode === 'status')
          return {
            accountStatus: await this.gateway!.status(cancel),
            punishments: [],
            appeals: [],
            nextCursor: null,
          };
        if (this.mode === 'appeal') {
          const page = await this.gateway!.appeals(cancel);
          return {
            appeals: page.items,
            nextCursor: page.nextCursor,
            selectedPunishment: navigation.punishmentId
              ? await this.gateway!.ownPunishment(
                  navigation.punishmentId,
                  cancel,
                )
              : null,
            selectedAppeal: navigation.appealId
              ? await this.gateway!.appeal(navigation.appealId, cancel)
              : null,
          };
        }
        if (this.mode === 'appeal-management') {
          const page = await this.gateway!.appealQueue(cancel);
          const selectedAppeal = navigation.appealId
            ? await this.gateway!.appealManagement(navigation.appealId, cancel)
            : null;
          return {
            appeals: page.items,
            nextCursor: page.nextCursor,
            selectedAppeal,
            canDecide: selectedAppeal?.canDecide ?? false,
          };
        }
        const page = await this.gateway!.punishments(cancel);
        const selectedPunishment = navigation.punishmentId
          ? await this.gateway!.punishment(navigation.punishmentId, cancel)
          : null;
        return {
          punishments: page.items,
          nextCursor: page.nextCursor,
          selectedPunishment,
          canRelease: selectedPunishment?.canRelease ?? false,
        };
      },
      (result) => {
        this.assertEnvironment();
        this.update({
          ...result,
          loaded: true,
          status: '已按当前账号权限重新核验',
        });
      },
    );
  }
  async more(): Promise<void> {
    if (
      this.view.busy ||
      !this.available() ||
      !this.restore() ||
      this.pending ||
      !this.view.nextCursor
    )
      return;
    const after = this.view.nextCursor;
    await this.run(
      async (cancel) => {
        this.assertEnvironment();
        if (this.mode === 'status') {
          const page = await this.gateway!.history(cancel, after);
          return {
            punishments: [...this.view.punishments, ...page.items],
            nextCursor: page.nextCursor,
          };
        }
        if (this.mode === 'punishment-management') {
          const page = await this.gateway!.punishments(cancel, after);
          return {
            punishments: [...this.view.punishments, ...page.items],
            nextCursor: page.nextCursor,
          };
        }
        const page =
          this.mode === 'appeal'
            ? await this.gateway!.appeals(cancel, after)
            : await this.gateway!.appealQueue(cancel, after);
        return {
          appeals: [...this.view.appeals, ...page.items],
          nextCursor: page.nextCursor,
        };
      },
      (result) => this.update(result),
    );
  }
  async history(more = false): Promise<void> {
    if (this.view.busy || !this.available() || !this.restore() || this.pending)
      return;
    const punishment = this.view.selectedPunishment;
    const after = more ? (this.view.historyCursor ?? undefined) : undefined;
    if (more && !after) return;
    if (
      this.mode !== 'status' &&
      (this.mode !== 'punishment-management' || !punishment)
    )
      return;
    await this.run(
      (cancel) =>
        this.mode === 'status'
          ? this.gateway!.history(cancel, after)
          : this.gateway!.punishmentHistory(
              punishment!.punishmentId,
              cancel,
              after,
            ),
      (page) =>
        this.update({
          history: more ? [...this.view.history, ...page.items] : page.items,
          historyCursor: page.nextCursor,
        }),
    );
  }
  selectPunishment(id: string) {
    if (!this.view.busy && !this.view.frozen) {
      this.stop();
      void this.load({ punishmentId: id });
    }
  }
  selectAppeal(id: string) {
    if (!this.view.busy && !this.view.frozen) {
      this.stop();
      void this.load({ appealId: id });
    }
  }
  setText(value: string) {
    if (!this.view.busy && !this.view.frozen)
      this.update({ text: value, confirming: null });
  }
  setReason(value: string) {
    if (!this.view.busy && !this.view.frozen)
      this.update({ reason: value, confirming: null });
  }
  request(action: Command['action'], decision: Decision = 'upheld') {
    if (this.view.busy || !this.available() || !this.restore() || this.pending)
      return;
    if (
      action === 'submit_appeal' &&
      (this.mode !== 'appeal' ||
        !this.view.selectedPunishment?.canAppeal ||
        !this.view.text.trim() ||
        this.view.text.trim().length > 4000)
    )
      return;
    if (
      action === 'release' &&
      (this.mode !== 'punishment-management' || !this.view.canRelease)
    )
      return;
    if (
      action === 'decide_appeal' &&
      (this.mode !== 'appeal-management' ||
        !this.view.canDecide ||
        !['upheld', 'released', 'closed_no_longer_effective'].includes(
          decision,
        ))
    )
      return;
    if (
      action !== 'submit_appeal' &&
      (!this.view.reason.trim() || this.view.reason.trim().length > 255)
    ) {
      this.update({ error: '请填写 1–255 字处理理由' });
      return;
    }
    this.update({ confirming: action, decision, error: '' });
  }
  closeConfirmation() {
    if (!this.view.busy) this.update({ confirming: null });
  }
  async submit(): Promise<void> {
    const action = this.view.confirming;
    if (
      !action ||
      action === 'cancel' ||
      this.view.busy ||
      !this.available() ||
      !this.restore() ||
      this.pending
    )
      return;
    const account = this.accountId()!,
      owner = this.owner;
    const punishment = this.view.selectedPunishment,
      appeal = this.view.selectedAppeal,
      text = this.view.text.trim(),
      reason = this.view.reason.trim(),
      decision = this.view.decision;
    if (
      (action === 'submit_appeal' && !punishment?.canAppeal) ||
      (action === 'release' && !this.view.canRelease) ||
      (action === 'decide_appeal' && !this.view.canDecide)
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
        const command = decodeCommand({
          clientRequestId,
          action,
          ...(action === 'submit_appeal'
            ? {
                punishment: reference(
                  punishment && {
                    punishmentId: punishment.punishmentId,
                    kind: punishment.kind,
                    revision: punishment.revision,
                  },
                ),
                text,
              }
            : action === 'release'
              ? {
                  punishment: reference(
                    punishment && {
                      punishmentId: punishment.punishmentId,
                      kind: punishment.kind,
                      revision: punishment.revision,
                    },
                  ),
                  expectedStateVersion: (punishment as PunishmentManagement)
                    .stateVersion,
                  reason,
                }
              : {
                  appealId: appeal!.appealId,
                  expectedStateVersion: (appeal as AppealManagement)
                    .stateVersion,
                  decision,
                  reason,
                }),
        });
        this.pending = this.store!.freeze({
          version: 1,
          origin: this.store!.origin,
          accountId: account,
          phase: 'submit',
          command,
        });
        this.showPending();
        return this.dispatch(this.pending, cancel);
      },
      (receipt) => {
        this.finish(receipt);
        settled = true;
      },
      (error) => {
        this.restore();
        if (error.kind === 'storage') this.update({ frozen: true });
      },
    );
    if (settled) await this.refreshAfter(owner);
  }
  private async refreshAfter(owner: typeof this.owner) {
    try {
      this.runtime.sessions.assertCurrent(owner);
    } catch {
      return;
    }
    await this.load(this.navigation);
  }
  private showPending() {
    this.update({
      frozen: true,
      confirming: null,
      loaded: false,
      selectedPunishment: null,
      selectedAppeal: null,
      canDecide: false,
      canRelease: false,
      punishments: [],
      appeals: [],
      history: [],
      pendingCommand: this.pending?.command ?? null,
      pendingRequestId: this.pending?.command.clientRequestId ?? '',
      pendingAction: this.pending?.command.action ?? '',
      pendingPhase: this.pending?.phase ?? '',
      receiptStatus: '',
    });
  }
  private dispatch(
    pending: PendingModeration,
    cancel: Cancellation,
  ): Promise<Receipt> {
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
  private finish(raw: Receipt) {
    this.assertEnvironment();
    if (!this.pending || this.pending.accountId !== this.accountId())
      throw new ClientError('protocol', 'Original actor unavailable');
    const receipt = decodeReceipt(raw);
    matchReceipt(this.pending.command, receipt);
    this.store!.settle(this.pending, receipt);
    this.pending = null;
    this.update({
      frozen: false,
      confirming: null,
      pendingCommand: null,
      recordedReceipt: receipt,
      pendingRequestId: '',
      pendingAction: '',
      pendingPhase: '',
      text: '',
      reason: '',
      receiptStatus:
        receipt.outcome === 'applied'
          ? '原请求已完成。此为历史回执，请重新核验当前状态；解除一项处罚不会解除另一项处罚。'
          : receipt.code === 'SAFETY_MODERATION_CANCELLED'
            ? '原请求已取消；已经完成的操作不会回滚。'
            : '状态已变化，原请求未执行；请重新核验后确认。',
    });
  }
  async recover(retry = false): Promise<void> {
    if (this.view.busy || !this.available() || !this.restore() || !this.pending)
      return;
    const pending = this.pending,
      owner = this.owner;
    let settled = false;
    await this.run(
      async (cancel) => {
        this.assertEnvironment();
        this.store!.assertOriginal(pending);
        const result = decodeRecovery(
          await this.gateway!.receipt(pending.command, cancel),
        );
        if (result.state === 'recorded') return result.receipt;
        if (retry) return this.dispatch(pending, cancel);
        throw new ClientError('http', 'Receipt not settled', {
          httpStatus: 404,
          serverCode: 'REQUEST_NOT_FOUND',
        });
      },
      (receipt) => {
        this.finish(receipt);
        settled = true;
      },
      (error) => {
        this.restore();
        if (error.kind === 'storage') this.update({ frozen: true });
      },
    );
    if (settled) await this.refreshAfter(owner);
  }
  requestCancellation() {
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
      this.showPending();
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
      (error) => {
        this.restore();
        if (error.kind === 'storage') this.update({ frozen: true });
      },
    );
    if (settled) await this.refreshAfter(owner);
  }
}
