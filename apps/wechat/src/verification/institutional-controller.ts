import { ClientError } from '../api/errors';
import type { SessionStore, SessionTicket } from '../auth/session';
import type { PrivateViewLifecycle } from '../identity-privacy/overlay';
import { Cancellation } from '../platform/contracts';
import { isUuid, type Campus } from '../profile/contract';
import type { ProfileGateway } from '../profile/gateway';
import {
  decodeInstitutionalCapability,
  decodeInstitutionalReceipt,
  institutionalConsent,
  institutionalTerminal,
  matchInstitutionalReceipt,
  type InstitutionalCapability,
  type InstitutionalReceipt,
} from './institutional-contract';
import type { InstitutionalGateway } from './institutional-gateway';
import {
  PendingInstitutionalStore,
  type PendingInstitutional,
} from './institutional-pending';
import type {
  InstitutionalNativePort,
  InstitutionalNativeResult,
} from './institutional-port';
export interface InstitutionalRuntime {
  readonly sessions: SessionStore;
  readonly gateway: InstitutionalGateway;
  readonly journal: PendingInstitutionalStore;
  readonly port: InstitutionalNativePort;
  readonly origin: string;
  readonly profiles?: Pick<ProfileGateway, 'campuses'>;
  readonly privateViews: PrivateViewLifecycle;
  readonly newRequestId: () => Promise<string>;
}
export interface InstitutionalView {
  readonly busy: boolean;
  readonly hasSession: boolean;
  readonly configured: boolean;
  readonly nativeAvailable: boolean;
  readonly campusId: string;
  readonly campusQuery: string;
  readonly campuses: readonly Campus[];
  readonly capability: InstitutionalCapability | null;
  readonly consentAccepted: boolean;
  readonly frozen: boolean;
  readonly requestId: string;
  readonly phase: string;
  readonly state: InstitutionalReceipt['state'] | 'idle';
  readonly canAuthorize: boolean;
  readonly message: string;
  readonly error: string;
}
export const initialInstitutionalView = (): InstitutionalView => ({
  busy: false,
  hasSession: false,
  configured: false,
  nativeAvailable: false,
  campusId: '',
  campusQuery: '',
  campuses: [],
  capability: null,
  consentAccepted: false,
  frozen: false,
  requestId: '',
  phase: '',
  state: 'idle',
  canAuthorize: false,
  message: '选择校园以核验学校授权是否可用。',
  error: '',
});
const messages: Record<InstitutionalReceipt['state'], string> = {
  not_recorded: '尚未找到原请求；结果仍未确定。请查询原请求或关闭它后再开始。',
  prepared:
    '原请求已准备。只有尚未开始的本机授权可继续；已开始的请求请查询或关闭。',
  processing: '原授权正在处理，请查询原请求；不会再次发送授权结果。',
  outcome_unknown:
    '原授权结果未知，请查询或明确关闭原请求。不会重新调用学校授权。',
  ready_to_finalize: '学校证明已由服务端保存，正在恢复原请求的本地完成步骤。',
  completed:
    '此次学校认证已记录。下方分别查询当前认证状态与校内 UID；历史成功不代表当前权限。',
  cancelled: '原请求已关闭。再次授权需主动同意并建立新请求。',
  expired: '原请求已过期。再次授权需主动同意并建立新请求。',
  rejected: '学校验证未通过，本次请求已结束。',
  challenge_required:
    '学校验证需要额外确认，本次请求已结束。当前没有真实学校验证入口。',
  provider_unavailable: '学校授权服务暂不可用，本次请求已结束。',
  conflict:
    '当前认证记录存在冲突，本次请求已结束。请通过相应认证管理流程处理。',
  stale: '原学校或认证状态已改变，本次请求已结束。请重新核验当前状态。',
};
const unstarted = (pending: PendingInstitutional) =>
  pending.phase === 'prepare_unstarted' ||
  pending.phase === 'prepared_unstarted';
