import { ClientError } from '../api/errors';
import { exact } from '../community/contract';
import {
  CommunityController,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import { invalidRating, ratingId } from './contract';
import { ratingNullableId } from './discussion-contract';
import { ratingError } from './controller';
import {
  ratingCommandLabels,
  runRatingCommand,
  settleRatingCommand,
} from './commands';
import { decodeRatingTargetCreationIntent } from './management-contract';
import {
  isRatingTargetCreationIntent,
  type PendingRating,
  type RatingCommandReceipt,
} from './pending';
export interface RatingCreationContext {
  readonly regionId: string | null;
  readonly categoryId: string;
  readonly expectedCategoryRevision: string;
  readonly expectedCatalogRevision: string;
}
export function decodeRatingCreationContext(
  value: unknown,
): RatingCreationContext {
  exact(value, [
    'regionId',
    'categoryId',
    'expectedCategoryRevision',
    'expectedCatalogRevision',
  ]);
  if (
    !ratingNullableId(value.regionId) ||
    !ratingId(value.categoryId) ||
    !ratingId(value.expectedCategoryRevision) ||
    !ratingId(value.expectedCatalogRevision)
  )
    invalidRating();
  return Object.freeze({
    regionId: value.regionId,
    categoryId: value.categoryId,
    expectedCategoryRevision: value.expectedCategoryRevision,
    expectedCatalogRevision: value.expectedCatalogRevision,
  });
}
export interface RatingManagementView extends CommunityView {
  readonly ready: boolean;
  readonly canCancelCreation: boolean;
  readonly cancelCreationConfirmation: boolean;
  readonly name: string;
  readonly description: string;
  readonly frozen: boolean;
  readonly recoveryOperation: string;
  readonly receiptStatus: string;
  readonly needsRefresh: boolean;
}
export const initialRatingManagementView = (): RatingManagementView => ({
  ...initialCommunityView(),
  ready: false,
  canCancelCreation: false,
  cancelCreationConfirmation: false,
  name: '',
  description: '',
  frozen: false,
  recoveryOperation: '',
  receiptStatus: '',
  needsRefresh: false,
});
/** Server checks eligibility and exact review. The form never treats a readable catalog as creation permission. */
export class RatingManagementController extends CommunityController<RatingManagementView> {
  private context: RatingCreationContext | null = null;
  private pending: PendingRating | null = null;
  private inactive = false;
  private readonly unsubscribeScope: () => void;
  private readonly unsubscribeBrowse: () => void;
  private readonly unsubscribeCatalog: () => void;
  constructor(
    runtime: CommunityRuntime,
    render: (view: RatingManagementView) => void,
  ) {
    super(runtime, initialRatingManagementView, render);
    const invalidate = (accountId?: string) => {
      if (accountId !== undefined && accountId !== this.accountId()) return;
      this.stop();
      this.resetPrivate();
      this.update({
        ...initialRatingManagementView(),
        configured: this.configured(),
        hasSession: !!this.accountId(),
        status: '身份或浏览范围已变化，请返回目录重新打开',
      });
    };
    this.unsubscribeScope =
      runtime.directoryScopeChanges?.subscribe(invalidate) ?? (() => undefined);
    this.unsubscribeBrowse =
      runtime.browsingScopeChanges?.subscribe(invalidate) ?? (() => undefined);
    this.unsubscribeCatalog =
      runtime.ratingCatalogChanges?.subscribe(() => {
        invalidate();
        this.update({
          needsRefresh: true,
          status: '评分分类目录已变化，请重新核验后确认；原请求仍受保护',
        });
      }) ?? (() => undefined);
  }
  private configured(): boolean {
    return !!this.runtime.ratingManagement && !!this.runtime.pendingRatings;
  }
  protected override available(): boolean {
    if (this.inactive) return false;
    if (!this.configured() || !this.accountId()) {
      this.update({
        error: this.accountId() ? '创建服务尚未配置' : '请先登录',
        ready: false,
      });
      return false;
    }
    return true;
  }
  protected override resetPrivate(): void {
    this.context = null;
    this.pending = null;
  }
  private journal(): boolean {
    if (!this.available()) return false;
    try {
      this.pending = this.runtime.pendingRatings!.load(this.accountId()!);
      if (this.pending) this.showPending(this.pending);
      return true;
    } catch (error) {
      this.update({ ready: false, frozen: true, error: ratingError(error) });
      return false;
    }
  }
  private showPending(attempt: PendingRating): void {
    this.pending = attempt;
    this.update({
      ready: false,
      name: '',
      description: '',
      frozen: true,
      canCancelCreation: isRatingTargetCreationIntent(attempt.intent),
      cancelCreationConfirmation: false,
      recoveryOperation: ratingCommandLabels[attempt.intent.operation],
      status: isRatingTargetCreationIntent(attempt.intent)
        ? '原创建申请待确认，可查询、重试原请求或明确撤销'
        : '原请求待确认，只能查询或重试同一请求',
    });
  }
  async load(raw: unknown): Promise<void> {
    this.stop();
    this.resetPrivate();
    this.update({
      ...initialRatingManagementView(),
      configured: this.configured(),
      hasSession: !!this.accountId(),
    });
    // Receipt recovery precedes route/catalog validity and all current eligibility checks.
    if (!this.journal()) return;
    if (this.pending) {
      await this.recover();
      return;
    }
    try {
      this.context = decodeRatingCreationContext(raw);
    } catch {
      this.update({ error: '分类链接无效，请返回目录重新打开' });
      return;
    }
    this.update({
      ready: true,
      status:
        '提交后由服务器核验创建政策、资格、范围、目录版本与精确内容审核；条件未就绪时无法创建',
    });
  }
  setName(value: string): void {
    if (this.editable() && typeof value === 'string')
      this.update({ name: value });
  }
  setDescription(value: string): void {
    if (this.editable() && typeof value === 'string')
      this.update({ description: value });
  }
  private editable(): boolean {
    return (
      !this.inactive && this.view.ready && !this.view.busy && !this.view.frozen
    );
  }
  async create(): Promise<void> {
    if (!this.editable() || !this.context || !this.journal() || this.pending)
      return;
    const context = this.context,
      name = this.view.name,
      description = this.view.description;
    const owner = this.runtime.sessions.snapshot(),
      accountId = this.accountId()!;
    await this.run(
      async (cancel) => {
        const clientRequestId = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        if (cancel.isCancelled || this.context !== context)
          throw new ClientError('cancelled', 'Cancelled before persistence');
        const intent = decodeRatingTargetCreationIntent({
          operation: 'create_target',
          payload: {
            clientRequestId,
            ...context,
            name,
            description,
            assetIds: [],
          },
        });
        const attempt = this.runtime.pendingRatings!.freeze({
          version: 5,
          accountId,
          intent,
        });
        this.showPending(attempt);
        return runRatingCommand(this.runtime, attempt, cancel, true);
      },
      (receipt) => this.settle(receipt),
      (error) =>
        this.update({
          error: ratingError(error),
          status: this.pending
            ? '结果待确认；请查询或重试原请求，不能更换编号'
            : '未发送，请检查输入',
        }),
    );
  }
  private settle(receipt: RatingCommandReceipt): void {
    if (!this.pending || this.pending.accountId !== this.accountId())
      invalidRating();
    settleRatingCommand(this.runtime, this.pending, receipt);
    this.pending = null;
    this.context = null;
    this.update({
      ready: false,
      frozen: false,
      name: '',
      description: '',
      recoveryOperation: '',
      needsRefresh: true,
      canCancelCreation: false,
      cancelCreationConfirmation: false,
      receiptStatus:
        receipt.outcome === 'rejected' || receipt.outcome === 'closed'
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
  requestCancelCreation(): void {
    if (
      this.inactive ||
      this.view.busy ||
      !this.view.canCancelCreation ||
      !this.pending ||
      !isRatingTargetCreationIntent(this.pending.intent)
    )
      return;
    this.update({ cancelCreationConfirmation: true });
  }
  dismissCancelCreation(): void {
    this.update({ cancelCreationConfirmation: false });
  }
  async confirmCancelCreation(): Promise<void> {
    if (
      this.inactive ||
      this.view.busy ||
      !this.view.cancelCreationConfirmation ||
      !this.pending ||
      !isRatingTargetCreationIntent(this.pending.intent) ||
      !this.available()
    )
      return;
    const attempt = this.pending,
      intent = this.pending.intent;
    this.update({ cancelCreationConfirmation: false });
    await this.run(
      async (cancel) => {
        if (attempt.accountId !== this.accountId())
          throw new ClientError('stale-session', 'Account changed');
        this.runtime.pendingRatings!.assertOriginal(attempt);
        return this.runtime.ratingManagement!.cancel(intent, cancel);
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
      name: '',
      description: '',
      cancelCreationConfirmation: false,
      status: this.pending
        ? '已停止等待，原请求仍需恢复'
        : '已取消，请返回目录重新打开',
    });
  }
  override dispose(): void {
    this.inactive = true;
    this.unsubscribeScope();
    this.unsubscribeBrowse();
    this.unsubscribeCatalog();
    super.dispose();
  }
}
