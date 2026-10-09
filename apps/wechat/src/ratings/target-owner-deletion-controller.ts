import { ClientError } from '../api/errors';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import { invalidRating } from './contract';
import { ratingError } from './controller';
import {
  ratingCommandLabels,
  runRatingCommand,
  settleRatingCommand,
} from './commands';
import {
  decodeRatingTargetOwnerDeletionContext,
  decodeRatingTargetOwnerDeletionIntent,
  decodeRatingTargetOwnerDeletionLocator,
  type RatingTargetOwnerDeletionContext,
  type RatingTargetOwnerDeletionLocator,
} from './target-owner-deletion-contract';
import {
  isRatingTargetOwnerDeletionIntent,
  type PendingRating,
  type RatingCommandReceipt,
} from './pending';

export interface RatingTargetOwnerDeletionView extends CommunityView {
  readonly ready: boolean;
  readonly deleted: boolean;
  readonly deleteConfirmation: boolean;
  readonly canCancelDeletion: boolean;
  readonly cancelDeletionConfirmation: boolean;
  readonly frozen: boolean;
  readonly recoveryOperation: string;
  readonly receiptStatus: string;
  readonly needsRefresh: boolean;
  readonly returnToCatalog: boolean;
}
export const initialRatingTargetOwnerDeletionView =
  (): RatingTargetOwnerDeletionView => ({
    ...initialCommunityView(),
    ready: false,
    deleted: false,
    deleteConfirmation: false,
    canCancelDeletion: false,
    cancelDeletionConfirmation: false,
    frozen: false,
    recoveryOperation: '',
    receiptStatus: '',
    needsRefresh: false,
    returnToCatalog: false,
  });
