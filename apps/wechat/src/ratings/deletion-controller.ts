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
  decodeRatingDeletionLocator,
  decodeRatingDeletionContext,
  decodeRatingAdminDeletionContext,
  matchRatingDeletionContext,
  ratingAdminDeletionIntent,
  ratingOwnerDeletionIntent,
  type RatingDeletionAuthority,
  type RatingDeletionContext,
  type RatingAdminDeletionContext,
  type RatingDeletionLocator,
} from './deletion-contract';
import {
  decodeRatingCommandIntent,
  isRatingScopedIntent,
  isRatingCategoryCreationIntent,
  isRatingTargetCreationIntent,
  isRatingTargetOwnerEditingIntent,
  isRatingTargetOwnerDeletionIntent,
  isRatingAdminDeletionIntent,
  isRatingDeletionContextChanged,
  isRatingReplyIntent,
  isRatingLikeIntent,
  isRatingSubscriptionIntent,
  type PendingRating,
  type RatingCommandReceipt,
} from './pending';

export interface RatingDeletionView extends CommunityView {
  readonly loaded: boolean;
  readonly locator: RatingDeletionLocator | null;
  readonly authority: RatingDeletionAuthority | null;
  readonly context: RatingDeletionContext | null;
  readonly canConfirm: boolean;
  readonly frozen: boolean;
  readonly recoveryOperation: string;
  readonly receiptStatus: string;
  readonly needsRefresh: boolean;
}
export const initialRatingDeletionView = (): RatingDeletionView => ({
  ...initialCommunityView(),
  loaded: false,
  locator: null,
  authority: null,
  context: null,
  canConfirm: false,
  frozen: false,
  recoveryOperation: '',
  receiptStatus: '',
  needsRefresh: false,
});
type Confirmation =
  | { readonly authority: 'owner'; readonly context: RatingDeletionContext }
  | {
      readonly authority: 'admin';
      readonly context: RatingAdminDeletionContext;
    };
