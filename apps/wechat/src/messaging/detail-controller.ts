import { ClientError } from '../api/errors';
import type { Cancellation } from '../platform/contracts';
import { dispatch } from './commands';
import {
  baseView,
  MessagingController,
  type BaseView,
  type Render,
} from './controller';
import {
  compareSequence,
  decodeEntry,
  id,
  invalid,
  normalizeText,
  type Conversation,
  type Coverage,
  type Entry,
  type History,
  type Message,
  type Mode,
  type Receipt,
} from './contract';
import { reason } from './errors';
import type { MessagingRuntime } from './runtime';
export type DetailRoute =
  | { readonly conversationId: string }
  | { readonly entry: Entry; readonly initiationMode: Mode };
export type Confirmation =
  | { readonly kind: 'hide' | 'reopen' | 'block'; readonly description: string }
  | {
      readonly kind: 'recall';
      readonly messageId: string;
      readonly description: string;
    };
export interface DetailView extends BaseView {
  readonly confirmedConversationId: string | null;
  readonly conversation: Conversation | null;
  readonly messages: readonly Message[];
  readonly coverage: Coverage | null;
  readonly text: string;
  readonly canSend: boolean;
  readonly canMore: boolean;
  readonly anchor: string;
  readonly confirm: Confirmation | null;
  readonly needsOpen: boolean;
  readonly openingMode: Mode;
  readonly canReedit: boolean;
  readonly sendReason: string;
  readonly browsingOlder: boolean;
  readonly hasNewMessages: boolean;
}
export const initialDetailView = (): DetailView => ({
  ...baseView(),
  confirmedConversationId: null,
  conversation: null,
  messages: [],
  coverage: null,
  text: '',
  canSend: false,
  canMore: false,
  anchor: '',
  confirm: null,
  needsOpen: false,
  openingMode: 'named',
  canReedit: false,
  sendReason: '',
  browsingOlder: false,
  hasNewMessages: false,
});
const sorted = (items: readonly Message[]): readonly Message[] =>
  [...new Map(items.map((m) => [m.id, m])).values()]
    .sort((a, b) => compareSequence(a.sequence, b.sequence))
    .slice(-200);
const sendReason = (conversation: Conversation): string =>
  conversation.sendAvailability === 'awaiting_reply'
    ? reason('DM_FIRST_CONTACT_LIMIT')
    : conversation.sendAvailability === 'blocked_by_you'
      ? '你已屏蔽；当前会话不能继续发送'
      : conversation.sendAvailability === 'unavailable'
        ? reason('DM_SEND_UNAVAILABLE')
        : '对方回复前仅可发送一条消息；撤回和隐藏不会恢复额度';