/** Cleanup is metadata-only. History recovery precedes both route validation and current eligibility. */
export class RatingTargetOwnerDeletionController extends CommunityController<RatingTargetOwnerDeletionView> {
  private locator: RatingTargetOwnerDeletionLocator | null = null;
  private context: RatingTargetOwnerDeletionContext | null = null;
  private pending: PendingRating | null = null;
  private inactive = false;
  private readonly unsubscribeScope: () => void;
  private readonly unsubscribeBrowse: () => void;
  constructor(
    runtime: CommunityRuntime,
    render: (view: RatingTargetOwnerDeletionView) => void,
  ) {
    super(runtime, initialRatingTargetOwnerDeletionView, render);
    const invalidate = (accountId?: string) => {
      if (accountId !== undefined && accountId !== this.accountId()) return;
      this.stop();
      this.resetPrivate();
      this.update({
        ...initialRatingTargetOwnerDeletionView(),
        configured: this.configured(),
        hasSession: !!this.accountId(),
        status: '身份或浏览范围已变化，请重新加载；原请求仍受保护',
      });
    };
    this.unsubscribeScope =
      runtime.directoryScopeChanges?.subscribe(invalidate) ?? (() => undefined);
    this.unsubscribeBrowse =
      runtime.browsingScopeChanges?.subscribe(invalidate) ?? (() => undefined);
  }
  private configured(): boolean {
    return (
      !!this.runtime.ratingTargetOwnerDeletion && !!this.runtime.pendingRatings
    );
  }
  protected override available(): boolean {
    if (this.inactive) return false;
    if (!this.configured() || !this.accountId()) {
      this.update({
        ready: false,
        error: this.accountId() ? '删除服务尚未配置' : '请先登录',
      });
      return false;
    }
    return true;
  }
  protected override resetPrivate(): void {
    this.context = null;
    this.pending = null;
  }
  private showPending(attempt: PendingRating): void {
    this.pending = attempt;
    this.context = null;
    this.update({
      ready: false,
      deleted: false,
      deleteConfirmation: false,
      frozen: true,
      canCancelDeletion: isRatingTargetOwnerDeletionIntent(attempt.intent),
      cancelDeletionConfirmation: false,
      recoveryOperation: ratingCommandLabels[attempt.intent.operation],
      status: isRatingTargetOwnerDeletionIntent(attempt.intent)
        ? '原删除申请待确认，请查询、重试同一请求或明确撤销'
        : '原请求待确认，只能查询或重试同一请求',
    });
  }
  private journal(): boolean {
    if (!this.available()) return false;
    try {
      this.pending = this.runtime.pendingRatings!.load(this.accountId()!);
      if (this.pending) this.showPending(this.pending);
      return true;
    } catch (error) {
      this.context = null;
      this.update({
        ready: false,
        deleteConfirmation: false,
        frozen: true,
        error: ratingError(error),
      });
      return false;
    }
  }
  async load(raw: unknown): Promise<void> {
    this.stop();
    this.resetPrivate();
    this.locator = null;
    this.update({
      ...initialRatingTargetOwnerDeletionView(),
      configured: this.configured(),
      hasSession: !!this.accountId(),
    });
    if (!this.journal()) return;
    if (this.pending) {
      await this.recover();
      return;
    }
    try {
      this.locator = decodeRatingTargetOwnerDeletionLocator(raw);
    } catch {
      this.update({ error: '删除链接无效，请从已知评分对象打开' });
      return;
    }
    const locator = this.locator;
    await this.run(
      async (cancel) => {
        const context = decodeRatingTargetOwnerDeletionContext(
          await this.runtime.ratingTargetOwnerDeletion!.context(
            locator.targetId,
            cancel,
          ),
        );
        if (context.targetId !== locator.targetId) invalidRating();
        return context;
      },
      (context) => {
        this.context = context;
        this.update({
          ready: true,
          deleted: context.deletion.kind === 'owner_deleted',
          status:
            context.deletion.kind === 'owner_deleted'
              ? '此对象已由创建者删除'
              : '已确认你是此对象的创建者',
        });
      },
      (error) =>
        this.update({
          ready: false,
          needsRefresh: true,
          error: ratingError(error),
          status: '暂时无法确认删除资格，请稍后重试',
        }),
    );
  }
  async reload(): Promise<void> {
    if (this.view.busy) return;
    if (this.view.frozen) await this.recover();
    else await this.load(this.locator);
  }
  requestDelete(): void {
    if (
      !this.inactive &&
      !this.view.busy &&
      !this.view.frozen &&
      this.view.ready &&
      !this.view.deleted &&
      this.context
    )
      this.update({ deleteConfirmation: true });
  }
  dismissDelete(): void {
    this.stop();
    this.update({ busy: false, deleteConfirmation: false });
  }
  async confirmDelete(): Promise<void> {
    const context = this.context;
    if (
      this.view.busy ||
      !this.view.deleteConfirmation ||
      !context ||
      !this.journal() ||
      this.pending
    )
      return;
    const owner = this.runtime.sessions.snapshot(),
      accountId = this.accountId()!;
    await this.run(
      async (cancel) => {
        const clientRequestId = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        if (
          cancel.isCancelled ||
          this.context !== context ||
          !this.view.deleteConfirmation
        )
          throw new ClientError('cancelled', 'Cancelled before persistence');
        const intent = decodeRatingTargetOwnerDeletionIntent({
          operation: 'delete_target',
          payload: {
            clientRequestId,
            targetId: context.targetId,
            expectedTargetRevision: context.revision,
          },
        });
        const attempt = this.runtime.pendingRatings!.freeze({
          version: 6,
          accountId,
          intent,
        });
        this.showPending(attempt);
        return runRatingCommand(this.runtime, attempt, cancel, true);
      },
      (receipt) => this.settle(receipt),
      (error) => this.commandError(error),
    );
  }
  private commandError(error: unknown): void {
    if (error instanceof ClientError && error.kind === 'storage') {
      this.context = null;
      this.update({ ready: false, deleteConfirmation: false, frozen: true });
    }
    this.update({
      error: ratingError(error),
      status: this.pending
        ? '结果待确认；请查询或重试原请求，不能更换编号'
        : '尚未发送，请重新加载后确认',
    });
  }
  private settle(raw: RatingCommandReceipt): void {
    if (!this.pending || this.pending.accountId !== this.accountId())
      invalidRating();
    const receipt = settleRatingCommand(this.runtime, this.pending, raw);
    this.pending = null;
    this.context = null;
    this.update({
      ready: false,
      deleted: false,
      deleteConfirmation: false,
      frozen: false,
      canCancelDeletion: false,
      cancelDeletionConfirmation: false,
      recoveryOperation: '',
      needsRefresh: true,
      returnToCatalog:
        receipt.operation === 'delete_target' && receipt.outcome !== 'rejected',
      receiptStatus:
        receipt.outcome === 'rejected'
          ? ratingError(
              new ClientError('business', 'Rejected', {
                serverCode: receipt.code,
              }),
            )
          : `${ratingCommandLabels[receipt.operation]}回执已确认；只代表历史操作`,
      status: '请返回目录刷新当前内容',
      error: '',
    });
  }
  async recover(retry = false): Promise<void> {
    if (this.view.busy || !this.journal() || !this.pending) return;
    const attempt = this.pending;
    await this.run(
      (cancel) => runRatingCommand(this.runtime, attempt, cancel, retry),
      (receipt) => this.settle(receipt),
      (error) =>
        this.update({
          error: ratingError(error),
          status: '原请求仍待确认；未找到回执不会解除保护',
        }),
    );
  }
  requestCancelDeletion(): void {
    if (
      !this.inactive &&
      !this.view.busy &&
      this.pending &&
      isRatingTargetOwnerDeletionIntent(this.pending.intent)
    )
      this.update({ cancelDeletionConfirmation: true });
  }
  dismissCancelDeletion(): void {
    this.update({ cancelDeletionConfirmation: false });
  }
  async confirmCancelDeletion(): Promise<void> {
    if (
      this.view.busy ||
      !this.view.cancelDeletionConfirmation ||
      !this.pending ||
      !isRatingTargetOwnerDeletionIntent(this.pending.intent) ||
      !this.available()
    )
      return;
    const attempt = this.pending,
      intent = this.pending.intent;
    this.update({ cancelDeletionConfirmation: false });
    await this.run(
      async (cancel) => {
        if (attempt.accountId !== this.accountId())
          throw new ClientError('stale-session', 'Account changed');
        this.runtime.pendingRatings!.assertOriginal(attempt);
        return this.runtime.ratingTargetOwnerDeletion!.cancel(intent, cancel);
      },
      (receipt) => this.settle(receipt),
      (error) =>
        this.update({
          error: ratingError(error),
          status: '撤销结果待确认，请查询原回执或再次明确撤销；原请求仍受保护',
        }),
    );
  }
  override cancel(): void {
    this.stop();
    this.context = null;
    this.update({
      busy: false,
      ready: false,
      deleted: false,
      deleteConfirmation: false,
      cancelDeletionConfirmation: false,
      status: this.pending
        ? '已停止等待，原请求仍需恢复'
        : '已取消确认，未发送删除',
    });
  }
  override dispose(): void {
    this.inactive = true;
    this.unsubscribeScope();
    this.unsubscribeBrowse();
    super.dispose();
  }
}