/** Frozen owner/context, monotone durable phases and a single transient response reference. */
export class InstitutionalController {
  private view = initialInstitutionalView();
  private readonly owner: SessionTicket;
  private pending: PendingInstitutional | null = null;
  private prepared: Extract<
    InstitutionalReceipt,
    { state: 'prepared' }
  > | null = null;
  private response: string | undefined;
  private disposed = false;
  private generation = 0;
  private cancellation: Cancellation | undefined;
  private readonly unsubscribe: () => void;
  private readonly unsubscribePrivate: () => void;
  constructor(
    private readonly runtime: InstitutionalRuntime,
    private readonly render: (view: InstitutionalView) => void,
    campusId = '',
    private readonly onCompleted: () => void = () => undefined,
    private readonly environmentCurrent: () => boolean = () => true,
  ) {
    this.owner = runtime.sessions.snapshot();
    this.view = {
      ...this.view,
      hasSession: !!this.owner.credentials,
      configured: true,
      nativeAvailable: runtime.port.available,
      campusId: isUuid(campusId) ? campusId : '',
    };
    this.unsubscribe = runtime.sessions.subscribe(() => {
      try {
        runtime.sessions.assertCurrent(this.owner);
      } catch {
        this.dispose();
      }
    });
    this.unsubscribePrivate = runtime.privateViews.subscribe((account) => {
      if (
        account === undefined ||
        account === this.owner.credentials?.accountId
      )
        this.dispose();
    });
    this.render(this.view);
  }
  private update(patch: Partial<InstitutionalView>): void {
    if (this.disposed) return;
    this.view = { ...this.view, ...patch };
    this.render(this.view);
  }
  private check(cancel?: Cancellation): void {
    this.runtime.sessions.assertCurrent(this.owner);
    if (
      this.disposed ||
      !this.environmentCurrent() ||
      this.runtime.journal.origin !== this.runtime.origin ||
      (cancel && (cancel.isCancelled || this.cancellation !== cancel))
    )
      throw new ClientError('cancelled', 'Institutional operation changed');
  }
  private restore(): boolean {
    if (!this.owner.credentials) return false;
    try {
      this.check();
      const restored = this.runtime.journal.load(
        this.owner.credentials.accountId,
      );
      if (this.pending) this.runtime.journal.assertOriginal(this.pending);
      this.pending = restored;
      this.update({
        frozen: !!restored,
        requestId: restored?.command.requestId ?? '',
        phase: restored?.phase ?? '',
        canAuthorize: false,
        campusId: this.view.campusId || restored?.command.campusId || '',
      });
      return true;
    } catch {
      this.prepared = null;
      this.update({
        frozen: true,
        capability: null,
        consentAccepted: false,
        canAuthorize: false,
        error: '原请求的本地恢复记录无法确认，请保留记录并稍后重试。',
      });
      return false;
    }
  }
  private async work(
    action: (cancel: Cancellation) => Promise<void>,
  ): Promise<void> {
    if (this.disposed || this.view.busy || !this.owner.credentials) return;
    const generation = ++this.generation,
      cancel = new Cancellation();
    this.cancellation = cancel;
    this.update({ busy: true, error: '', canAuthorize: false });
    try {
      this.check(cancel);
      await action(cancel);
      this.check(cancel);
    } catch {
      if (!this.disposed && generation === this.generation) {
        this.prepared = null;
        this.update({
          frozen: !!this.pending || this.view.frozen,
          canAuthorize: false,
          error: '结果未确认，请查询或关闭原请求。授权结果不会重发。',
        });
      }
    } finally {
      this.response = undefined;
      if (!this.disposed && generation === this.generation) {
        this.cancellation = undefined;
        this.update({
          busy: false,
          canAuthorize:
            !!this.prepared &&
            !!this.pending &&
            unstarted(this.pending) &&
            this.runtime.port.available &&
            this.pending.command.campusId === this.view.campusId,
        });
      }
    }
  }
  private advance(phase: PendingInstitutional['phase']): void {
    if (!this.pending)
      throw new ClientError(
        'storage',
        'Missing original institutional request',
      );
    this.pending = this.runtime.journal.advance(this.pending, phase);
    this.update({ phase });
  }
  private async apply(
    raw: InstitutionalReceipt,
    cancel: Cancellation,
  ): Promise<void> {
    this.check(cancel);
    if (!this.pending)
      throw new ClientError(
        'storage',
        'Missing original institutional request',
      );
    const receipt = decodeInstitutionalReceipt(raw);
    matchInstitutionalReceipt(
      this.pending.command,
      this.pending.requestHash,
      receipt,
    );
    this.runtime.journal.assertOriginal(this.pending);
    this.prepared = receipt.state === 'prepared' ? receipt : null;
    this.update({ state: receipt.state, message: messages[receipt.state] });
    if (
      receipt.state === 'prepared' &&
      this.pending.phase === 'prepare_unstarted'
    )
      this.advance('prepared_unstarted');
    if (receipt.state === 'completed') {
      // Independently refresh current facts even when journal removal later fails.
      this.onCompleted();
    }
    if (institutionalTerminal(receipt)) {
      this.runtime.journal.settle(this.pending, receipt);
      this.pending = null;
      this.prepared = null;
      this.update({
        frozen: false,
        phase: '',
        capability: null,
        consentAccepted: false,
        canAuthorize: false,
      });
    }
  }
  async load(): Promise<void> {
    if (this.disposed || this.view.busy || !this.restore()) return;
    if (this.pending) {
      await this.recover();
      return;
    }
    if (this.view.campusId) await this.loadCapability();
  }
  query(value: string): void {
    if (this.disposed || this.view.busy || this.view.frozen) return;
    this.update({ campusQuery: value.slice(0, 100), campuses: [] });
  }
  async searchCampuses(): Promise<void> {
    if (
      this.view.frozen ||
      !this.runtime.profiles ||
      !this.restore() ||
      this.pending
    )
      return;
    await this.work(async (cancel) => {
      const result = await this.runtime.profiles!.campuses(
        {
          q: this.view.campusQuery.trim(),
          district: '',
          page: 1,
          pageSize: 20,
        },
        cancel,
      );
      this.check(cancel);
      this.update({
        campuses: result.items.filter(
          (item) => item.isActive && item.institutionId !== null,
        ),
      });
    });
  }
  async chooseCampus(id: string): Promise<void> {
    if (
      this.view.busy ||
      this.view.frozen ||
      !this.view.campuses.some((item) => item.id === id)
    )
      return;
    this.changeContext(id);
    await this.loadCapability();
  }
  /** An external context change invalidates callbacks, but never abandons the old key. */
  changeContext(campusId: string): void {
    if (this.disposed || !isUuid(campusId) || campusId === this.view.campusId)
      return;
    this.stop();
    this.prepared = null;
    this.update({
      campusId,
      capability: null,
      consentAccepted: false,
      campuses: [],
      canAuthorize: false,
      message: this.pending
        ? '校园上下文已改变；请查询或关闭原请求。'
        : '请查询学校授权是否可用。',
    });
  }
  async loadCapability(): Promise<void> {
    if (
      this.view.busy ||
      !this.restore() ||
      this.pending ||
      !isUuid(this.view.campusId)
    )
      return;
    const campusId = this.view.campusId;
    this.update({ capability: null, consentAccepted: false });
    await this.work(async (cancel) => {
      const capability = decodeInstitutionalCapability(
        await this.runtime.gateway.capability(campusId, cancel),
      );
      this.check(cancel);
      if (capability.campusId !== campusId || campusId !== this.view.campusId)
        throw new ClientError('protocol', 'Institutional context mismatch');
      this.update({
        capability,
        message:
          capability.state !== 'eligible'
            ? '当前学校授权不可用；仍可办理其他独立认证或恢复原请求。'
            : !this.runtime.port.available
              ? '当前没有可用的安全原生学校授权入口。真实学校接入尚未启用。'
              : '请阅读用途说明并主动同意，然后准备本次学校授权。',
      });
    });
  }
  setConsent(accepted: boolean): void {
    if (this.disposed || this.view.busy || this.view.frozen) return;
    this.update({ consentAccepted: accepted === true });
  }
  async prepare(): Promise<void> {
    const capability = this.view.capability;
    if (
      this.view.busy ||
      !this.runtime.port.available ||
      !this.view.consentAccepted ||
      capability?.state !== 'eligible' ||
      !capability.capabilityVersion ||
      capability.consent !== institutionalConsent ||
      capability.campusId !== this.view.campusId ||
      !this.restore() ||
      this.pending
    )
      return;
    await this.work(async (cancel) => {
      const requestId = await this.runtime.newRequestId();
      this.check(cancel);
      this.pending = this.runtime.journal.freeze(
        this.owner.credentials!.accountId,
        {
          requestId,
          campusId: capability.campusId,
          capabilityVersion: capability.capabilityVersion!,
          consent: institutionalConsent,
        },
      );
      this.update({ frozen: true, requestId, phase: this.pending.phase });
      this.runtime.journal.assertOriginal(this.pending);
      await this.apply(
        await this.runtime.gateway.prepare(this.pending.command, cancel),
        cancel,
      );
    });
  }
  async authorize(): Promise<void> {
    if (
      this.view.busy ||
      !this.runtime.port.available ||
      !this.prepared ||
      !this.restore() ||
      !this.pending ||
      !unstarted(this.pending) ||
      this.pending.command.campusId !== this.view.campusId
    )
      return;
    const prepared = this.prepared;
    await this.work(async (cancel) => {
      // Durable/read-back-verified BEFORE the invocation. A crash consumes this attempt.
      this.advance('authorize_pending');
      this.check(cancel);
      let result: InstitutionalNativeResult | undefined;
      try {
        result = await this.runtime.port.authorize(
          {
            requestId: prepared.requestId,
            requestHash: prepared.requestHash,
            context: prepared.context,
            expiresAt: prepared.expiresAt,
          },
          cancel,
        );
        this.check(cancel);
        this.runtime.journal.assertOriginal(this.pending!);
        if (result.state !== 'authorized') {
          const state = result.state;
          result = undefined;
          this.advance('cancel');
          const pending = this.pending!;
          await this.apply(
            await this.runtime.gateway.close(
              pending.command.requestId,
              pending.requestHash,
              cancel,
            ),
            cancel,
          );
          if (this.view.state !== 'completed')
            this.update({
              message: `${state === 'cancelled' ? '已取消本次学校授权。' : state === 'challenge_required' ? '学校授权需要额外确认。' : state === 'rejected' ? '未获得学校授权。' : state === 'provider_unavailable' ? '学校授权入口暂不可用。' : '学校授权返回无法验证。'} ${this.view.message}`,
            });
          return;
        }
        this.response = result.authorizationResponse;
        result = undefined;
        // No response enters render/storage. A failure here never sends it over HTTP.
        this.advance('submit_pending');
        this.check(cancel);
        const pending = this.pending!;
        const submission = this.runtime.gateway.authorize(
          pending.command.requestId,
          pending.requestHash,
          this.response,
          cancel,
        );
        this.response = undefined;
        await this.apply(await submission, cancel);
      } finally {
        // Deliberately release the application-held handoff object on every exit.
        // eslint-disable-next-line no-useless-assignment
        result = undefined;
        this.response = undefined;
      }
    });
  }
  async recover(): Promise<void> {
    if (this.view.busy || !this.restore() || !this.pending) return;
    await this.work(async (cancel) => {
      const pending = this.pending!;
      this.runtime.journal.assertOriginal(pending);
      if (pending.phase === 'cancel') {
        await this.apply(
          await this.runtime.gateway.close(
            pending.command.requestId,
            pending.requestHash,
            cancel,
          ),
          cancel,
        );
        return;
      }
      const observed = decodeInstitutionalReceipt(
        await this.runtime.gateway.read(pending.command.requestId, cancel),
      );
      this.check(cancel);
      matchInstitutionalReceipt(pending.command, pending.requestHash, observed);
      if (observed.state === 'expired') {
        // A GET may compute expiry without settling the active server row.
        // Only original-operation recover/close confirms a durable expiry receipt.
        this.advance('recover_started');
        await this.apply(
          await this.runtime.gateway.recover(
            pending.command.requestId,
            pending.requestHash,
            cancel,
          ),
          cancel,
        );
        return;
      }
      await this.apply(observed, cancel);
      if (
        this.pending &&
        (this.view.state === 'ready_to_finalize' ||
          (!unstarted(this.pending) &&
            ['prepared', 'processing', 'outcome_unknown'].includes(
              this.view.state,
            )))
      ) {
        this.advance('recover_started');
        const original = this.pending;
        await this.apply(
          await this.runtime.gateway.recover(
            original.command.requestId,
            original.requestHash,
            cancel,
          ),
          cancel,
        );
      }
    });
  }
  async close(): Promise<void> {
    if (this.disposed) return;
    // Cancellation may supersede an in-flight native callback/prepare/HTTP response.
    this.stop();
    if (!this.restore() || !this.pending) return;
    await this.work(async (cancel) => {
      this.advance('cancel');
      const pending = this.pending!;
      await this.apply(
        await this.runtime.gateway.close(
          pending.command.requestId,
          pending.requestHash,
          cancel,
        ),
        cancel,
      );
    });
  }
  stop(): void {
    ++this.generation;
    this.cancellation?.cancel();
    this.cancellation = undefined;
    this.response = undefined;
    this.prepared = null;
    this.update({ busy: false, canAuthorize: false });
  }
  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    this.unsubscribe();
    this.unsubscribePrivate();
    this.pending = null;
    this.view = {
      ...initialInstitutionalView(),
      message: '页面已离开前台。重新进入后先查询原请求。',
    };
    this.render(this.view);
  }
}
