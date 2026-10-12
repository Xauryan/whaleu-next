import { ClientError, clientError } from '../api/errors';
import {
  CommunityController,
  communityError,
  initialCommunityView,
} from '../community/controller';
import type { CommunityView } from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import type { Cancellation } from '../platform/contracts';
import {
  decodeOwnerVisibilityCommand,
  decodeOwnerVisibilityManagement,
} from './contract';
import type {
  OwnerVisibilityManagement,
  OwnerVisibilityReceipt,
} from './contract';
import type { PendingOwnerVisibility } from './pending';
import type { OwnerPostVisibilityGateway } from './gateway';
import type { PendingOwnerPostVisibilityStore } from './pending';
export interface OwnerVisibilityView extends CommunityView {
  readonly postId: string;
  readonly management: OwnerVisibilityManagement | null;
  readonly frozen: boolean;
  readonly confirming: 'change' | 'cancel' | null;
  readonly desired: boolean | null;
  readonly pendingPostId: string;
  readonly pendingRequestId: string;
  readonly recovering: boolean;
  readonly pendingOwnerHidden: boolean | null;
  readonly pendingPhase: 'submit' | 'cancel' | '';
  readonly receiptStatus: string;
}
export const initialOwnerVisibilityView = (): OwnerVisibilityView => ({
  ...initialCommunityView(),
  postId: '',
  management: null,
  frozen: false,
  confirming: null,
  desired: null,
  pendingPostId: '',
  pendingRequestId: '',
  recovering: false,
  pendingOwnerHidden: null,
  pendingPhase: '',
  receiptStatus: '',
});
/** Recovery is actor/request-owned; it does not depend on a readable post DTO. */
export class OwnerPostVisibilityController extends CommunityController<OwnerVisibilityView> {
  private pending: PendingOwnerVisibility | null = null;
  private receiptRead: object | null = null;
  private readonly gateway: OwnerPostVisibilityGateway | undefined;
  private readonly store: PendingOwnerPostVisibilityStore | undefined;
  constructor(
    runtime: CommunityRuntime,
    render: (view: OwnerVisibilityView) => void,
    private readonly onSettled: () => void = () => undefined,
  ) {
    super(runtime, initialOwnerVisibilityView, render);
    this.gateway = runtime.ownerPostVisibility;
    this.store = runtime.pendingOwnerPostVisibility;
  }
  protected override resetPrivate(): void {
    this.pending = null;
    this.receiptRead = null;
  }
  protected override onSafetyInvalidated(previous: OwnerVisibilityView): void {
    this.update({
      postId: previous.postId,
      receiptStatus: previous.receiptStatus,
    });
    // A late report-progress visibility denial can invalidate a receipt GET.
    // Content invalidation must not strand an explicit original-key recovery.
    // Resume only that actor's exact durable receipt read, never its mutation,
    // cancellation or a new key; no readable post/management response is needed.
    if (
      previous.recovering &&
      previous.frozen &&
      this.restore() &&
      this.pending?.command.clientRequestId === previous.pendingRequestId
    ) {
      void this.recover();
      return;
    }
    void this.load(previous.postId || undefined);
  }
  private assertEnvironment(): void {
    if (
      !this.gateway ||
      !this.store ||
      this.runtime.ownerPostVisibility !== this.gateway ||
      this.runtime.pendingOwnerPostVisibility !== this.store
    ) {
      throw new ClientError(
        'configuration',
        'Owner visibility environment changed',
      );
    }
  }
  private restore(): boolean {
    const account = this.accountId();
    if (!account) return false;
    try {
      this.assertEnvironment();
      this.pending = this.store!.load(account);
      this.update({
        frozen: !!this.pending,
        pendingPostId: this.pending?.command.postId ?? '',
        pendingRequestId: this.pending?.command.clientRequestId ?? '',
        pendingOwnerHidden: this.pending?.command.ownerHidden ?? null,
        pendingPhase: this.pending?.phase ?? '',
      });
      return true;
    } catch (error) {
      this.update({ frozen: true, error: communityError(error) });
      return false;
    }
  }
  async load(postId?: string): Promise<void> {
    if (this.view.busy || !this.available() || !this.gateway || !this.store)
      return;
    this.update({
      postId: postId ?? '',
      management: null,
      confirming: null,
      desired: null,
    });
    // Recovery still works if this read fails, the post is hidden, or it has been deleted.
    if (!this.restore() || !postId) return;
    await this.run(
      (cancel) => {
        this.assertEnvironment();
        return this.gateway!.management(postId, cancel);
      },
      (raw) => {
        this.assertEnvironment();
        const management = decodeOwnerVisibilityManagement(raw);
        if (management.postId !== postId)
          throw new ClientError('protocol', 'Owner visibility target mismatch');
        this.update({
          management,
          status: management.canChange ? '' : '此帖子当前不能修改作者可见性',
        });
      },
      (error) => {
        this.update({ management: null });
        if (
          error.details.serverCode === 'POST_NOT_FOUND' &&
          error.details.httpStatus === 404 &&
          error.kind !== 'protocol'
        )
          this.update({ error: '' });
      },
    );
  }
  async request(postId: string, ownerHidden: boolean): Promise<void> {
    if (this.view.busy || !this.available() || !this.restore() || this.pending)
      return;
    await this.load(postId);
    const management = this.view.management;
    if (
      this.view.busy ||
      !this.available() ||
      !this.restore() ||
      this.pending ||
      management?.postId !== postId ||
      !management.canChange
    )
      return;
    if (management.ownerHidden === ownerHidden) {
      this.update({
        status: ownerHidden ? '此帖子已由你隐藏' : '此帖子已取消个人隐藏',
      });
      return;
    }
    this.update({ confirming: 'change', desired: ownerHidden });
  }
  closeConfirmation(): void {
    if (!this.view.busy) this.update({ confirming: null, desired: null });
  }
  async submit(): Promise<void> {
    if (
      this.view.busy ||
      !this.available() ||
      this.view.confirming !== 'change' ||
      !this.restore() ||
      this.pending ||
      this.view.desired === null ||
      !this.view.management?.canChange
    )
      return;
    const management = this.view.management,
      ownerHidden = this.view.desired,
      account = this.accountId()!,
      owner = this.owner;
    await this.run(
      async (cancel) => {
        const clientRequestId = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        this.assertEnvironment();
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Cancelled before persistence');
        const command = decodeOwnerVisibilityCommand({
          clientRequestId,
          postId: management.postId,
          ownerHidden,
          expectedVersion: management.version,
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
      (receipt) => this.finish(receipt),
      () => this.restore(),
    );
  }
  private showPending(pending: PendingOwnerVisibility): void {
    this.update({
      frozen: true,
      confirming: null,
      desired: null,
      pendingPostId: pending.command.postId,
      pendingRequestId: pending.command.clientRequestId,
      pendingOwnerHidden: pending.command.ownerHidden,
      pendingPhase: pending.phase,
      receiptStatus: '',
    });
  }
  private dispatch(
    pending: PendingOwnerVisibility,
    cancel: Cancellation,
  ): Promise<OwnerVisibilityReceipt> {
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
  private finish(raw: OwnerVisibilityReceipt): void {
    this.assertEnvironment();
    if (!this.pending || this.pending.accountId !== this.accountId())
      throw new ClientError('protocol', 'Original owner unavailable');
    const receipt = this.store!.settle(this.pending, raw),
      account = this.accountId()!;
    this.pending = null;
    this.update({
      frozen: false,
      pendingPostId: '',
      pendingRequestId: '',
      pendingOwnerHidden: null,
      pendingPhase: '',
      confirming: null,
      desired: null,
      management: null,
      receiptStatus:
        receipt.outcome === 'applied'
          ? receipt.ownerHidden
            ? '已确认作者隐藏；公开列表将不再展示'
            : '已确认取消个人隐藏；展示仍需通过当前审核与安全校验'
          : receipt.code === 'POST_OWNER_VISIBILITY_STALE'
            ? '可见性版本已变化，原请求未覆盖新状态，请重新加载'
            : receipt.code === 'POST_OWNER_VISIBILITY_CANCELLED'
              ? '原请求已取消'
              : '当前不能修改作者可见性，请重新加载',
    });
    // Clear pooled media, identity overlays and list snapshots before fresh reads.
    this.runtime.safetyChanges?.invalidate(account);
    this.onSettled();
  }
  async recover(retry = false): Promise<void> {
    if (this.view.busy || !this.available() || !this.restore() || !this.pending)
      return;
    const pending = this.pending,
      ticket = {};
    this.receiptRead = ticket;
    this.update({ recovering: true });
    try {
      await this.run(
        async (cancel) => {
          this.assertEnvironment();
          this.store!.assertOriginal(pending);
          try {
            return await this.gateway!.receipt(
              pending.command.clientRequestId,
              cancel,
            );
          } catch (error) {
            const failure = clientError(error);
            // Unknown is not a terminal receipt. Retry only this persisted original command.
            if (
              !retry ||
              failure.kind === 'protocol' ||
              failure.details.serverCode !== 'REQUEST_NOT_FOUND' ||
              failure.details.httpStatus !== 404
            )
              throw error;
            return this.dispatch(pending, cancel);
          }
        },
        (receipt) => this.finish(receipt),
        () => this.restore(),
      );
    } finally {
      if (this.receiptRead === ticket) {
        this.receiptRead = null;
        this.update({ recovering: false });
      }
    }
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
    const pending = this.pending;
    await this.run(
      (cancel) => this.dispatch(pending, cancel),
      (receipt) => this.finish(receipt),
      () => this.restore(),
    );
  }
}