export class MessagingDetailController extends MessagingController<DetailView> {
  private readonly route: DetailRoute;
  private conversationId: string | null = null;
  private nextHistory: string | null = null;
  private historyStarts: (string | null)[] = [null];
  private eventCursor: string | null = null;
  private reeditText: string | null = null;
  private dialogRevision = 0;
  private observed: string | null = null;
  private observedSequence = '0';
  private acknowledgedSequence = '0';
  private visibleSequence = '0';
  constructor(
    runtime: MessagingRuntime,
    route: DetailRoute,
    render: Render<DetailView>,
  ) {
    super(runtime, initialDetailView, render);
    if ('conversationId' in route) {
      if (!id(route.conversationId)) invalid();
      this.route = Object.freeze({ conversationId: route.conversationId });
      this.conversationId = route.conversationId;
    } else {
      if (
        route.initiationMode !== 'named' &&
        route.initiationMode !== 'anonymous'
      )
        invalid();
      this.route = Object.freeze({
        entry: decodeEntry(route.entry),
        initiationMode: route.initiationMode,
      });
      this.update({
        needsOpen: true,
        openingMode: route.initiationMode,
        status: '请确认本次私信使用的身份',
      });
    }
  }
  protected override invalidated(): void {
    void this.load();
  }
  protected override clearPrivate(): void {
    this.nextHistory = null;
    this.historyStarts = [null];
    this.eventCursor = null;
    this.reeditText = null;
    this.observed = null;
    this.observedSequence = '0';
    this.acknowledgedSequence = '0';
    this.visibleSequence = '0';
    this.dialogRevision++;
  }
  async load(): Promise<void> {
    if (!this.conversationId) return;
    await this.run(async (cancel, current) => {
      await this.refresh(cancel, current);
    });
    this.schedule(() => this.load(), 3000);
  }
  private async refresh(
    cancel: Cancellation,
    current: () => void,
  ): Promise<void> {
    const conversationId = this.conversationId!;
    try {
      const conversation = await this.runtime.gateway!.conversation(
        conversationId,
        cancel,
      );
      current();
      let all: Message[] = [];
      let newest: History | null = null;
      let next: string | null = this.historyStarts[0] ?? null;
      const starts: (string | null)[] = [];
      const pageCount = this.historyStarts.length;
      for (let index = 0; index < pageCount; index++) {
        const start = next;
        const page = await this.runtime.gateway!.history(
          conversationId,
          start,
          cancel,
        );
        current();
        if (index === 0) newest = page;
        if (page.nextCursor === start && start !== null) invalid();
        starts.push(start);
        all.push(...page.items);
        next = page.nextCursor;
        if (next === null) break;
      }
      if (!newest) invalid();
      this.historyStarts = starts;
      this.nextHistory = next;
      if (this.eventCursor === null) this.eventCursor = newest.eventCursor;
      const browsingOlder = starts[0] !== null;
      let hasNewMessages = this.view.hasNewMessages;
      let hasMore = false;
      let observation = newest.observationId;
      let throughSequence = newest.throughSequence;
      for (let i = 0; i < 3; i++) {
        const previous: string = this.eventCursor!;
        const page = await this.runtime.gateway!.events(
          conversationId,
          previous,
          cancel,
        );
        current();
        if (page.items.length && page.nextCursor === previous) invalid();
        const known = new Set(all.map((message) => message.id));
        const ordered = sorted(all);
        const highest = ordered[ordered.length - 1]?.sequence ?? '0';
        if (
          browsingOlder &&
          page.items.some(
            (event) =>
              event.kind === 'sent' &&
              compareSequence(event.message.sequence, highest) > 0,
          )
        )
          hasNewMessages = true;
        all = [
          ...sorted([
            ...all,
            ...page.items
              .filter((event) => !browsingOlder || known.has(event.message.id))
              .map((e) => e.message),
          ]),
        ];
        this.eventCursor = page.nextCursor;
        hasMore = page.hasMore;
        if (
          !browsingOlder &&
          compareSequence(page.throughSequence, throughSequence) > 0
        ) {
          observation = page.observationId;
          throughSequence = page.throughSequence;
        }
        if (!hasMore) break;
      }
      this.observed = hasMore ? null : observation;
      this.observedSequence = throughSequence;
      const pending = this.pending();
      const messages = sorted(all);
      const anchor = this.view.loaded
        ? this.view.anchor
        : messages.length
          ? `message-${messages[messages.length - 1]!.id}`
          : '';
      await this.rendered(
        {
          conversation,
          messages,
          anchor,
          browsingOlder,
          hasNewMessages,
          coverage: newest.coverage,
          loaded: true,
          canMore: !!this.nextHistory,
          canSend:
            conversation.sendAvailability === 'available' &&
            !pending &&
            !conversation.hidden,
          pending,
          sendReason: sendReason(conversation),
          status: hasMore
            ? '正在分批读取新事件；尚未越过未读取事件'
            : '已更新当前可查看的消息',
        },
        cancel,
        current,
      );
      current();
      await this.acknowledge(cancel, current);
    } catch (error) {
      current();
      this.update({
        conversation: null,
        messages: [],
        loaded: false,
        canSend: false,
        canMore: false,
        confirm: null,
      });
      this.dialogRevision++;
      throw error;
    }
  }
  private async acknowledge(
    cancel: Cancellation,
    current: () => void,
  ): Promise<void> {
    const observationId = this.observed;
    if (
      !observationId ||
      compareSequence(this.observedSequence, this.acknowledgedSequence) <= 0 ||
      compareSequence(this.observedSequence, this.visibleSequence) > 0 ||
      this.pending()
    )
      return;
    const clientRequestId = await this.runtime.newRequestId();
    current();
    if (observationId !== this.observed) return;
    const receipt = await dispatch(
      this.runtime,
      {
        operation: 'read',
        conversationId: this.conversationId!,
        clientRequestId,
        observationId,
      },
      cancel,
      current,
    );
    current();
    if (receipt.outcome !== 'rejected')
      this.acknowledgedSequence = this.observedSequence;
  }
  async open(): Promise<void> {
    if (!this.view.needsOpen || !('entry' in this.route)) return;
    const route = this.route;
    await this.run(async (cancel, current) => {
      if (this.pending())
        throw new ClientError('business', '请先到恢复页处理原私信请求');
      const clientRequestId = await this.runtime.newRequestId();
      current();
      const receipt = await dispatch(
        this.runtime,
        {
          operation: 'open',
          clientRequestId,
          entry: route.entry,
          initiationMode: route.initiationMode,
        },
        cancel,
        current,
      );
      current();
      if (receipt.outcome === 'rejected') {
        this.update({ status: reason(receipt.code) });
        return;
      }
      this.conversationId = receipt.conversationId;
      // Preserve the confirmed body-free route before any current-view fetch can fail.
      this.update({
        needsOpen: false,
        confirmedConversationId: receipt.conversationId,
      });
      await this.refresh(cancel, current);
    });
    if (this.conversationId) this.schedule(() => this.load(), 3000);
  }
  observeMessage(messageId: string): void {
    if (!this.active || !this.account()) return;
    const message = this.view.messages.find((m) => m.id === messageId);
    if (message && compareSequence(message.sequence, this.visibleSequence) > 0)
      this.visibleSequence = message.sequence;
  }
  setText(raw: string): void {
    if (!this.active || this.view.busy || this.view.pending) return;
    this.update({ text: raw });
  }
  async send(): Promise<void> {
    if (
      !this.view.canSend ||
      this.view.pending ||
      this.view.busy ||
      !this.conversationId
    )
      return;
    let text: string;
    try {
      text = normalizeText(this.view.text);
    } catch (error) {
      this.update({
        error: error instanceof Error ? error.message : '文字格式不正确',
      });
      return;
    }
    await this.run(async (cancel, current) => {
      const clientRequestId = await this.runtime.newRequestId();
      current();
      const receipt = await dispatch(
        this.runtime,
        {
          operation: 'send',
          conversationId: this.conversationId!,
          clientRequestId,
          text,
        },
        cancel,
        current,
      );
      current();
      if (receipt.outcome === 'rejected') {
        this.update({ text, status: reason(receipt.code) });
        return;
      }
      this.update({ text: '', status: '已发送，正在重新读取可查看内容' });
      await this.refresh(cancel, current);
    });
    this.schedule(() => this.load(), 3000);
  }
  async more(): Promise<void> {
    if (!this.nextHistory || this.view.busy) return;
    const cursor = this.nextHistory;
    await this.run(async (cancel, current) => {
      const anchor = this.view.messages[0]?.id;
      if (this.historyStarts.includes(cursor)) invalid();
      const enteringOlder =
        this.historyStarts.length === 1 && this.historyStarts[0] === null;
      this.historyStarts = enteringOlder
        ? [cursor]
        : [...this.historyStarts, cursor].slice(-4);
      this.update({
        anchor: enteringOlder ? '' : anchor ? `message-${anchor}` : '',
        ...(enteringOlder ? { loaded: false } : {}),
      });
      await this.refresh(cancel, current);
      current();
      this.update({
        status: '已载入更早消息；当前最多保留四页，可继续向前翻阅',
      });
    });
    this.schedule(() => this.load(), 3000);
  }
  async latest(): Promise<void> {
    if (this.view.busy) return;
    this.historyStarts = [null];
    this.nextHistory = null;
    this.eventCursor = null;
    this.update({
      loaded: false,
      anchor: '',
      hasNewMessages: false,
      browsingOlder: false,
    });
    await this.load();
  }
  request(
    kind: 'hide' | 'reopen' | 'block' | 'recall',
    messageId?: string,
  ): void {
    if (this.view.busy || this.view.pending || !this.view.conversation) return;
    const conversation = this.view.conversation;
    this.dialogRevision++;
    if (kind === 'recall') {
      const message = this.view.messages.find((m) => m.id === messageId);
      if (
        !message ||
        message.sender !== 'self' ||
        message.state === 'recalled' ||
        !message.canRecall
      )
        return;
      this.update({
        confirm: {
          kind,
          messageId: message.id,
          description:
            '撤回仅限发送后 120 秒内，以服务端时间为准。撤回不会恢复首条消息额度。',
        },
      });
      return;
    }
    if (kind === 'block' && conversation.blockedByYou) return;
    const description =
      kind === 'hide'
        ? '从你的列表隐藏此会话并清除当前未读，历史不会删除；新消息可能让会话重新出现。'
        : kind === 'reopen'
          ? '重新显示此会话；不会恢复已屏蔽会话的发送权限。'
          : conversation.blockScope === 'named'
            ? '拉黑此公开身份用户，双方都不能继续发送；可到屏蔽列表解除。'
            : conversation.blockScope === 'named_and_conversation'
              ? '拉黑此公开身份用户，同时屏蔽此私信会话，双方都不能继续发送。解除用户拉黑也不会解除本会话屏蔽。'
              : '屏蔽此私信会话，双方都不能继续发送；此会话屏蔽暂不支持解除。';
    this.update({ confirm: { kind, description } });
  }
  dismiss(): void {
    this.dialogRevision++;
    this.update({ confirm: null });
  }
  async confirm(): Promise<void> {
    const confirm = this.view.confirm,
      revision = this.dialogRevision;
    if (!confirm || this.view.busy || this.view.pending) return;
    await this.run(async (cancel, current) => {
      const clientRequestId = await this.runtime.newRequestId();
      current();
      if (revision !== this.dialogRevision || this.view.confirm !== confirm)
        return;
      const original =
        confirm.kind === 'recall'
          ? this.view.messages.find((m) => m.id === confirm.messageId)?.text
          : null;
      const receipt: Receipt = await dispatch(
        this.runtime,
        confirm.kind === 'recall'
          ? {
              operation: 'recall',
              conversationId: this.conversationId!,
              messageId: confirm.messageId,
              clientRequestId,
            }
          : {
              operation: confirm.kind,
              conversationId: this.conversationId!,
              clientRequestId,
            },
        cancel,
        current,
      );
      current();
      this.dismiss();
      if (receipt.outcome === 'rejected') {
        this.update({ status: reason(receipt.code) });
        return;
      }
      if (confirm.kind === 'recall' && original) {
        this.reeditText = original;
        this.update({ canReedit: true });
      }
      await this.refresh(cancel, current);
    });
    this.schedule(() => this.load(), 3000);
  }
  copyText(messageId: string): string | null {
    if (!this.active || this.view.busy || !this.account()) return null;
    const message = this.view.messages.find((m) => m.id === messageId);
    return message?.state === 'text' ? message.text : null;
  }
  reedit(): void {
    if (this.view.busy || this.view.pending || !this.reeditText) return;
    this.update({
      text: this.reeditText,
      canReedit: false,
      status: '已复制到新草稿；再次发送会创建新的审核请求',
    });
    this.reeditText = null;
  }
  profilePath(): string | null {
    const peer = this.view.conversation?.peer;
    return this.active &&
      !this.view.busy &&
      peer?.mode === 'named' &&
      peer.profileId
      ? `/pages/public-profile/public-profile?profileId=${peer.profileId}`
      : null;
  }
  sourcePath(): string | null {
    const source = this.view.conversation?.source;
    return this.active && !this.view.busy && source?.available
      ? `/pages/community-detail/community-detail?postId=${source.postId}`
      : null;
  }
  override cancel(): void {
    this.dismiss();
    super.cancel();
    if (this.view.pending) this.update({ canSend: false });
  }
}
