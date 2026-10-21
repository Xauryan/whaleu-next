import { ClientError, clientError } from '../api/errors';
import type { SessionStore, SessionTicket } from '../auth/session';
import type { LocalMediaFile, MediaSession } from '../media/contracts';
import { Cancellation, type Clock } from '../platform/contracts';
import {
  PROFILE_COVER_PROTOCOL,
  decodeCoverCapabilities,
  coverInvalid,
  decodeCoverCommandRecovery,
  decodeCoverEditRecovery,
  decodeCoverEditStatus,
  decodeCoverReceipt,
  decodeCurrentCover,
  type CoverEditStatus,
  type CoverSource,
} from './cover-contract';
import type { CoverGateway } from './cover-gateway';
import { PendingCoverStore, type PendingCover } from './cover-pending';
import {
  CoverPrincipalOwner,
  type CoverPrincipalContext,
} from './cover-principal';
import type { CoverUploadTransfer } from './cover-transfer';
export interface CoverEditView {
  readonly loaded: boolean;
  readonly busy: boolean;
  readonly canChoose: boolean;
  readonly uploadAvailable: boolean;
  readonly pickerWaiting: boolean;
  readonly canSave: boolean;
  readonly needsRecovery: boolean;
  readonly needsReload: boolean;
  readonly previewSrc: string;
  readonly selection: 'none' | 'custom' | 'clear';
  readonly progress: number;
  readonly status: string;
  readonly error: string;
}
export const initialCoverEditView = (): CoverEditView => ({
  loaded: false,
  busy: false,
  canChoose: false,
  uploadAvailable: false,
  pickerWaiting: false,
  canSave: false,
  needsRecovery: false,
  needsReload: false,
  previewSrc: '',
  selection: 'none',
  progress: 0,
  status: '背景图尚未加载',
  error: '',
});
interface Operation {
  readonly cancel: Cancellation;
  readonly ticket: SessionTicket;
  readonly session: MediaSession;
  readonly principal: CoverPrincipalContext;
}
/** Same SessionStore epoch as OwnedController. Unknown commands survive in the
 * actor journal; all local media authority is revoked immediately on identity change. */
