import { ClientError } from '../api/errors';
import { cancelPending, dispatch, recover } from './commands';
import {
  baseView,
  MessagingController,
  type BaseView,
  type Render,
} from './controller';
import { reason } from './errors';
import { normalizeText, type Intent, type Receipt } from './contract';
import type { Pending } from './pending';
import type { MessagingRuntime } from './runtime';
export interface RecoveryView extends BaseView {
  readonly operation: string;
  readonly requestId: string;
  readonly pendingText: string;
  readonly conversationId: string;
  readonly outcome: string;
  readonly canRetry: boolean;
  readonly confirmCancel: boolean;
  readonly canReedit: boolean;
  readonly editing: boolean;
  readonly draftText: string;
}
export const initialRecoveryView = (): RecoveryView => ({
  ...baseView(),
  operation: '',
  requestId: '',
  pendingText: '',
  conversationId: '',
  outcome: '',
  canRetry: false,
  confirmCancel: false,
  canReedit: false,
  editing: false,
  draftText: '',
});
export class MessagingRecoveryController extends MessagingController<RecoveryView> {
  private attempt: Pending | null = null;
  private dialogRevision = 0;
  private rejectedDraft: {
    readonly conversationId: string;
    readonly text: string;
  } | null = null;
  constructor(runtime: MessagingRuntime, render: Render<RecoveryView>) {
    super(runtime, initialRecoveryView, render);
  }
  protected override invalidated(): void {
    this.load();
  }
  protected override clearPrivate(): void {
    this.attempt = null;
    this.rejectedDraft = null;
    this.dialogRevision++;
  }
  load(): void {
    if (!this.available()) return;
    try {
      this.attempt = this.runtime.pending.load(this.account()!);
      this.rejectedDraft = null;
      const attempt = this.attempt,
        intent = attempt?.intent;
      this.update({
        loaded: true,
        pending: !!attempt,
        operation: attempt?.operation ?? '',
        requestId: attempt?.requestId ?? '',
        pendingText: intent?.operation === 'send' ? intent.text : '',
        conversationId:
          intent && intent.operation !== 'open' ? intent.conversationId : '',
        canRetry: !!intent,
        confirmCancel: false,
        canReedit: false,
        editing: false,
        draftText: '',
        status: attempt
          ? intent
            ? '下面是原请求；查询不代表重新发送。重试始终使用相同编号和原文。'
            : '原文已在退出登录或切换账号时清除；原请求编号仍保留。只能查询回执或安全取消，不能重建原文重试。'
          : '当前账号没有待确认私信请求',
      });
    } catch {
      this.update({ error: '无法读取本地恢复记录，已停止操作' });
    }
  }
  private settled(
    receipt: Receipt,
    original: Intent | null | undefined = this.attempt?.intent,
    retainRejectedDraft = true,
  ): void {
    this.rejectedDraft =
      retainRejectedDraft &&
      receipt.outcome === 'rejected' &&
      receipt.code !== 'DM_COMMAND_CANCELLED' &&
      original?.operation === 'send'
        ? { conversationId: original.conversationId, text: original.text }
        : null;
    this.attempt = null;
    this.dialogRevision++;
    this.update({
      pending: false,
      pendingText: '',
      canRetry: false,
      confirmCancel: false,
      operation: receipt.operation,
      requestId: receipt.requestId,
      canReedit: !!this.rejectedDraft,
      editing: false,
      draftText: '',
      outcome:
        receipt.outcome === 'rejected'
          ? reason(receipt.code)
          : '原请求已确认；当前权限与会话状态须重新加载',
      conversationId:
        receipt.outcome === 'rejected'
          ? (this.rejectedDraft?.conversationId ?? '')
          : receipt.conversationId,
      status: '恢复完成',
    });
  }
  async recover(retry = false): Promise<void> {
    const attempt = this.attempt;
    if (!attempt || this.view.confirmCancel || (retry && !attempt.intent))
      return;
    await this.run(async (cancel, current) => {
      const receipt = await recover(
        this.runtime,
        attempt,
        retry,
        cancel,
        current,
      );
      current();
      this.settled(receipt);
    });
  }
  reedit(): void {
    if (
      !this.active ||
      !this.account() ||
      this.view.busy ||
      this.view.pending ||
      !this.rejectedDraft
    )
      return;
    this.update({
      canReedit: false,
      editing: true,
      draftText: this.rejectedDraft.text,
      status: '原请求已终结；这是新的临时草稿，发送时将使用新编号并重新审核',
    });
  }
  setDraftText(text: string): void {
    if (
      !this.active ||
      !this.view.editing ||
      this.view.busy ||
      this.view.pending
    )
      return;
    this.update({ draftText: text });
  }
  discardDraft(): void {
    if (this.view.busy) return;
    this.rejectedDraft = null;
    this.update({ canReedit: false, editing: false, draftText: '' });
  }
  async sendDraft(): Promise<void> {
    const draft = this.rejectedDraft;
    if (!draft || !this.view.editing || this.view.busy || this.view.pending)
      return;
    let text: string;
    try {
      text = normalizeText(this.view.draftText);
    } catch (error) {
      this.update({
        error: error instanceof Error ? error.message : '文字格式不正确',
      });
      return;
    }
    await this.run(async (cancel, current) => {
      if (this.pending())
        throw new ClientError('business', '请先处理原私信请求');
      const conversation = await this.runtime.gateway!.conversation(
        draft.conversationId,
        cancel,
      );
      current();
      if (conversation.hidden || conversation.sendAvailability !== 'available')
        throw new ClientError(
          'business',
          reason(
            conversation.sendAvailability === 'awaiting_reply'
              ? 'DM_FIRST_CONTACT_LIMIT'
              : 'DM_SEND_UNAVAILABLE',
          ),
        );
      const clientRequestId = await this.runtime.newRequestId();
      current();
      if (draft !== this.rejectedDraft || !this.view.editing) return;
      if (clientRequestId === this.view.requestId)
        throw new ClientError('protocol', '新草稿必须使用新的请求编号');
      const intent: Intent = {
        operation: 'send',
        conversationId: draft.conversationId,
        clientRequestId,
        text,
      };
      try {
        const receipt = await dispatch(this.runtime, intent, cancel, current);
        current();
        this.settled(receipt, intent);
      } catch (error) {
        current();
        // An uncertain new send is now the immutable original, never an editable retry.
        if (this.pending()) this.load();
        throw error;
      }
    });
  }
  requestCancel(): void {
    if (!this.attempt || this.view.busy) return;
    this.dialogRevision++;
    this.update({ confirmCancel: true });
  }
  dismissCancel(): void {
    this.dialogRevision++;
    this.update({ confirmCancel: false });
  }
  async confirmCancel(): Promise<void> {
    const attempt = this.attempt,
      revision = this.dialogRevision;
    if (!attempt || !this.view.confirmCancel || this.view.busy) return;
    await this.run(async (cancel, current) => {
      current();
      if (revision !== this.dialogRevision || !this.view.confirmCancel) return;
      const result = await cancelPending(
        this.runtime,
        attempt,
        cancel,
        current,
      );
      current();
      this.settled(result.receipt, this.attempt?.intent, false);
      this.update({
        status:
          result.outcome === 'cancelled'
            ? '原请求已安全取消'
            : result.receipt.outcome !== 'rejected' &&
                result.receipt.operation === 'send'
              ? '原发送已完成，无法取消；请重新读取会话确认'
              : '原请求已经终结，无法再次取消',
        outcome:
          result.receipt.outcome === 'rejected'
            ? reason(result.receipt.code)
            : result.receipt.operation === 'send'
              ? '原发送已完成，无法取消；可打开会话查看当前可见消息'
              : '原操作已完成，无法通过取消请求撤销',
      });
    });
  }
  override cancel(): void {
    this.dismissCancel();
    super.cancel();
    if (this.active && this.account()) {
      try {
        if (this.pending()) this.load();
      } catch {
        this.update({ error: '无法读取本地恢复记录，已停止操作' });
      }
    }
  }
}