/** Known IDs only. No public content reads, role/profile guesses or list-wide admin probes. */
export class RatingDeletionController extends CommunityController<RatingDeletionView> {
  private locator: RatingDeletionLocator | null = null;
  private confirmation: Confirmation | null = null;
  private pending: PendingRating | null = null;
  private inactive = false;
  private readonly unsubscribeScope: () => void;
  private readonly unsubscribeBrowse: () => void;
  private readonly unsubscribeCatalog: () => void;
  constructor(
    runtime: CommunityRuntime,
    render: (view: RatingDeletionView) => void,
  ) {
    super(runtime, initialRatingDeletionView, render);
    const invalidate = (accountId?: string) => {
      if (accountId !== undefined && accountId !== this.accountId()) return;
      this.stop();
      this.resetPrivate();
      this.update({
        ...initialRatingDeletionView(),
        configured: this.configured(),
        hasSession: !!this.accountId(),
        status: '身份或浏览范围已变化，请重新打开并核验删除资格',
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
    this.update({ configured: this.configured() });
  }
  private configured(): boolean {
    return !!this.runtime.ratingDeletion && !!this.runtime.pendingRatings;
  }
  protected override available(): boolean {
    if (this.inactive) return false;
    if (!this.configured() || !this.accountId()) {
      this.update({
        configured: this.configured(),
        error: this.accountId() ? '删除服务尚未配置' : '请先登录',
        canConfirm: false,
      });
      return false;
    }
    return true;
  }
  protected override resetPrivate(): void {
    this.confirmation = null;
    this.pending = null;
  }
  private clearConfirmation(): void {
    this.confirmation = null;
    this.update({
      loaded: false,
      authority: null,
      context: null,
      canConfirm: false,
    });
  }
  private showPending(attempt: PendingRating): void {
    this.clearConfirmation();
    this.pending = attempt;
    this.update({
      frozen: true,
      recoveryOperation: ratingCommandLabels[attempt.intent.operation],
      status: '原请求待确认，只能查询或重试原请求',
    });
  }
  private loadJournal(): boolean {
    if (!this.available()) return false;
    try {
      this.pending = this.runtime.pendingRatings!.load(this.accountId()!);
      if (this.pending) this.showPending(this.pending);
      return true;
    } catch (error) {
      this.clearConfirmation();
      this.update({
        frozen: true,
        error: ratingError(error),
        status: '原请求存储无法确认，禁止新建请求',
      });
      return false;
    }
  }
  async load(raw: unknown): Promise<void> {
    this.stop();
    this.resetPrivate();
    this.update({
      ...initialRatingDeletionView(),
      configured: this.configured(),
      hasSession: !!this.accountId(),
    });
    try {
      this.locator = decodeRatingDeletionLocator(raw);
    } catch {
      this.locator = null;
    }
    if (!this.loadJournal()) return;
    if (this.pending) {
      await this.recover();
      return;
    }
    if (!this.locator) {
      this.update({ error: '删除链接无效，请从已知评价或回复打开' });
      return;
    }
    this.update({
      locator: this.locator,
      status: '请选择并核验此条内容的删除资格；不会读取正文或身份',
    });
  }
  async readContext(
    authority: RatingDeletionAuthority,
    confirm = true,
  ): Promise<void> {
    if (
      this.view.busy ||
      !this.locator ||
      !this.loadJournal() ||
      this.pending ||
      this.view.frozen
    )
      return;
    const locator = this.locator;
    this.clearConfirmation();
    await this.run(
      async (cancel) => {
        const raw = await this.runtime.ratingDeletion!.context(
          authority,
          locator,
          cancel,
        );
        const context =
          authority === 'admin'
            ? decodeRatingAdminDeletionContext(raw)
            : decodeRatingDeletionContext(raw);
        matchRatingDeletionContext(locator, context);
        return context;
      },
      (context) => {
        if (confirm)
          this.confirmation =
            authority === 'admin'
              ? {
                  authority,
                  context: decodeRatingAdminDeletionContext(context),
                }
              : { authority, context };
        // Never put the opaque administrative context into page data.
        const visible: RatingDeletionContext = {
          subjectKind: context.subjectKind,
          targetId: context.targetId,
          rootId: context.rootId,
          subjectId: context.subjectId,
          regionId: context.regionId,
          targetRevision: context.targetRevision,
          rootRevision: context.rootRevision,
          revision: context.revision,
          deleted: context.deleted,
        };
        this.update({
          loaded: true,
          authority,
          context: Object.freeze(visible),
          canConfirm: confirm,
          needsRefresh: false,
          status: context.deleted
            ? '重新读取确认此条内容已删除'
            : authority === 'admin'
              ? '已核验此条内容的管理删除资格，请确认'
              : '已核验这是自己的内容，请确认清理',
        });
      },
      (error) => {
        this.clearConfirmation();
        this.update({
          needsRefresh: true,
          error: ratingError(error),
          status: '当前删除资格或状态不可确认，未读取正文',
        });
      },
    );
  }
  async confirmDelete(): Promise<void> {
    const confirmation = this.confirmation;
    if (
      this.view.busy ||
      !this.view.canConfirm ||
      !confirmation ||
      !this.loadJournal() ||
      this.pending ||
      this.view.frozen
    )
      return;
    const owner = this.runtime.sessions.snapshot(),
      accountId = this.accountId()!;
    let completed: PendingRating | null = null;
    await this.run(
      async (cancel) => {
        const id = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        if (cancel.isCancelled || this.confirmation !== confirmation)
          throw new ClientError(
            'cancelled',
            'Deletion cancelled before persistence',
          );
        const intent = decodeRatingCommandIntent(
          confirmation.authority === 'admin'
            ? ratingAdminDeletionIntent(confirmation.context, id)
            : ratingOwnerDeletionIntent(confirmation.context, id),
        );
        if (
          isRatingScopedIntent(intent) ||
          isRatingTargetOwnerEditingIntent(intent) ||
          isRatingTargetOwnerDeletionIntent(intent) ||
          isRatingCategoryCreationIntent(intent) ||
          isRatingTargetCreationIntent(intent) ||
          isRatingLikeIntent(intent) ||
          isRatingSubscriptionIntent(intent)
        )
          invalidRating();
        const attempt = this.runtime.pendingRatings!.freeze(
          isRatingAdminDeletionIntent(intent)
            ? { version: 4, accountId, intent }
            : { version: 2, accountId, intent },
        );
        this.showPending(attempt);
        return runRatingCommand(this.runtime, attempt, cancel, true);
      },
      (receipt) => {
        completed = this.pending;
        this.settle(receipt);
      },
      (error) => this.commandError(error),
    );
    if (completed) await this.readAfterReceipt(completed);
  }
  private commandError(error: unknown): void {
    this.clearConfirmation();
    if (isRatingDeletionContextChanged(error)) {
      // runRatingCommand released only an explicitly rolled-back DELETE. Verify storage, never infer from GET.
      if (!this.loadJournal()) return;
      if (!this.pending) {
        this.update({
          frozen: false,
          needsRefresh: true,
          recoveryOperation: '',
          error: ratingError(error),
          status:
            '原请求未提交，请重新核验版本和资格，再次确认后才会生成新请求',
        });
        return;
      }
    }
    this.update({
      frozen: !!this.pending || this.view.frozen,
      error: ratingError(error),
      status: this.pending
        ? '结果待确认，请查询回执或重试同一请求'
        : '尚未发送删除，请重新读取后确认',
    });
  }
  private settle(raw: RatingCommandReceipt): void {
    if (!this.pending || this.pending.accountId !== this.accountId())
      invalidRating();
    const receipt = settleRatingCommand(this.runtime, this.pending, raw);
    this.pending = this.runtime.pendingRatings!.load(this.accountId()!);
    this.update({
      frozen: false,
      recoveryOperation: '',
      needsRefresh: true,
      receiptStatus:
        receipt.outcome === 'rejected' || receipt.outcome === 'closed'
          ? ratingError(
              new ClientError('business', 'Rejected', {
                serverCode: receipt.code,
              }),
            )
          : `${ratingCommandLabels[receipt.operation]}${receipt.outcome === 'noop' ? '未发生变更' : '已提交'}；此回执只确认历史操作`,
      status: '请重新读取当前删除状态',
      error: '',
    });
    if (this.pending) this.showPending(this.pending);
  }
  private async readAfterReceipt(attempt: PendingRating): Promise<void> {
    if (
      this.inactive ||
      this.pending ||
      !this.locator ||
      attempt.accountId !== this.accountId()
    )
      return;
    const intent = attempt.intent;
    const subjectId = isRatingAdminDeletionIntent(intent)
      ? intent.subjectId
      : intent.operation === 'delete_comment'
        ? intent.commentId
        : intent.operation === 'delete_reply'
          ? intent.replyId
          : null;
    if (subjectId !== this.locator.subjectId) return;
    if (
      isRatingAdminDeletionIntent(intent) ||
      intent.operation === 'delete_comment' ||
      (isRatingReplyIntent(intent) && intent.operation === 'delete_reply')
    )
      await this.readContext(
        isRatingAdminDeletionIntent(intent) ? 'admin' : 'owner',
        false,
      );
  }
  async recover(retry = false): Promise<void> {
    if (this.view.busy || !this.loadJournal() || !this.pending) return;
    const attempt = this.pending;
    let complete = false;
    await this.run(
      (cancel) => runRatingCommand(this.runtime, attempt, cancel, retry),
      (receipt) => {
        this.settle(receipt);
        complete = true;
      },
      (error) => this.commandError(error),
    );
    if (complete) await this.readAfterReceipt(attempt);
  }
  override cancel(): void {
    this.stop();
    this.clearConfirmation();
    this.update({
      busy: false,
      status: this.pending
        ? '已停止等待，原请求仍需恢复'
        : '已取消确认，未发送删除',
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