export class ProfileCoverController {
  private owner: SessionTicket;
  private operation: Operation | null = null;
  private file: LocalMediaFile | null = null;
  private revision: number | null = null;
  private selection: CoverSource | null = null;
  private disposed = false;
  private stopPreview = () => undefined as void;
  private view = initialCoverEditView();
  private readonly unsubscribe: () => void;
  private readonly unsubscribePicker: () => void;
  private uploadAvailable = false;
  private pickerSuspended = false;
  private readonly pickerResumes = new Set<() => void>();
  constructor(
    private readonly sessions: SessionStore,
    private readonly principals: CoverPrincipalOwner,
    private readonly gateway: CoverGateway,
    private readonly pending: PendingCoverStore,
    private readonly transfer: CoverUploadTransfer | undefined,
    private readonly clock: Clock,
    private readonly newRequestId: () => Promise<string>,
    private readonly render: (view: CoverEditView) => void,
    private readonly changed: () => void = () => undefined,
  ) {
    this.owner = sessions.snapshot();
    this.unsubscribe = sessions.subscribe(() => {
      const current = sessions.snapshot();
      if (
        current.epoch !== this.owner.epoch ||
        current.credentials?.accountId !== this.owner.credentials?.accountId
      ) {
        this.clearPrivate();
        this.owner = current;
        this.publish({
          ...initialCoverEditView(),
          status: '登录状态已改变，请重新加载',
        });
      }
    });
    this.unsubscribePicker =
      transfer?.subscribePicker(() => {
        let canChoose = false;
        const state = transfer?.pickerState ?? 'unavailable';
        try {
          this.sessions.assertCurrent(this.owner);
          canChoose =
            this.uploadAvailable &&
            !!this.owner.credentials &&
            this.view.loaded &&
            !this.view.needsReload &&
            state === 'ready' &&
            !this.pending.load(this.owner.credentials.accountId);
        } catch {
          /* Stale actors and uncertain storage remain unavailable. */
        }
        const finished =
          this.view.pickerWaiting &&
          canChoose &&
          this.view.selection === 'none' &&
          !this.view.needsRecovery;
        this.update({
          canChoose,
          pickerWaiting: state === 'waiting-native',
          ...(finished
            ? { status: '系统选图已结束，可以重新选择', error: '' }
            : {}),
        });
      }) ?? (() => undefined);
  }
  snapshot(): CoverEditView {
    return this.view;
  }
  async load(): Promise<void> {
    if (this.disposed || this.operation) return;
    this.selection = null;
    this.uploadAvailable = false;
    this.update({ loaded: false, canChoose: false, uploadAvailable: false });
    this.releaseFile();
    await this.run(async (op) => {
      const actor = this.actor(op);
      let record = this.pending.load(actor);
      if (record?.command) {
        const recovery = decodeCoverCommandRecovery(
          await this.gateway.recoverCommand(
            record.command.input.clientRequestId,
            op.session,
            op.cancel,
          ),
        );
        op.session.current();
        if (recovery.clientRequestId !== record.command.input.clientRequestId)
          coverInvalid();
        if (recovery.state === 'committed') {
          this.pending.settleCommand(record, recovery.receipt);
          record = null;
          this.changed();
        } else if (recovery.state === 'cancelled') {
          record = this.pending.settleCancelledCommand(record, recovery);
        }
      }
      this.update({
        needsRecovery: !!record,
        canSave: false,
        selection: 'none',
      });
      const current = decodeCurrentCover(
        await this.gateway.current(null, op.principal, op.cancel),
      );
      const capabilities = decodeCoverCapabilities(
        await this.gateway.capabilities(op.principal, op.cancel),
      );
      op.session.current();
      this.uploadAvailable = capabilities.upload === 'available';
      this.revision = current.revision;
      this.update({
        loaded: true,
        needsReload: false,
        uploadAvailable: this.uploadAvailable,
        canChoose: this.pickerReady() && !record,
        pickerWaiting: this.transfer?.pickerState === 'waiting-native',
        status: record
          ? '原背景图请求结果待确认，请恢复'
          : this.transfer?.pickerState === 'waiting-native'
            ? '系统选图尚未结束，请关闭选图界面并等待系统确认结束'
            : !this.transfer || !this.uploadAvailable
              ? '背景图上传暂未开放'
              : '背景图已加载',
      });
    });
  }
  /** A native album picker is explicit; no automatic selection, camera or cropping. */
  async chooseCustomCover(): Promise<void> {
    if (!this.editable() || !this.transfer || !this.view.canChoose) return;
    this.selection = null;
    this.releaseFile();
    let op: Operation;
    try {
      op = this.begin();
    } catch (error) {
      this.finishFailure(error);
      return;
    }
    this.update({
      busy: true,
      canSave: false,
      selection: 'none',
      status: '请选择背景图，尚未保存',
      error: '',
    });
    try {
      const file = await this.transfer.pick(op.session, op.cancel);
      try {
        op.session.current();
      } catch (error) {
        await this.transfer.remove(file);
        throw error;
      }
      this.file = file;
      await this.waitForPickerResume(op);
      const actual = await this.transfer.inspect(file, op.session, op.cancel);
      op.session.current();
      const previewSrc = await this.transfer.preview(
        file,
        op.session,
        op.cancel,
      );
      op.session.current();
      this.update({
        previewSrc,
        selection: 'custom',
        status: '预览未保存，正在上传',
      });
      this.stopPreview = this.clock.schedule(() => {
        this.update({ previewSrc: '' });
        if (!this.operation) this.releaseFile();
      }, 30_000);
      const clientRequestId = await this.newRequestId();
      op.session.current();
      if (this.revision === null) coverInvalid();
      let record = this.pending.freezeEdit(this.actor(op), {
        protocol: PROFILE_COVER_PROTOCOL,
        clientRequestId,
        expectedRevision: this.revision,
        slot: 'cover',
        declaration: {
          mime: actual.mime,
          bytes: actual.bytes,
          sha256: actual.sha256,
        },
      });
      this.update({ needsRecovery: true, canChoose: false });
      this.pending.assertStored(record);
      const status = await this.gateway.prepare(
        record.edit!.prepare,
        op.session,
        op.cancel,
      );
      op.session.current();
      record = this.pending.observe(record, status);
      await this.advance(record, status, op, true);
    } catch (error) {
      if (this.current(op)) {
        try {
          if (
            clientError(error).kind === 'cancelled' &&
            !this.pending.load(this.actor(op))
          ) {
            this.releaseFile();
            this.update({
              canChoose: this.pickerReady(),
              pickerWaiting: this.transfer.pickerState === 'waiting-native',
              needsRecovery: false,
              status:
                this.transfer.pickerState === 'waiting-native'
                  ? '等待系统选图结束后即可重新选择'
                  : '已取消选图，可以重新选择',
              error: '',
            });
          } else this.finishFailure(error);
        } catch (storageError) {
          this.finishFailure(storageError);
        }
      }
    } finally {
      this.finish(op);
    }
  }
  async selectClear(): Promise<void> {
    if (!this.view.loaded || this.disposed || this.view.needsReload) return;
    if (this.operation) {
      const actor = this.owner.credentials?.accountId;
      if (!actor || this.pending.load(actor)?.command) return;
      this.cancelOperation();
    }
    if (!(await this.cancelPendingEdit())) return;
    if (!this.editable()) return;
    this.releaseFile();
    this.selection = { kind: 'clear' };
    this.update({
      selection: 'clear',
      canSave: true,
      status: '将清除当前背景图，尚未保存',
      error: '',
    });
  }
  async save(): Promise<void> {
    if (
      this.disposed ||
      this.operation ||
      !this.selection ||
      !this.view.canSave ||
      this.revision === null ||
      this.view.needsReload
    )
      return;
    const source = this.selection,
      revision = this.revision;
    await this.run(async (op) => {
      const clientRequestId = await this.newRequestId();
      op.session.current();
      const record = this.pending.freezeCommand(this.actor(op), {
        protocol: PROFILE_COVER_PROTOCOL,
        clientRequestId,
        expectedRevision: revision,
        source,
      });
      this.update({
        needsRecovery: true,
        canSave: false,
        canChoose: false,
        status: '正在保存背景图',
      });
      await this.dispatch(record, op);
    });
  }
  async recover(retrySameCommand = false): Promise<void> {
    if (this.disposed || this.operation) return;
    this.selection = null;
    this.releaseFile();
    await this.run(async (op) => {
      let record = this.pending.load(this.actor(op));
      if (!record) {
        this.update({ needsRecovery: false, status: '没有待恢复的背景图请求' });
        return;
      }
      if (record.command) {
        // Receipt recovery always precedes current metadata or upload recovery.
        const recovered = decodeCoverCommandRecovery(
          await this.gateway.recoverCommand(
            record.command.input.clientRequestId,
            op.session,
            op.cancel,
          ),
        );
        op.session.current();
        if (recovered.clientRequestId !== record.command.input.clientRequestId)
          coverInvalid();
        if (recovered.state === 'committed') {
          this.committed(record, recovered.receipt);
          return;
        }
        if (recovered.state === 'cancelled') {
          const remaining = this.pending.settleCancelledCommand(
            record,
            recovered,
          );
          this.update({
            needsRecovery: !!remaining,
            canSave: false,
            needsReload: true,
            status: remaining
              ? '原保存已取消，请取消或恢复未绑定上传编辑'
              : '原保存已取消，请重新加载',
          });
          return;
        }
        if (retrySameCommand) await this.dispatch(record, op);
        else
          this.update({
            needsRecovery: true,
            canSave: false,
            canChoose: false,
            status: '原请求尚无确认结果；可以继续查询或重试同一个请求',
          });
        return;
      }
      const recovered = decodeCoverEditRecovery(
        await this.gateway.recoverEdit(
          record.edit!.prepare.clientRequestId,
          op.session,
          op.cancel,
        ),
      );
      op.session.current();
      if (recovered.requestId !== record.edit!.prepare.clientRequestId)
        coverInvalid();
      if (recovered.state === 'not_recorded') {
        this.update({
          needsRecovery: true,
          status: '原上传结果尚未确认；请取消原编辑后重新选择',
        });
        return;
      }
      if (recovered.state === 'cancelled_before_prepare') {
        this.pending.settlePrePrepare(record, recovered);
        this.update({ needsRecovery: false, status: '原编辑已取消' });
        return;
      }
      const cancelling = record.edit?.phase === 'cancel_uncertain';
      record = this.pending.observe(record, recovered.status);
      if (cancelling) {
        await this.cancelRecord(record, op);
        return;
      }
      await this.advance(record, recovered.status, op, false);
    });
  }
  /** Explicit user action: cancel the original selection command and any unbound edit.
   * A racing commit is returned as history, never cleared or replaced. */
  async cancelPendingCommand(): Promise<void> {
    if (this.disposed || this.operation) return;
    await this.run(async (op) => {
      const record = this.pending.load(this.actor(op));
      if (!record?.command) {
        this.update({ status: '没有待取消的保存请求' });
        return;
      }
      const proof = decodeCoverCommandRecovery(
        await this.gateway.cancelCommand(
          record.command.input.clientRequestId,
          record.command.requestHash,
          op.session,
          op.cancel,
        ),
      );
      op.session.current();
      if (proof.state === 'committed') {
        this.committed(record, proof.receipt);
        return;
      }
      if (proof.state !== 'cancelled') coverInvalid();
      const remaining = this.pending.settleCancelledCommand(record, proof);
      this.selection = null;
      this.releaseFile();
      if (remaining) {
        if (await this.cancelRecord(remaining, op))
          this.update({
            needsReload: true,
            canChoose: false,
            status: '原保存及上传编辑已取消，请重新加载',
          });
      } else
        this.update({
          needsRecovery: false,
          needsReload: true,
          canSave: false,
          canChoose: false,
          selection: 'none',
          status: '原保存请求已取消，请重新加载后编辑',
        });
    });
  }
  async cancelPendingEdit(): Promise<boolean> {
    if (this.disposed || this.operation) return false;
    let cleared = false;
    await this.run(async (op) => {
      const record = this.pending.load(this.actor(op));
      if (!record) {
        cleared = true;
        this.update({ needsRecovery: false });
        return;
      }
      if (record.command) {
        this.update({
          needsRecovery: true,
          status: '保存结果未知，请先恢复原请求',
        });
        return;
      }
      cleared = await this.cancelRecord(record, op);
    });
    return cleared;
  }
  cancelOperation(): void {
    const op = this.operation;
    if (!op) return;
    this.operation = null;
    op.cancel.cancel();
    this.releaseFile();
    this.selection = null;
    const actor = this.owner.credentials?.accountId;
    let pending = true;
    try {
      pending = !!actor && !!this.pending.load(actor);
    } catch {
      /* Fail closed if storage cannot be inspected. */
    }
    this.update({
      busy: false,
      canSave: false,
      canChoose: this.pickerReady() && !pending,
      pickerWaiting: this.transfer?.pickerState === 'waiting-native',
      needsRecovery: pending,
      status: pending
        ? '已停止本地等待，请恢复原请求确认结果'
        : '已停止选图等待，请先关闭系统选图界面后重新选择',
    });
  }
  hide(): void {
    if (this.isNativePickerPending()) {
      this.pickerSuspended = true;
      this.update({ previewSrc: '' });
      return;
    }
    this.clearPrivate();
  }
  invalidate(): void {
    this.clearPrivate();
  }
  isNativePickerPending(): boolean {
    return (
      !!this.operation &&
      (this.pickerSuspended || this.transfer?.pickerState === 'waiting-native')
    );
  }
  resume(): void {
    this.pickerSuspended = false;
    for (const resume of [...this.pickerResumes]) resume();
  }
  private async waitForPickerResume(op: Operation): Promise<void> {
    if (!this.pickerSuspended) return;
    await new Promise<void>((resolve, reject) => {
      let stop = () => undefined as void;
      const finish = () => {
        stop();
        this.pickerResumes.delete(finish);
        resolve();
      };
      this.pickerResumes.add(finish);
      stop = op.cancel.subscribe(() => {
        this.pickerResumes.delete(finish);
        reject(new ClientError('cancelled', 'Cover picker owner ended'));
      });
    });
    op.session.current();
  }
  private pickerReady(): boolean {
    return this.uploadAvailable && this.transfer?.pickerState === 'ready';
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.unsubscribePicker();
    this.clearPrivate();
    this.publish(initialCoverEditView());
  }
  private async cancelRecord(
    record: PendingCover,
    op: Operation,
  ): Promise<boolean> {
    if (!record.edit || record.command) coverInvalid();
    record = this.pending.phase(record, 'cancel_uncertain');
    this.selection = null;
    this.releaseFile();
    const recovered = decodeCoverEditRecovery(
      await this.gateway.cancelEdit(
        record.edit!.prepare.clientRequestId,
        record.edit!.requestHash,
        op.session,
        op.cancel,
      ),
    );
    op.session.current();
    if (recovered.state === 'cancelled_before_prepare') {
      this.pending.settlePrePrepare(record, recovered);
      this.update({
        needsRecovery: false,
        canSave: false,
        canChoose: this.pickerReady(),
        selection: 'none',
        status: '原编辑已取消',
      });
      return true;
    }
    if (recovered.state !== 'recorded') {
      this.update({
        needsRecovery: true,
        status: '取消尚未确认，请继续恢复原请求',
      });
      return false;
    }
    if (
      recovered.status.status !== 'terminal' &&
      recovered.status.status !== 'bound_history'
    ) {
      this.pending.observe(record, recovered.status);
      this.update({
        needsRecovery: true,
        status: '服务端仍在处理取消，请恢复确认',
      });
      return false;
    }
    this.pending.settleEdit(record, recovered.status);
    this.update({
      needsRecovery: false,
      canSave: false,
      canChoose: this.pickerReady(),
      selection: 'none',
      status:
        recovered.status.status === 'bound_history'
          ? '原背景图已保存，取消不会撤回已保存背景图'
          : '原编辑已取消',
    });
    if (recovered.status.status === 'bound_history') {
      this.revision = null;
      this.update({ needsReload: true, canChoose: false });
      this.changed();
    }
    return !this.view.needsReload;
  }
  private async advance(
    initial: PendingCover,
    raw: CoverEditStatus,
    op: Operation,
    mayUpload: boolean,
  ): Promise<void> {
    let record = initial,
      status = decodeCoverEditStatus(raw);
    for (;;) {
      op.session.current();
      if (status.status === 'ready_unbound') {
        if (status.bindBefore <= status.serverNow)
          throw new ClientError('business', 'Cover edit expired');
        this.revision = record.edit!.prepare.expectedRevision;
        this.selection = {
          kind: 'custom',
          editId: status.editId,
          assetId: status.assetId,
        };
        if (!this.view.previewSrc) this.releaseFile();
        this.update({
          canSave: true,
          needsRecovery: false,
          selection: 'custom',
          status: '背景图已处理，点击保存后生效',
          progress: 100,
        });
        return;
      }
      if (status.status === 'terminal' || status.status === 'bound_history') {
        this.pending.settleEdit(record, status);
        this.releaseFile();
        this.selection = null;
        this.update({
          needsRecovery: false,
          canSave: false,
          canChoose: this.pickerReady(),
          selection: 'none',
          status:
            status.status === 'bound_history'
              ? '原背景图请求已保存，请重新加载当前背景图'
              : '原背景图编辑已结束',
        });
        if (status.status === 'bound_history') {
          this.update({ needsReload: true, canChoose: false });
          this.changed();
        }
        return;
      }
      if (status.status === 'unavailable')
        throw new ClientError('configuration', 'Cover processing unavailable');
      if (status.status === 'prepared') {
        if (
          !mayUpload ||
          !this.file ||
          !this.transfer ||
          status.upload !== 'none'
        ) {
          this.update({
            needsRecovery: true,
            canSave: false,
            status:
              status.upload === 'none'
                ? '本地原图已清除，请取消原编辑后重新选择'
                : '上传结果待确认，请稍后恢复原请求',
          });
          return;
        }
        const grant = await this.gateway.grant(
          status.editId,
          op.session,
          op.cancel,
        );
        op.session.current();
        if (
          grant.intentId !== status.intentId ||
          grant.editId !== status.editId ||
          grant.expectedSha256 !== record.edit!.prepare.declaration.sha256 ||
          grant.expectedBytes !== record.edit!.prepare.declaration.bytes ||
          grant.expectedMime !== record.edit!.prepare.declaration.mime
        )
          coverInvalid();
        const handle = this.transfer.register(grant, op.session);
        record = this.pending.phase(record, 'upload_uncertain');
        await this.transfer.upload(
          handle,
          this.file,
          (progress) => {
            if (this.current(op))
              this.update({
                progress,
                status:
                  progress === 100
                    ? '上传完成，仍在等待处理与保存'
                    : '正在上传，尚未保存',
              });
          },
          op.session,
          op.cancel,
        );
        op.session.current();
        status = await this.gateway.finalize(
          status.editId,
          op.session,
          op.cancel,
        );
      } else if (status.status === 'uploaded') {
        status = await this.gateway.finalize(
          status.editId,
          op.session,
          op.cancel,
        );
      } else {
        await this.wait(status.retryAfterMs, op);
        status = await this.gateway.status(
          status.editId,
          op.session,
          op.cancel,
        );
      }
      op.session.current();
      record = this.pending.observe(record, status);
      mayUpload = false;
    }
  }
  private async dispatch(record: PendingCover, op: Operation): Promise<void> {
    if (!record.command) coverInvalid();
    this.pending.assertStored(record);
    try {
      const receipt = decodeCoverReceipt(
        await this.gateway.command(record.command.input, op.session, op.cancel),
      );
      op.session.current();
      this.committed(record, receipt);
    } catch (error) {
      op.session.current();
      const failure = clientError(error);
      if (
        failure.kind !== 'protocol' &&
        failure.details.httpStatus === 409 &&
        failure.details.serverCode === 'PROFILE_REVISION_CONFLICT'
      ) {
        this.selection = null;
        this.releaseFile();
        this.update({
          needsReload: true,
          needsRecovery: true,
          canSave: false,
          canChoose: false,
          status: '资料已更新，请先取消原保存请求再重新加载；不会自动覆盖',
        });
        return;
      }
      throw error;
    }
  }
  private committed(
    record: PendingCover,
    receipt: Parameters<PendingCoverStore['settleCommand']>[1],
  ): void {
    this.pending.settleCommand(record, receipt);
    this.releaseFile();
    this.selection = null;
    this.revision = null;
    this.uploadAvailable = false;
    this.pickerSuspended = false;
    this.update({
      needsRecovery: false,
      needsReload: true,
      canSave: false,
      canChoose: false,
      selection: 'none',
      status: '背景图保存已确认，请重新加载后继续编辑',
    });
    this.changed();
  }
  private editable(): boolean {
    try {
      this.sessions.assertCurrent(this.owner);
      return (
        !this.disposed &&
        !this.operation &&
        !!this.owner.credentials &&
        this.view.loaded &&
        !this.view.needsReload &&
        !this.pending.load(this.owner.credentials.accountId)
      );
    } catch {
      return false;
    }
  }
  private begin(): Operation {
    this.sessions.assertCurrent(this.owner);
    if (this.disposed || this.operation || !this.owner.credentials)
      throw new ClientError('auth-required', 'Original account required');
    const ticket = this.sessions.snapshot(),
      principal = this.principals.snapshot();
    const op: Operation = {
      ticket,
      cancel: new Cancellation(),
      session: {
        current: () => {
          this.sessions.assertCurrent(ticket);
          if (this.disposed || this.operation !== op || op.cancel.isCancelled)
            throw new ClientError('cancelled', 'Cover operation superseded');
          return this.sessions.snapshot();
        },
      },
      principal: {
        current: () => {
          op.session.current();
          this.principals.assertCurrent(principal);
          return this.principals.snapshot();
        },
      },
    };
    this.operation = op;
    return op;
  }
  private actor(op: Operation): string {
    const actor = op.session.current().credentials?.accountId;
    if (!actor) coverInvalid();
    return actor;
  }
  private current(op: Operation): boolean {
    try {
      op.session.current();
      return true;
    } catch {
      return false;
    }
  }
  private async run(work: (op: Operation) => Promise<void>): Promise<void> {
    let op: Operation;
    try {
      op = this.begin();
    } catch (error) {
      this.finishFailure(error);
      return;
    }
    this.update({ busy: true, error: '' });
    try {
      await work(op);
    } catch (error) {
      if (this.current(op)) this.finishFailure(error);
    } finally {
      this.finish(op);
    }
  }
  private finish(op: Operation): void {
    if (this.operation === op) {
      this.operation = null;
      this.update({ busy: false });
    }
  }
  private finishFailure(error: unknown): void {
    if (this.disposed) return;
    const failure = clientError(error);
    this.releaseFile();
    if (this.transfer?.pickerState === 'waiting-native') {
      this.update({
        canSave: false,
        canChoose: false,
        pickerWaiting: true,
        error: '',
        status: '系统选图尚未结束，请关闭选图界面并等待系统确认结束',
      });
      return;
    }
    this.update({
      canSave: false,
      error:
        failure.kind === 'storage'
          ? '恢复记录无法可靠保存，请勿发起新请求'
          : '操作未完成，请恢复原请求或重新加载',
      status: '背景图操作未完成',
    });
  }
  private wait(delay: number, op: Operation): Promise<void> {
    return new Promise((resolve, reject) => {
      let stop = () => undefined as void;
      const cancelTimer = this.clock.schedule(() => {
        stop();
        resolve();
      }, delay);
      stop = op.cancel.subscribe(() => {
        cancelTimer();
        reject(new ClientError('cancelled', 'Cover polling stopped'));
      });
    });
  }
  private releaseFile(): void {
    this.stopPreview();
    this.stopPreview = () => undefined;
    this.update({ previewSrc: '' });
    if (this.file) void this.transfer?.remove(this.file).catch(() => undefined);
    this.file = null;
  }
  private clearPrivate(): void {
    this.uploadAvailable = false;
    this.pickerSuspended = false;
    const op = this.operation;
    this.operation = null;
    this.publish(initialCoverEditView());
    op?.cancel.cancel();
    this.transfer?.clearSession(this.owner);
    this.releaseFile();
    this.revision = null;
    this.selection = null;
  }
  private update(patch: Partial<CoverEditView>): void {
    if (!this.disposed) this.publish({ ...this.view, ...patch });
  }
  private publish(view: CoverEditView): void {
    this.view = Object.freeze(view);
    try {
      this.render(this.view);
    } catch {
      /* A broken renderer cannot retain media authority. */
    }
  }
}
