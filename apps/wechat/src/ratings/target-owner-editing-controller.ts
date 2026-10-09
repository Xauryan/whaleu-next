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
  decodeRatingTargetOwnerEditingContext,
  decodeRatingTargetOwnerEditingIntent,
  decodeRatingTargetOwnerEditingLocator,
  type RatingTargetOwnerEditingContext,
  type RatingTargetOwnerEditingLocator,
} from './target-owner-editing-contract';
import {
  isRatingTargetOwnerEditingIntent,
  type PendingRating,
  type RatingCommandReceipt,
} from './pending';

export interface RatingTargetOwnerEditingView extends CommunityView {
  readonly ready: boolean;
  readonly name: string;
  readonly description: string;
  readonly editConfirmation: boolean;
  readonly canCancelEditing: boolean;
  readonly cancelEditingConfirmation: boolean;
  readonly frozen: boolean;
  readonly recoveryOperation: string;
  readonly receiptStatus: string;
  readonly needsRefresh: boolean;
}
export const initialRatingTargetOwnerEditingView =
  (): RatingTargetOwnerEditingView => ({
    ...initialCommunityView(),
    ready: false,
    name: '',
    description: '',
    editConfirmation: false,
    canCancelEditing: false,
    cancelEditingConfirmation: false,
    frozen: false,
    recoveryOperation: '',
    receiptStatus: '',
    needsRefresh: false,
  });
