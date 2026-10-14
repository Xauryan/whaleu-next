import { sha256 } from 'js-sha256';
import { ClientError } from '../api/errors';
import { communityError } from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import { Cancellation, type Clock } from '../platform/contracts';
import { systemClock } from '../platform/clock';
import { ratingCategoryScopedJsonByteLength } from './category-scoped-contract';
import { canonicalRatingScopedJson } from './scoped-contract';
import { invalidRating } from './contract';
import {
  ASSISTANCE_BODY_BUDGET,
  assistanceIntentHash,
  decodeAssistanceMetadata,
  decodeAssistanceRequest,
  decodeAssistanceResult,
  matchAssistanceMetadata,
  type AssistanceInput,
  type AssistanceRequest,
  type AvailableAssistanceResult,
} from './assistance-contract';
import type { PendingAssistance } from './assistance-pending';
export interface AssistanceView {
  readonly busy: boolean;
  readonly preview: string;
  readonly status: string;
  readonly requestId: string;
  readonly canRecover: boolean;
  readonly canCancel: boolean;
  readonly canDismiss: boolean;
  readonly canAdopt: boolean;
}
export const initialAssistanceView = (): AssistanceView => ({
  busy: false,
  preview: '',
  status: '',
  requestId: '',
  canRecover: false,
  canCancel: false,
  canDismiss: false,
  canAdopt: false,
});
/** A suggestion is private ephemeral text, never a category/post command or durable draft. */
export class AssistanceController {
  private epoch = 0;
  private revision = 0;
  private draftId: string | null = null;
  private active: AssistanceRequest | null = null;
  private preview: AvailableAssistanceResult | null = null;
  private cancellation: Cancellation | null = null;
  private expiry: (() => void) | null = null;
  private disposed = false;
  private busy = false;
  private readonly unsubscribe: () => void;
  constructor(
    private readonly runtime: CommunityRuntime,
    private readonly render: (view: AssistanceView) => void,
    private readonly editable: () => boolean,
    private readonly clock: Clock = systemClock,
  ) {
    let owner = runtime.sessions.snapshot();
    this.unsubscribe = runtime.sessions.subscribe(() => {
      const next = runtime.sessions.snapshot();
      if (
        next.epoch !== owner.epoch ||
        next.credentials?.accountId !== owner.credentials?.accountId
      ) {
        owner = next;
        this.invalidate();
        this.draftId = null;
        this.show();
      }
    });
  }
  private accountId(): string | null {
    return this.runtime.sessions.snapshot().credentials?.accountId ?? null;
  }
  private pending(): PendingAssistance | null {
    const account = this.accountId();
    return account && this.runtime.pendingAssistance
      ? this.runtime.pendingAssistance.load(account)
      : null;
  }
  private show(status = ''): void {
    if (this.disposed) return;
    let pending: PendingAssistance | null = null;
    try {
      pending = this.pending();
    } catch (error) {
      status = communityError(error);
    }
    this.render({
      busy: this.busy,
      preview: this.preview?.text ?? '',
      status,
      requestId: pending?.requestId ?? '',
      canRecover: !!pending,
      canCancel: !!pending && pending.state !== 'terminal',
      canDismiss: pending?.state === 'terminal',
      canAdopt: !!this.preview && this.editable() && !this.busy,
    });
  }
  /** Called on every draft edit, source/context change, freeze, hide and rebuild. No server cancellation is implied. */
  invalidate(): void {
    this.epoch++;
    this.revision++;
    this.cancellation?.cancel();
    this.cancellation = null;
    this.expiry?.();
    this.expiry = null;
    this.active = null;
    this.preview = null;
    this.busy = false;
    this.show();
  }
  refresh(): void {
    this.show();
  }
  private async run(
    work: (cancel: Cancellation, current: () => void) => Promise<void>,
  ): Promise<void> {
    if (
      this.disposed ||
      this.busy ||
      !this.runtime.assistance ||
      !this.runtime.pendingAssistance ||
      !this.accountId()
    )
      return;
    const owner = this.runtime.sessions.snapshot(),
      epoch = this.epoch,
      cancel = new Cancellation();
    this.cancellation?.cancel();
    this.cancellation = cancel;
    this.busy = true;
    this.show();
    const current = () => {
      this.runtime.sessions.assertCurrent(owner);
      if (this.disposed || epoch !== this.epoch || cancel.isCancelled)
        throw new ClientError('cancelled', 'Assistance draft changed');
    };
    try {
      await work(cancel, current);
      current();
    } catch (error) {
      if (!this.disposed && epoch === this.epoch && !cancel.isCancelled) {
        // A failed current-qualified read cannot leave cached plaintext visible.
        this.preview = null;
        this.active = null;
        this.expiry?.();
        this.expiry = null;
        this.busy = false;
        this.status(communityError(error));
      }
    } finally {
      if (
        !this.disposed &&
        epoch === this.epoch &&
        this.cancellation === cancel
      ) {
        this.busy = false;
        this.cancellation = null;
        this.show(this.lastStatus);
      }
    }
  }
  private lastStatus = '';
  private status(text: string): void {
    this.lastStatus = text;
    this.show(text);
  }
  async generate(input: AssistanceInput): Promise<void> {
    if (!this.editable()) return;
    try {
      if (this.pending()) {
        this.status('请先查询或关闭原建议请求；不会自动换新编号重试');
        return;
      }
    } catch (error) {
      this.status(communityError(error));
      return;
    }
    const revision = this.revision;
    await this.run(async (cancel, current) => {
      const draftId = this.draftId ?? (await this.runtime.newRequestId());
      current();
      const requestId = await this.runtime.newRequestId();
      current();
      if (!this.editable() || revision !== this.revision) return;
      const request = decodeAssistanceRequest({
        ...input,
        version: 1,
        requestId,
        draftId,
        inputRevision: revision,
      });
      if (
        ratingCategoryScopedJsonByteLength(request) > ASSISTANCE_BODY_BUDGET
      ) {
        this.status(
          '完整请求超过 64 KiB 安全预算，尚未保存或发送；不会截断校园范围',
        );
        return;
      }
      const accountId = this.accountId()!,
        intentHash = assistanceIntentHash(request);
      const pending = this.runtime.pendingAssistance!.freeze({
        kind: 'rating_assistance_v1',
        version: 1,
        accountId,
        requestId,
        purpose: request.purpose,
        intentHash,
        draftId,
        inputRevision: revision,
        scopeDigest: sha256(
          canonicalRatingScopedJson({
            selector: request.selector,
            context: request.context,
          }),
        ),
        state: 'unresolved',
        metadata: null,
      });
      this.draftId = draftId;
      this.active = request;
      this.preview = null;
      this.status('建议请求已保存；生成结果不会直接改写草稿');
      const metadata = decodeAssistanceMetadata(
        await this.runtime.assistance!.create(request, cancel),
      );
      current();
      const saved = this.runtime.pendingAssistance!.record(pending, metadata);
      if (metadata.outcome === 'generated')
        await this.readPreview(saved, cancel, current);
      else this.status(this.outcomeText(metadata.outcome));
    });
  }
  private outcomeText(outcome: string): string {
    return outcome === 'unavailable'
      ? '建议服务当前不可用，可以继续手动编辑并发布'
      : outcome === 'cancelled'
        ? '原建议请求已取消；草稿和发布请求未改变'
        : outcome === 'generated'
          ? '原建议已生成；当前草稿已变化，不能自动恢复旧内容'
          : outcome === 'expired'
            ? '原建议已过期，可以关闭后重新发起'
            : outcome === 'rejected'
              ? '原建议未通过校验，可以继续手动编辑'
              : '原建议尚待确认，请用同一编号查询；不会自动重发';
  }
  private checkResult(
    raw: unknown,
    pending: PendingAssistance,
  ): AvailableAssistanceResult | null {
    const result = decodeAssistanceResult(raw),
      active = this.active;
    if (result.status === 'unavailable') return null;
    if (
      !active ||
      result.actorId !== this.accountId() ||
      result.requestId !== active.requestId ||
      result.purpose !== active.purpose ||
      result.draftId !== active.draftId ||
      result.inputRevision !== active.inputRevision ||
      result.inputRevision !== this.revision ||
      result.intentHash !== pending.intentHash ||
      result.intentHash !== assistanceIntentHash(active) ||
      Date.parse(result.expiresAt) <= this.clock.now() ||
      !this.editable()
    )
      invalidRating();
    return result;
  }
  private async readPreview(
    pending: PendingAssistance,
    cancel: Cancellation,
    current: () => void,
  ): Promise<void> {
    if (
      !this.active ||
      this.active.requestId !== pending.requestId ||
      !this.editable()
    ) {
      this.status(this.outcomeText('generated'));
      return;
    }
    const result = await this.runtime.assistance!.result(
      pending.requestId,
      cancel,
    );
    current();
    this.preview = this.checkResult(result, pending);
    if (this.preview) {
      this.expiry?.();
      this.expiry = this.clock.schedule(
        () => this.invalidate(),
        Date.parse(this.preview.expiresAt) - this.clock.now(),
      );
      this.status('仅供参考。采用前会重新核验，采用后仍可编辑，发布需另行确认');
    } else this.status('建议当前不可用或已失效，原结果不会覆盖草稿');
  }
  async recover(): Promise<void> {
    await this.run(async (cancel, current) => {
      const pending = this.pending();
      if (!pending) return;
      const metadata = decodeAssistanceMetadata(
        await this.runtime.assistance!.status(pending.requestId, cancel),
      );
      current();
      matchAssistanceMetadata(pending, metadata);
      const saved = this.runtime.pendingAssistance!.record(pending, metadata);
      if (metadata.outcome === 'generated')
        await this.readPreview(saved, cancel, current);
      else this.status(this.outcomeText(metadata.outcome));
    });
  }
  async adopt(apply: (text: string) => void): Promise<void> {
    const before = this.preview;
    if (!before || !this.editable()) return;
    await this.run(async (cancel, current) => {
      const pending = this.pending();
      if (!pending) return;
      const raw = await this.runtime.assistance!.result(
        pending.requestId,
        cancel,
      );
      current();
      const fresh = this.checkResult(raw, pending);
      if (
        !fresh ||
        canonicalRatingScopedJson(fresh) !== canonicalRatingScopedJson(before)
      ) {
        this.preview = null;
        this.status('建议版本或权限已变化，请重新核验');
        return;
      }
      // Consume before invoking the editable destination; the callback may invalidate this owner.
      this.runtime.pendingAssistance!.dismiss(pending);
      this.preview = null;
      this.active = null;
      this.expiry?.();
      this.expiry = null;
      this.status('建议已采用，仍需核对并单独确认发布');
      apply(fresh.text);
    });
  }
  async cancel(): Promise<void> {
    this.invalidate();
    await this.run(async (cancel, current) => {
      let pending = this.pending();
      if (!pending) return;
      pending = this.runtime.pendingAssistance!.requestCancel(pending);
      const metadata = decodeAssistanceMetadata(
        await this.runtime.assistance!.cancel(pending, cancel),
      );
      current();
      this.runtime.pendingAssistance!.record(pending, metadata);
      this.status(this.outcomeText(metadata.outcome));
    });
  }
  dismiss(): void {
    try {
      const pending = this.pending();
      if (!pending) return;
      this.runtime.pendingAssistance!.dismiss(pending);
      this.invalidate();
      this.status('已关闭此建议；未更改发布状态');
    } catch (error) {
      this.status(communityError(error));
    }
  }
  dispose(): void {
    if (this.disposed) return;
    this.invalidate();
    this.disposed = true;
    this.unsubscribe();
  }
}
