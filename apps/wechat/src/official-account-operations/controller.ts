import type { SessionStore } from '../auth/session';
import { ClientError } from '../api/errors';
import { systemClock } from '../platform/clock';
import type { Clock } from '../platform/contracts';
import { Cancellation } from '../platform/contracts';
import { uuid, literal, statusLabel, terminal, invalid } from './contracts';
import type {
  Capabilities,
  Config,
  Preview,
  Result,
  CancellationTombstone,
  Status,
  Artwork,
} from './contracts';
import type { OfficialGateway } from './gateway';
import { OfficialCommandJournal } from './journal';
import type { PendingOfficialCommand } from './journal';
export interface OfficialView {
  busy: boolean;
  programId: string;
  capabilities: Capabilities | null;
  config: Config | null;
  preview: Preview | null;
  author: string;
  pending: boolean;
  message: string;
  error: string;
  status: Status | null;
  requestId: string;
  coverAction: 'keep' | 'clear' | 'replace';
  titleAction: 'keep' | 'clear' | 'replace';
  coverAppearanceId: string;
  titleAppearanceId: string;
}
export const initialOfficialView = (): OfficialView => ({
  busy: false,
  programId: '',
  capabilities: null,
  config: null,
  preview: null,
  author: '',
  pending: false,
  message: '仅开发合成模式；不会自动发布',
  error: '',
  status: null,
  requestId: '',
  coverAction: 'keep',
  titleAction: 'keep',
  coverAppearanceId: '',
  titleAppearanceId: '',
});
/** Only private-preview expiry uses a timer; no background worker, remote image lease or publication capability. */
export class OfficialController {
  private expiry: () => void = () => {};
  private view = initialOfficialView();
  private generation = 0;
  private cancel = new Cancellation();
  private disposed = false;
  private pending: PendingOfficialCommand | null = null;
  private flight: Promise<void> | null = null;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly sessions: SessionStore,
    private readonly gateway: OfficialGateway,
    private readonly journal: OfficialCommandJournal,
    private readonly newRequestId: () => Promise<string>,
    private readonly render: (view: OfficialView) => void,
    private readonly clock: Clock = systemClock,
  ) {
    let ticket = sessions.snapshot();
    this.unsubscribe = sessions.subscribe(() => {
      const next = sessions.snapshot();
      if (
        next.epoch !== ticket.epoch ||
        next.credentials?.accountId !== ticket.credentials?.accountId
      ) {
        this.invalidate();
        this.pending = null;
        this.view = initialOfficialView();
        this.view.message = '登录状态已变更，请重新读取；原请求仍按账户保留';
        this.emit();
      }
      ticket = next;
    });
  }
  private emit() {
    this.render({ ...this.view });
  }
  private invalidate() {
    this.expiry();
    this.generation++;
    this.cancel.cancel();
    this.cancel = new Cancellation();
    this.flight = null;
    this.view.busy = false;
    this.view.preview = null;
    this.view.config = null;
    this.view.capabilities = null;
    this.view.author = '';
    this.view.coverAppearanceId = '';
    this.view.titleAppearanceId = '';
  }
  private actor() {
    const actor = this.sessions.snapshot().credentials?.accountId;
    if (!actor) throw new ClientError('auth-required', '请先登录');
    return actor;
  }
  private run(
    work: (current: () => boolean, cancel: Cancellation) => Promise<void>,
  ): Promise<void> {
    if (this.flight) return this.flight;
    if (this.disposed) return Promise.resolve();
    const generation = this.generation,
      cancel = this.cancel;
    const current = () =>
      !this.disposed && generation === this.generation && !cancel.isCancelled;
    this.view.busy = true;
    this.view.error = '';
    this.emit();
    const promise = Promise.resolve()
      .then(() => work(current, cancel))
      .catch((e: unknown) => {
        if (!current()) return;
        this.view.preview = null;
        this.view.config = null;
        this.view.capabilities = null;
        this.view.author = '';
        this.view.coverAppearanceId = '';
        this.view.titleAppearanceId = '';
        this.expiry();
        this.view.error =
          e instanceof ClientError && e.kind === 'storage'
            ? '原请求记录无法安全保存或读取，已停止发送'
            : '操作暂不可用；已有请求请恢复原请求结果';
      })
      .finally(() => {
        if (current()) {
          this.view.busy = false;
          this.flight = null;
          this.emit();
        }
      });
    this.flight = promise;
    return promise;
  }
  load(programId: string): Promise<void> {
    this.invalidate();
    this.view = { ...initialOfficialView(), programId };
    this.pending = null;
    return this.run(async (current, c) => {
      const actor = this.actor();
      this.pending = this.journal.read(actor);
      this.view.pending = !!this.pending;
      this.view.requestId = this.pending?.command.requestId ?? '';
      if (this.pending) {
        const recovered = await this.gateway.recover(
          this.pending.command.requestId,
          c,
        );
        if (!current()) return;
        if (recovered.state !== 'not_recorded')
          this.accept(this.pending, recovered);
        else this.view.message = '原请求尚未记录；保留原键，明确重试或取消';
        this.emit();
      }
      if (!current()) return;
      if (programId === '') {
        if (!this.pending) this.view.message = '请输入已获授权的学校项目引用';
        return;
      }
      const id = uuid(programId);
      const capabilities = await this.gateway.capabilities(id, c);
      if (!current()) return;
      this.view.capabilities = capabilities;
      if (!capabilities.canManage) {
        this.view.message = '公众号操作暂不可用；已有请求仍可恢复';
        return;
      }
      const config = await this.gateway.config(id, c);
      if (!current()) return;
      this.view.config = config;
      this.view.author = config.author;
    });
  }
  setAuthor(value: string) {
    if (this.view.busy || this.pending) return;
    this.view.author = value;
    this.view.preview = null;
    this.emit();
  }
  setArtwork(
    purpose: 'cover' | 'title',
    action: 'keep' | 'clear' | 'replace',
    appearanceId = '',
  ) {
    if (this.view.busy || this.pending) return;
    this.view[`${purpose}Action`] = action;
    this.view[`${purpose}AppearanceId`] = appearanceId;
    this.view.preview = null;
    this.emit();
  }
  preview(kind: 'daily_hot' | 'test') {
    return this.run(async (current, c) => {
      if (this.pending) throw new Error();
      const config = this.view.config,
        cap = this.view.capabilities;
      if (!config || !cap || (kind === 'test' ? !cap.canTest : !cap.canPreview))
        throw new Error();
      const result = await this.gateway.preview(config, kind, c);
      if (!current()) return;
      this.view.preview = result;
      this.expiry();
      this.expiry = this.clock.schedule(
        () => {
          if (current()) {
            this.view.preview = null;
            this.view.message = '预览已过期，请明确重新预览';
            this.emit();
          }
        },
        Math.max(0, Date.parse(result.expiresAt) - this.clock.now()),
      );
      this.view.message =
        result.sourceState === 'known_empty'
          ? '暂无符合条件的内容'
          : '合成预览，不会自动发布';
    });
  }
  save() {
    return this.run(async (current, c) => {
      if (
        this.pending ||
        !this.view.capabilities?.canManage ||
        !this.view.config
      )
        throw new Error();
      const config = this.view.config,
        author = literal(this.view.author, 64);
      const change = (p: 'cover' | 'title'): Artwork => {
        const action = this.view[`${p}Action`];
        return action === 'replace'
          ? { action, appearanceId: uuid(this.view[`${p}AppearanceId`]) }
          : { action };
      };
      const cover = change('cover'),
        title = change('title'),
        actor = this.actor(),
        requestId = uuid(await this.newRequestId());
      if (!current()) return;
      const pending = this.journal.write(actor, 'config_save', {
        requestId,
        programId: config.programId,
        expectedRevision: config.revision,
        author,
        cover,
        title,
      });
      this.install(pending);
      const result = await this.gateway.command(
        pending.operation,
        pending.command,
        c,
      );
      if (!current()) return;
      this.accept(pending, result);
      this.view.preview = null;
      if (result.receipt.outcome === 'config_applied') {
        const next = await this.gateway.config(config.programId, c);
        if (current()) {
          this.view.config = next;
          this.view.author = next.author;
          this.view.coverAction = 'keep';
          this.view.titleAction = 'keep';
        }
      }
    });
  }
  createTest() {
    return this.run(async (current, c) => {
      const preview = this.view.preview;
      if (
        this.pending ||
        !this.view.capabilities?.canTest ||
        !preview ||
        preview.kind !== 'test' ||
        !preview.actions.createDraft ||
        Date.parse(preview.expiresAt) <= this.clock.now()
      )
        throw new Error();
      const actor = this.actor(),
        requestId = uuid(await this.newRequestId());
      if (!current()) return;
      const pending = this.journal.write(actor, 'test_draft', {
        requestId,
        programId: preview.programId,
        previewId: preview.previewId,
        manifestHash: preview.manifestHash,
        expectedConfigRevision: preview.configRevision,
        acknowledgement: 'synthetic_draft_only',
      });
      this.install(pending);
      const result = await this.gateway.command(
        pending.operation,
        pending.command,
        c,
      );
      if (current()) this.accept(pending, result);
    });
  }
  private install(pending: PendingOfficialCommand) {
    this.expiry();
    this.pending = pending;
    this.view.pending = true;
    this.view.requestId = pending.command.requestId;
    this.view.preview = null;
    this.emit();
  }
  private accept(
    pending: PendingOfficialCommand,
    result: Result | CancellationTombstone,
  ) {
    if (!('receipt' in result)) {
      if (result.state !== 'cancelled_before_admission') invalid();
      this.journal.settleCancellation(pending, result);
      this.pending = null;
      this.view.pending = false;
      this.view.status = null;
      this.view.message = '原请求已在录入前取消，未产生外部操作';
      return;
    }
    if (
      result.receipt.requestId !== pending.command.requestId ||
      result.receipt.intentHash !== pending.intentHash ||
      result.receipt.operation !== pending.operation ||
      result.receipt.programId !== pending.command.programId
    )
      invalid();
    this.journal.settle(pending, result);
    this.view.status = result.status;
    this.view.message = statusLabel(result.status);
    if (terminal(result.status)) {
      this.pending = null;
      this.view.pending = false;
    }
  }
  recover(action: 'status' | 'retry' | 'cancel' | 'resume' = 'status') {
    return this.run(async (current, c) => {
      const pending = this.journal.read(this.actor());
      if (!pending) return;
      this.install(pending);
      const result = await this.gateway.recover(pending.command.requestId, c);
      if (!current()) return;
      if (result.state === 'cancelled_before_admission') {
        this.accept(pending, result);
        return;
      }
      if (result.state === 'recorded') {
        this.accept(pending, result);
        if (action === 'status' || terminal(result.status)) return;
        if (action === 'retry') return;
        if (
          action === 'resume' &&
          result.status.nextAction !== 'resume_same_key'
        )
          return;
      } else {
        this.view.message = '原请求尚未记录；保留原键，明确重试或取消';
        if (action === 'status' || action === 'resume') return;
      }
      const next =
        action === 'retry'
          ? await this.gateway.command(pending.operation, pending.command, c)
          : await this.gateway.control(
              action === 'cancel' ? 'cancel' : 'resume',
              pending.command,
              c,
            );
      if (current()) this.accept(pending, next);
    });
  }
  hide() {
    this.invalidate();
    this.view = {
      ...initialOfficialView(),
      programId: this.view.programId,
      pending: !!this.pending,
      requestId: this.pending?.command.requestId ?? '',
    };
    this.emit();
  }
  dispose() {
    this.hide();
    this.disposed = true;
    this.unsubscribe();
  }
}
