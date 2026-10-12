import { systemClock } from '../platform/clock';
import { clientError } from '../api/errors';
import {
  CommunityController,
  communityError,
  initialCommunityView,
} from '../community/controller';
import type { CommunityView } from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import {
  decodePinPage,
  decodePinDetail,
  decodePinSlot,
  decodePinCommand,
  matchPinReceipt,
} from './contract';
import type {
  PinQuery,
  PinPage,
  PinDetail,
  PinSlot,
  PinCommand,
  PinReceipt,
} from './contract';
import type { PendingPin } from './pending';
export interface PinFeedView extends CommunityView {
  item: PinPage['items'][number] | null;
  collapsed: boolean;
  confirmDismiss: boolean;
  loaded: boolean;
}
export const initialPinFeedView = (): PinFeedView => ({
  ...initialCommunityView(),
  item: null,
  collapsed: false,
  confirmDismiss: false,
  loaded: false,
});
export class PinFeedController extends CommunityController<PinFeedView> {
  private expire: (() => void) | undefined;
  constructor(runtime: CommunityRuntime, render: (view: PinFeedView) => void) {
    super(runtime, initialPinFeedView, render);
  }
  protected override resetPrivate() {
    this.expire?.();
    this.expire = undefined;
  }
  clear() {
    this.stop();
    this.resetPrivate();
    this.update({
      busy: false,
      item: null,
      collapsed: false,
      confirmDismiss: false,
      loaded: false,
      error: '',
    });
  }
  async load(query: PinQuery) {
    this.clear();
    if (!this.available(false) || !this.runtime.postPins) return;
    await this.run(
      (cancel) => this.runtime.postPins!.list(query, cancel),
      (raw) => {
        const result = decodePinPage(raw);
        const item = result.items[0] ?? null;
        const dismissed =
          item &&
          this.runtime.pendingPostPins?.dismissed(
            this.accountId(),
            item.pin.pinId,
          );
        if (item && Date.parse(item.pin.pinnedUntil) <= systemClock.now())
          return;
        this.update({
          item: dismissed ? null : item,
          collapsed: item?.pin.readState === 'read',
          loaded: true,
          status: result.status === 'unavailable' ? '置顶范围或历史待核验' : '',
        });
        if (item && !dismissed)
          this.expire = systemClock.schedule(
            () => this.clear(),
            Math.max(1, Date.parse(item.pin.pinnedUntil) - systemClock.now()),
          );
      },
      () => {
        this.clear();
        this.update({ error: '置顶暂不可用，普通帖子仍可浏览' });
      },
    );
  }
  expand() {
    if (this.view.item) this.update({ collapsed: false });
  }
  dismiss() {
    if (!this.view.item || this.view.busy) return;
    if (this.view.item.pin.readState !== 'read') {
      this.update({ confirmDismiss: true });
      return;
    }
    this.confirmDismiss();
  }
  closeDismiss() {
    this.update({ confirmDismiss: false });
  }
  confirmDismiss() {
    const item = this.view.item;
    if (!item || !this.runtime.pendingPostPins) return;
    try {
      this.runtime.pendingPostPins.dismiss(this.accountId(), item.pin.pinId);
      this.clear();
    } catch (error) {
      this.update({ error: communityError(error) });
    }
  }
  route(): string | null {
    const item = this.view.item;
    if (
      !item ||
      Date.parse(item.pin.pinnedUntil) <= systemClock.now() ||
      !this.accountId()
    )
      return null;
    return `/pages/community-detail/community-detail?postId=${item.post.id}`;
  }
}
export interface PinDetailView extends CommunityView {
  detail: PinDetail | null;
  slot: PinSlot | null;
  loaded: boolean;
  frozen: boolean;
  confirming: 'pin' | 'unpin' | 'cancel' | null;
  durationHours: number;
  level: 1 | 2;
  pendingPostId: string;
  pendingOperation: string;
  pendingPhase: string;
  receiptStatus: string;
}
export const initialPinDetailView = (): PinDetailView => ({
  ...initialCommunityView(),
  detail: null,
  slot: null,
  loaded: false,
  frozen: false,
  confirming: null,
  durationHours: 24,
  level: 2,
  pendingPostId: '',
  pendingOperation: '',
  pendingPhase: '',
  receiptStatus: '',
});
export class PinDetailController extends CommunityController<PinDetailView> {
  private pending: PendingPin | null = null;
  private mutation: object | null = null;
  private postId: string | null = null;
  private slotSpaceId: string | null = null;
  private expire: (() => void) | undefined;
  constructor(
    runtime: CommunityRuntime,
    render: (view: PinDetailView) => void,
    private readonly onSettled: () => void = () => undefined,
  ) {
    super(runtime, initialPinDetailView, render);
  }
  protected override resetPrivate() {
    this.pending = null;
    this.mutation = null;
    this.expire?.();
    this.expire = undefined;
    this.postId = null;
    this.slotSpaceId = null;
  }
  protected override onSafetyInvalidated(previous: PinDetailView) {
    this.loadRecovery();
    if (!this.view.frozen && previous.receiptStatus)
      this.update({ receiptStatus: previous.receiptStatus });
  }
  clear() {
    // Content refresh/404 must not cancel independent receipt recovery.
    // Account, Safety and root lifecycle still cancel through the base owner.
    if (!this.mutation) this.stop();
    this.expire?.();
    this.expire = undefined;
    this.postId = null;
    this.slotSpaceId = null;
    this.update({
      ...(this.mutation ? {} : { busy: false }),
      detail: null,
      slot: null,
      loaded: false,
      confirming: null,
    });
  }
  loadRecovery(): void {
    if (this.available()) this.restore();
  }
  private restore(): boolean {
    const account = this.accountId();
    if (!account || !this.runtime.pendingPostPins) return false;
    try {
      this.pending = this.runtime.pendingPostPins.load(account);
      this.update({
        frozen: !!this.pending,
        pendingPostId: this.pending?.command.postId ?? '',
        pendingOperation: this.pending?.command.operation ?? '',
        pendingPhase: this.pending?.phase ?? '',
      });
      return true;
    } catch (error) {
      this.update({ frozen: true, error: communityError(error) });
      return false;
    }
  }
  async loadSlot(spaceId: string) {
    this.clear();
    this.slotSpaceId = spaceId;
    if (this.mutation || !this.available() || !this.runtime.postPins) return;
    this.restore();
    await this.run(
      (cancel) => this.runtime.postPins!.slot(spaceId, cancel),
      (raw) => {
        const slot = decodePinSlot(raw);
        this.update({
          slot,
          loaded: true,
          status: slot.status === 'unavailable' ? '置顶范围或历史待核验' : '',
        });
        if (slot.pin)
          this.expire = systemClock.schedule(
            () => {
              this.clear();
              this.update({ status: '置顶已到期，请刷新管理状态' });
            },
            Math.max(1, Date.parse(slot.pin.pinnedUntil) - systemClock.now()),
          );
      },
      (error) => {
        if (
          error.details.serverCode === 'AUTHORIZATION_REQUIRED' &&
          error.details.httpStatus === 403
        )
          this.update({ slot: null, loaded: true, error: '', status: '' });
      },
    );
  }
  async load(postId: string, autoRead = true) {
    this.clear();
    this.postId = postId;
    if (this.mutation) return;
    if (!this.available() || !this.runtime.postPins) return;
    const storageReady = this.restore();
    let readable = false;
    await this.run(
      (cancel) => this.runtime.postPins!.detail(postId, cancel),
      (raw) => {
        const detail = decodePinDetail(raw);
        this.update({
          detail,
          loaded: true,
          status: detail.status === 'unavailable' ? '置顶范围或历史待核验' : '',
        });
        readable =
          storageReady && !this.pending && detail.pin?.readState === 'unread';
        if (detail.pin)
          this.expire = systemClock.schedule(
            () => {
              this.clear();
              this.update({ status: '置顶已到期，请刷新核验' });
            },
            Math.max(1, Date.parse(detail.pin.pinnedUntil) - systemClock.now()),
          );
      },
      () => this.update({ detail: null, loaded: false }),
    );
    if (readable && autoRead && this.postId === postId && !this.view.busy)
      await this.start('read');
  }
  confirm(operation: 'pin' | 'unpin') {
    if (
      this.view.busy ||
      !this.restore() ||
      this.pending ||
      !(operation === 'pin'
        ? this.view.detail?.canPin
        : this.view.detail?.canUnpin || this.view.slot?.canUnpin)
    )
      return;
    this.update({ confirming: operation });
  }
  closeConfirmation() {
    if (!this.view.busy) this.update({ confirming: null });
  }
  duration(value: string) {
    if (
      this.view.busy ||
      this.view.frozen ||
      this.view.confirming !== 'pin' ||
      !/^\d{1,3}$/.test(value)
    )
      return;
    const hours = Number(value);
    if (hours >= 1 && hours <= 168) this.update({ durationHours: hours });
  }
  level(value: string) {
    if (
      !this.view.busy &&
      !this.view.frozen &&
      this.view.confirming === 'pin' &&
      (value === '1' || value === '2')
    )
      this.update({ level: Number(value) as 1 | 2 });
  }
  async submit() {
    const kind = this.view.confirming;
    if (kind === 'pin' || kind === 'unpin') await this.start(kind);
  }
  private async mutate(
    work: (
      cancel: import('../platform/contracts').Cancellation,
    ) => Promise<PinReceipt>,
    apply: (receipt: PinReceipt) => void,
    onError: () => void,
  ): Promise<void> {
    const ticket = {};
    this.mutation = ticket;
    try {
      await this.run(work, apply, onError);
    } finally {
      if (this.mutation === ticket) this.mutation = null;
    }
  }
  private async start(operation: PinCommand['operation']) {
    if (
      this.view.busy ||
      !this.available() ||
      !this.runtime.postPins ||
      !this.runtime.pendingPostPins ||
      !this.restore() ||
      this.pending ||
      (!this.view.detail && !this.view.slot)
    )
      return;
    const detail = this.view.detail,
      slot = this.view.slot,
      postId = this.postId ?? slot?.pin?.postId,
      pinId = detail?.pin?.pinId ?? slot?.pin?.pinId;
    if (
      !postId ||
      (operation === 'pin'
        ? !detail?.canPin
        : operation === 'unpin'
          ? !(detail?.canUnpin || slot?.canUnpin) || !pinId
          : !detail?.pin || detail.pin.readState !== 'unread')
    )
      return;
    const account = this.accountId()!,
      owner = this.owner,
      hours = this.view.durationHours,
      level = this.view.level;
    let applied = false;
    await this.mutate(
      async (cancel) => {
        const clientRequestId = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        if (cancel.isCancelled)
          throw new Error('Pin command cancelled before persistence');
        const command = decodePinCommand(
          operation === 'pin'
            ? {
                clientRequestId,
                postId,
                operation,
                durationHours: hours,
                level,
              }
            : { clientRequestId, postId, operation, pinId: pinId! },
        );
        this.pending = this.runtime.pendingPostPins!.freeze({
          version: 1,
          accountId: account,
          origin: this.runtime.pendingPostPins!.origin,
          phase: 'submit',
          command,
        });
        this.showPending(this.pending);
        return this.dispatch(this.pending, cancel);
      },
      (receipt) => {
        this.finish(receipt);
        applied = true;
      },
      () => this.restore(),
    );
    if (applied && this.slotSpaceId) await this.loadSlot(this.slotSpaceId);
    else if (applied && this.postId === postId)
      await this.load(postId, operation !== 'read');
  }
  private showPending(value: PendingPin) {
    this.update({
      frozen: true,
      confirming: null,
      pendingPostId: value.command.postId,
      pendingOperation: value.command.operation,
      pendingPhase: value.phase,
    });
  }
  private dispatch(
    pending: PendingPin,
    cancel: import('../platform/contracts').Cancellation,
  ) {
    this.runtime.pendingPostPins!.assertOriginal(pending);
    return this.runtime.postPins!.submit(
      pending.command,
      cancel,
      pending.phase === 'cancel',
    );
  }
  private finish(raw: PinReceipt) {
    if (!this.pending) return;
    matchPinReceipt(this.pending.command, raw);
    const result = this.runtime.pendingPostPins!.settle(this.pending, raw);
    this.pending = null;
    this.update({
      frozen: false,
      pendingPostId: '',
      pendingOperation: '',
      pendingPhase: '',
      confirming: null,
      receiptStatus:
        result.outcome === 'applied'
          ? '原操作已确认'
          : result.code === 'POST_PIN_CONFLICT'
            ? '此范围已有置顶，请先明确取消原置顶'
            : result.code === 'POST_PIN_STALE'
              ? '原置顶已变化，未影响新置顶'
              : '原请求已取消',
    });
    this.onSettled();
  }
  async recover(retry = false) {
    if (
      this.view.busy ||
      !this.available() ||
      !this.runtime.postPins ||
      !this.restore() ||
      !this.pending
    )
      return;
    const pending = this.pending,
      postId = this.postId;
    let settled = false;
    await this.mutate(
      async (cancel) => {
        this.runtime.pendingPostPins!.assertOriginal(pending);
        try {
          return await this.runtime.postPins!.receipt(
            pending.command.clientRequestId,
            cancel,
          );
        } catch (error) {
          const failure = clientError(error);
          if (
            !retry ||
            failure.details.serverCode !== 'REQUEST_NOT_FOUND' ||
            failure.details.httpStatus !== 404 ||
            failure.kind === 'protocol'
          )
            throw error;
          return this.dispatch(pending, cancel);
        }
      },
      (receipt) => {
        this.finish(receipt);
        settled = true;
      },
      () => this.restore(),
    );
    if (settled && this.slotSpaceId) await this.loadSlot(this.slotSpaceId);
    else if (settled && postId && this.postId === postId)
      await this.load(postId);
  }
  requestCancellation() {
    if (!this.view.busy && this.restore() && this.pending)
      this.update({ confirming: 'cancel' });
  }
  async confirmCancellation() {
    if (
      this.view.busy ||
      !this.available() ||
      this.view.confirming !== 'cancel' ||
      !this.restore() ||
      !this.pending ||
      !this.runtime.postPins ||
      !this.runtime.pendingPostPins
    )
      return;
    try {
      this.pending = this.runtime.pendingPostPins.cancel(this.pending);
      this.showPending(this.pending);
    } catch (error) {
      this.update({ error: communityError(error) });
      return;
    }
    const pending = this.pending;
    await this.mutate(
      (cancel) => this.dispatch(pending, cancel),
      (receipt) => this.finish(receipt),
      () => this.restore(),
    );
  }
}