/** Only the current authorized server context may populate the form. Journal text is never rendered. */
export class RatingTargetOwnerEditingController extends CommunityController<RatingTargetOwnerEditingView> {
  private locator: RatingTargetOwnerEditingLocator | null = null;
  private context: RatingTargetOwnerEditingContext | null = null;
  private pending: PendingRating | null = null;
  private inactive = false;
  private readonly unsubscribeScope: () => void;
  private readonly unsubscribeBrowse: () => void;
  private readonly unsubscribeTarget: () => void;
  constructor(
    runtime: CommunityRuntime,
    render: (view: RatingTargetOwnerEditingView) => void,
  ) {
    super(runtime, initialRatingTargetOwnerEditingView, render);
    const invalidate = (accountId?: string) => {
      if (accountId !== undefined && accountId !== this.accountId()) return;
      this.stop();
      this.resetPrivate();
      this.update({
        ...initialRatingTargetOwnerEditingView(),
        configured: this.configured(),
        hasSession: !!this.accountId(),
        status: '身份或浏览范围已变化，请重新加载；原请求仍受保护',
      });
    };
    this.unsubscribeScope =
      runtime.directoryScopeChanges?.subscribe(invalidate) ?? (() => undefined);
    this.unsubscribeBrowse =
      runtime.browsingScopeChanges?.subscribe(invalidate) ?? (() => undefined);
    this.unsubscribeTarget =
      runtime.ratingTargetChanges?.subscribe((change) => {
        if (change.targetId !== this.locator?.targetId || this.view.frozen)
          return;
        invalidate();
        this.update({
          needsRefresh: true,
          status: '对象内容已变化，请重新加载并确认',
        });
      }) ?? (() => undefined);
  }
  private configured(): boolean {
    return (
      !!this.runtime.ratingTargetOwnerEditing && !!this.runtime.pendingRatings
    );
  }
  protected override available(): boolean {
    if (this.inactive) return false;
    if (!this.configured() || !this.accountId()) {
      this.update({
        ready: false,
        name: '',
        description: '',
        error: this.accountId() ? '编辑服务尚未配置' : '请先登录',
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
      name: '',
      description: '',
      editConfirmation: false,
      frozen: true,
      canCancelEditing: isRatingTargetOwnerEditingIntent(attempt.intent),
      cancelEditingConfirmation: false,
      recoveryOperation: ratingCommandLabels[attempt.intent.operation],
      status: isRatingTargetOwnerEditingIntent(attempt.intent)
        ? '原编辑申请待确认，请查询、重试同一请求或明确撤销'
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
        name: '',
        description: '',
        editConfirmation: false,
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
      ...initialRatingTargetOwnerEditingView(),
      configured: this.configured(),
      hasSession: !!this.accountId(),
    });
    // History precedes route validation and eligibility. Neither route nor current scope can reinterpret the old intent.
    if (!this.journal()) return;
    if (this.pending) {
      await this.recover();
      return;
    }
    try {
      this.locator = decodeRatingTargetOwnerEditingLocator(raw);
    } catch {
      this.update({ error: '编辑链接无效，请从已知评分对象打开' });
      return;
    }
    const locator = this.locator;
    await this.run(
      async (cancel) => {
        const context = decodeRatingTargetOwnerEditingContext(
          await this.runtime.ratingTargetOwnerEditing!.context(
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
          name: context.name,
          description: context.description,
          status: '已核验当前编辑资格；确认后仍需服务器核验版本与精确内容审核',
        });
      },
      (error) =>
        this.update({
          ready: false,
          name: '',
          description: '',
          needsRefresh: true,
          error: ratingError(error),
          status: '暂时无法确认编辑资格，请稍后重试',
        }),
    );
  }
  async reload(): Promise<void> {
    if (this.view.busy) return;
    if (this.view.frozen) await this.recover();
    else await this.load(this.locator);
  }
  private editable(): boolean {
    return (
      !this.inactive &&
      this.view.ready &&
      !this.view.busy &&
      !this.view.frozen &&
      !!this.context
    );
  }
  setName(value: string): void {
    if (
      this.editable() &&
      !this.view.editConfirmation &&
      typeof value === 'string'
    )
      this.update({ name: value });
  }
  setDescription(value: string): void {
    if (
      this.editable() &&
      !this.view.editConfirmation &&
      typeof value === 'string'
    )
      this.update({ description: value });
  }
  requestEdit(): void {
    if (this.editable()) this.update({ editConfirmation: true });
  }
  dismissEdit(): void {
    this.stop();
    this.update({ busy: false, editConfirmation: false });
  }
  async confirmEdit(): Promise<void> {
    const context = this.context;
    if (
      !this.editable() ||
      !this.view.editConfirmation ||
      !context ||
      !this.journal() ||
      this.pending
    )
      return;
    const name = this.view.name,
      description = this.view.description,
      owner = this.runtime.sessions.snapshot(),
      accountId = this.accountId()!;
    await this.run(
      async (cancel) => {
        const clientRequestId = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        if (
          cancel.isCancelled ||
          this.context !== context ||
          !this.view.editConfirmation
        )
          throw new ClientError('cancelled', 'Cancelled before persistence');
        const intent = decodeRatingTargetOwnerEditingIntent({
          operation: 'edit_target',
          payload: {
            clientRequestId,
            targetId: context.targetId,
            regionId: context.regionId,
            expectedTargetRevision: context.revision,
            expectedDefinitionRevision: context.definitionRevision,
            expectedContentVersion: context.contentVersion,
            categoryId: context.categoryId,
            expectedCategoryRevision: context.categoryRevision,
            expectedCatalogRevision: context.catalogRevision,
            name,
            description,
            assetIds: [],
          },
        });
        const attempt = this.runtime.pendingRatings!.freeze({
          version: 7,
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
      this.update({
        ready: false,
        name: '',
        description: '',
        editConfirmation: false,
        frozen: true,
      });
    }
    this.update({
      error: ratingError(error),
      status: this.pending
        ? '结果待确认；请查询或重试原请求，不能更换编号'
        : '尚未发送，请检查输入或重新加载后确认',
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
      name: '',
      description: '',
      editConfirmation: false,
      frozen: false,
      canCancelEditing: false,
      cancelEditingConfirmation: false,
      recoveryOperation: '',
      needsRefresh: true,
      receiptStatus:
        receipt.outcome === 'rejected'
          ? ratingError(
              new ClientError('business', 'Rejected', {
                serverCode: receipt.code,
              }),
            )
          : `${ratingCommandLabels[receipt.operation]}回执已确认；只代表历史操作`,
      status: '请返回目录重新读取当前内容；历史回执不代表当前可见状态',
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
  requestCancelEditing(): void {
    if (
      !this.inactive &&
      !this.view.busy &&
      this.pending &&
      isRatingTargetOwnerEditingIntent(this.pending.intent)
    )
      this.update({ cancelEditingConfirmation: true });
  }
  dismissCancelEditing(): void {
    this.update({ cancelEditingConfirmation: false });
  }
  async confirmCancelEditing(): Promise<void> {
    if (
      this.view.busy ||
      !this.view.cancelEditingConfirmation ||
      !this.pending ||
      !isRatingTargetOwnerEditingIntent(this.pending.intent) ||
      !this.available()
    )
      return;
    const attempt = this.pending,
      intent = this.pending.intent;
    this.update({ cancelEditingConfirmation: false });
    await this.run(
      async (cancel) => {
        if (attempt.accountId !== this.accountId())
          throw new ClientError('stale-session', 'Account changed');
        this.runtime.pendingRatings!.assertOriginal(attempt);
        return this.runtime.ratingTargetOwnerEditing!.cancel(intent, cancel);
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
      editConfirmation: false,
      cancelEditingConfirmation: false,
      status: this.pending
        ? '已停止等待，原请求仍需恢复'
        : '已取消确认，未发送编辑',
    });
  }
  override dispose(): void {
    this.inactive = true;
    this.unsubscribeScope();
    this.unsubscribeBrowse();
    this.unsubscribeTarget();
    super.dispose();
  }
}
