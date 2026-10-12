import { ClientError, clientError } from '../api/errors';
import {
  CommunityController,
  communityError,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import type { Cancellation } from '../platform/contracts';
import { windowId } from '../window-ratings/contract';
import {
  decodeDishCommand,
  decodeDishOwn,
  decodeDishPage,
  dishName,
  invalidDish,
  type DishItem,
  type DishOperation,
  type DishOwn,
  type DishPage,
  type DishReceipt,
} from './contract';
import type { PendingDishRecommendation } from './pending';
export interface DishRecommendationView extends CommunityView {
  readonly loaded: boolean;
  readonly items: readonly DishItem[];
  readonly pageNumber: number;
  readonly canNext: boolean;
  readonly restartRequired: boolean;
  readonly nameDraft: string;
  readonly own: DishOwn | null;
  readonly ownName: string;
  readonly canRecommend: boolean;
  readonly canRetract: boolean;
  readonly confirming: 'recommend' | 'retract' | 'cancel' | null;
  readonly frozen: boolean;
  readonly recoveryWindowId: string;
  readonly recoveryName: string;
  readonly recoveryOperation: DishOperation | '';
  readonly recoveryPhase: 'submit' | 'cancel' | '';
  readonly receiptMissing: boolean;
  readonly receiptStatus: string;
  readonly blocker: string;
}
export const initialDishRecommendationView = (): DishRecommendationView => ({
  ...initialCommunityView(),
  loaded: false,
  items: [],
  pageNumber: 0,
  canNext: false,
  restartRequired: false,
  nameDraft: '',
  own: null,
  ownName: '',
  canRecommend: false,
  canRetract: false,
  confirming: null,
  frozen: false,
  recoveryWindowId: '',
  recoveryName: '',
  recoveryOperation: '',
  recoveryPhase: '',
  receiptMissing: false,
  receiptStatus: '',
  blocker: '',
});
export function dishRecommendationError(error: unknown): string {
  const failure = clientError(error);
  if (failure.kind === 'protocol') return communityError(failure);
  const messages: Record<string, string> = {
    PHONE_VERIFICATION_REQUIRED:
      '推荐需要已验证手机号；已有推荐仍可独立查询与撤回',
    WINDOW_CATALOG_UNAVAILABLE:
      '窗口来源暂未确认；已有推荐仍可按原菜名查询与撤回',
    WINDOW_NOT_FOUND: '窗口当前不可查看；已有推荐仍可独立查询与撤回',
    DISH_BUDGET_UNAVAILABLE:
      '当前推荐范围超出精确核验上限，暂不展示不完整数量；自己的既有推荐仍可查询与撤回',
    DISH_HISTORY_UNAVAILABLE: '菜品推荐历史暂不能确认，不能当作零条或尚未推荐',
    DISH_MEMBERSHIP_HISTORY_UNAVAILABLE:
      '自己的推荐历史暂不能确认，不能当作尚未推荐',
    WINDOW_HISTORY_UNAVAILABLE: '历史暂不能确认，不能当作零条或尚未推荐',
    WINDOW_REVISION_CONFLICT: '窗口目录已变化，请重新加载后确认',
    DISH_MEMBERSHIP_REVISION_CONFLICT:
      '自己的推荐已在别处变化，请重新查询后确认',
    DISH_CURSOR_INVALID: '分页已失效，请从第一页重新加载',
    DISH_RESTART_REQUIRED: '推荐排序或可见性已变化，请从第一页重新加载',
    DISCOVERY_RESTART_REQUIRED: '推荐排序或可见性已变化，请从第一页重新加载',
    CONTENT_REVIEW_UNAVAILABLE:
      '本次菜名审核暂不可用，保留原请求以便查询或取消',
    REVIEW_UNAVAILABLE: '本次菜名审核暂不可用，保留原请求以便查询或取消',
    REQUEST_NOT_FOUND: '暂未查到原回执；可重试原请求，取消必须取得服务端回执',
    SAFETY_ACTION_RESTRICTED:
      '当前账号暂不能新增推荐；已有推荐仍可独立查询与撤回',
  };
  return messages[failure.details.serverCode ?? ''] ?? communityError(error);
}
const missing = (error: unknown): boolean => {
  const failure = clientError(error);
  return (
    failure.kind !== 'protocol' &&
    failure.details.httpStatus === 404 &&
    failure.details.serverCode === 'REQUEST_NOT_FOUND'
  );
};
export class DishRecommendationController extends CommunityController<DishRecommendationView> {
  private reloadGeneration = 0;
  private selectedWindowId: string | null = null;
  private snapshot: DishPage | null = null;
  private pending: PendingDishRecommendation | null = null;
  constructor(
    runtime: CommunityRuntime,
    render: (view: DishRecommendationView) => void,
  ) {
    super(runtime, initialDishRecommendationView, render);
  }
  protected override resetPrivate(): void {
    this.reloadGeneration += 1;
    this.snapshot = null;
    this.pending = null;
  }
  private ready(): boolean {
    if (!this.available()) return false;
    if (
      !this.runtime.dishRecommendations ||
      !this.runtime.pendingDishRecommendations
    ) {
      this.update({
        error: '当前构建未配置菜品推荐服务',
        canRecommend: false,
        canRetract: false,
      });
      return false;
    }
    return true;
  }
  private clearOwn(): void {
    this.update({
      own: null,
      ownName: '',
      canRecommend: false,
      canRetract: false,
      confirming: null,
    });
  }
  private clearList(): void {
    this.update({
      loaded: false,
      items: [],
      canNext: false,
      canRecommend: false,
      confirming: null,
    });
  }
  private clearRead(): void {
    this.clearList();
    this.clearOwn();
    this.snapshot = null;
  }
  private restore(): boolean {
    const account = this.accountId();
    if (!account || !this.runtime.pendingDishRecommendations) return false;
    try {
      this.pending = this.runtime.pendingDishRecommendations.load(account);
      if (this.pending) this.showPending(this.pending);
      else
        this.update({
          frozen: false,
          recoveryWindowId: '',
          recoveryName: '',
          recoveryOperation: '',
          recoveryPhase: '',
          receiptMissing: false,
        });
      return true;
    } catch (error) {
      this.clearRead();
      this.update({
        frozen: true,
        error: dishRecommendationError(error),
        blocker: '原请求暂不能读取，不能创建替代请求',
      });
      return false;
    }
  }
  private showPending(attempt: PendingDishRecommendation): void {
    this.pending = attempt;
    this.update({
      frozen: true,
      canRecommend: false,
      canRetract: false,
      confirming: null,
      recoveryWindowId: attempt.windowId,
      recoveryName: attempt.command.dishName,
      recoveryOperation: attempt.operation,
      recoveryPhase: attempt.phase,
      blocker:
        '原账号、接口来源、请求编号、窗口版本、自己的推荐版本、操作与原菜名已保存；等待匹配回执',
      status:
        attempt.phase === 'cancel'
          ? '原请求取消结果待确认'
          : '原推荐操作待确认',
    });
  }
  async load(id: string | null): Promise<void> {
    if (this.view.busy || !this.ready()) return;
    if (id === null) {
      if (!this.restore()) return;
      if (!this.pending) {
        this.update({
          status: '当前账号没有待确认的菜品操作，请从窗口详情选择菜品',
        });
        return;
      }
      id = this.pending.windowId;
    }
    if (!windowId(id)) {
      this.update({ error: '窗口入口无效，请从窗口详情重新进入' });
      return;
    }
    this.selectedWindowId = id;
    await this.reload();
  }
  async reload(): Promise<void> {
    if (this.view.busy || !this.ready() || !this.selectedWindowId) return;
    const name = this.view.nameDraft,
      generation = ++this.reloadGeneration;
    this.restore();
    this.clearOwn();
    await this.loadPage(null);
    if (generation === this.reloadGeneration && dishName(name) && this.ready())
      await this.lookup();
  }
  async next(): Promise<void> {
    if (
      this.view.busy ||
      !this.view.canNext ||
      !this.snapshot?.nextCursor ||
      !this.ready()
    )
      return;
    this.clearOwn();
    await this.loadPage(this.snapshot.nextCursor);
  }
  private async loadPage(cursor: string | null): Promise<void> {
    const id = this.selectedWindowId!,
      prior = this.snapshot,
      pageNumber = cursor ? this.view.pageNumber + 1 : 1;
    this.clearList();
    this.update({
      restartRequired: false,
      status: '正在核验菜品推荐与当前有效推荐数',
    });
    await this.run(
      async (cancel) => {
        const page = decodeDishPage(
          await this.runtime.dishRecommendations!.list(id, cursor, cancel),
        );
        if (
          page.windowId !== id ||
          (cursor !== null && page.nextCursor === cursor)
        )
          invalidDish();
        if (
          cursor &&
          (!prior ||
            page.membershipRevision !== prior.membershipRevision ||
            page.catalogRevision !== prior.catalogRevision ||
            page.windowRevision !== prior.windowRevision)
        )
          throw new ClientError('business', 'Dish snapshot changed', {
            serverCode: 'DISH_RESTART_REQUIRED',
          });
        if (cursor && prior?.items.length && page.items.length) {
          const last = prior.items[prior.items.length - 1]!,
            first = page.items[0]!;
          if (
            first.recommendationCount > last.recommendationCount ||
            (first.recommendationCount === last.recommendationCount &&
              first.dishIdentity <= last.dishIdentity)
          )
            invalidDish();
        }
        return page;
      },
      (page) => {
        this.snapshot = page;
        this.update({
          loaded: true,
          items: page.items,
          pageNumber,
          canNext: page.nextCursor !== null,
          status: page.items.length
            ? '当前可见推荐已加载，按有效推荐数排序'
            : '当前已确认没有可见推荐',
        });
      },
      (error) => {
        this.snapshot = null;
        this.clearList();
        this.update({
          pageNumber: 0,
          restartRequired:
            cursor !== null ||
            clientError(error).details.serverCode === 'DISH_RESTART_REQUIRED',
          error: dishRecommendationError(error),
          status: '公开推荐暂不可用；可独立查询自己的推荐',
        });
      },
    );
  }
  setName(name: string): void {
    if (this.view.busy || this.view.frozen || this.view.confirming) return;
    this.clearOwn();
    this.update({ nameDraft: name });
  }
  async choose(identity: string): Promise<void> {
    if (
      this.view.busy ||
      this.view.frozen ||
      this.view.confirming ||
      !this.view.loaded
    )
      return;
    const item = this.view.items.find(
      (entry) => entry.dishIdentity === identity,
    );
    if (!item) return;
    this.setName(item.dishName);
    await this.lookup();
  }
  async lookup(): Promise<void> {
    if (
      this.view.busy ||
      this.view.confirming ||
      !this.ready() ||
      !this.selectedWindowId
    )
      return;
    const name = this.view.nameDraft,
      id = this.selectedWindowId;
    this.clearOwn();
    if (!dishName(name)) {
      this.update({
        error:
          '菜名须为 1 至 10 个 Unicode 字符，不能全为空白或包含控制字符；不会截断或自动修改',
      });
      return;
    }
    const storageReady = this.restore();
    await this.run(
      async (cancel) =>
        decodeDishOwn(
          await this.runtime.dishRecommendations!.own(id, name, cancel),
        ),
      (own) => {
        const actionable = storageReady && !this.pending;
        this.update({
          own,
          ownName: name,
          canRecommend:
            actionable &&
            this.view.loaded &&
            !!this.snapshot &&
            own.kind !== 'unavailable' &&
            !(own.kind === 'recorded' && own.active),
          canRetract: actionable && own.kind === 'recorded' && own.active,
          blocker:
            this.pending || !storageReady
              ? this.view.blocker
              : own.kind === 'unavailable'
                ? '自己的推荐历史暂不能确认，不能新建或撤回'
                : own.kind === 'recorded' && own.active
                  ? '已有自己的推荐；即使公开列表不可用，也可撤回这条推荐'
                  : this.view.loaded
                    ? '可确认推荐这个原样菜名；新增仍须通过当前资格与审核'
                    : '已确认自己的状态；新增需先成功加载当前公开列表',
        });
      },
      (error) => {
        this.clearOwn();
        this.update({ error: dishRecommendationError(error) });
      },
    );
  }
  confirm(operation: 'recommend' | 'retract'): void {
    if (
      this.view.busy ||
      this.view.frozen ||
      this.view.confirming ||
      !this.view.own ||
      this.view.ownName !== this.view.nameDraft ||
      !(operation === 'recommend'
        ? this.view.canRecommend
        : this.view.canRetract) ||
      !this.ready() ||
      !this.restore() ||
      this.pending
    )
      return;
    this.update({ confirming: operation });
  }
  closeConfirmation(): void {
    if (!this.view.busy) this.update({ confirming: null });
  }
  async submit(): Promise<void> {
    const kind = this.view.confirming;
    if (
      this.view.busy ||
      this.view.frozen ||
      (kind !== 'recommend' && kind !== 'retract') ||
      !(kind === 'recommend' ? this.view.canRecommend : this.view.canRetract) ||
      !this.view.own ||
      this.view.own.kind === 'unavailable' ||
      this.view.ownName !== this.view.nameDraft ||
      !this.ready() ||
      !this.restore() ||
      this.pending ||
      !this.selectedWindowId
    )
      return;
    const name = this.view.ownName,
      own = this.view.own,
      snapshot = this.snapshot,
      id = this.selectedWindowId,
      accountId = this.accountId()!,
      owner = this.runtime.sessions.snapshot();
    const operation: DishOperation =
      kind === 'recommend'
        ? 'window.dish.recommend.v1'
        : 'window.dish.retract.v1';
    let settled = false;
    await this.run(
      async (cancel) => {
        const requestId = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Cancelled before persistence');
        const attempt = this.runtime.pendingDishRecommendations!.freeze({
          version: 1,
          accountId,
          origin: this.runtime.pendingDishRecommendations!.origin,
          windowId: id,
          operation,
          phase: 'submit',
          command: decodeDishCommand({
            clientRequestId: requestId,
            // Retraction is an actor-owned closure: source revisions are not authority for it.
            expectedCatalogRevision:
              kind === 'retract' && own.kind === 'recorded'
                ? own.catalogRevision
                : snapshot?.catalogRevision,
            expectedWindowRevision:
              kind === 'retract' && own.kind === 'recorded'
                ? own.windowRevision
                : snapshot?.windowRevision,
            expectedMembershipRevision:
              own.kind === 'recorded' ? own.revision : null,
            dishName: name,
          }),
        });
        this.clearRead();
        this.showPending(attempt);
        return this.dispatch(attempt, cancel);
      },
      (receipt) => {
        this.settle(receipt);
        settled = true;
      },
      (error) => {
        this.clearRead();
        this.restore();
        this.update({ error: dishRecommendationError(error) });
      },
    );
    if (settled) await this.reload();
  }
  private assertAttempt(
    attempt: PendingDishRecommendation,
    cancel: Cancellation,
  ): void {
    if (cancel.isCancelled) throw new ClientError('cancelled', 'Cancelled');
    if (attempt.accountId !== this.accountId())
      throw new ClientError('stale-session', 'Account changed');
    this.runtime.pendingDishRecommendations!.assertOriginal(attempt);
  }
  private dispatch(
    attempt: PendingDishRecommendation,
    cancel: Cancellation,
  ): Promise<DishReceipt> {
    this.assertAttempt(attempt, cancel);
    return attempt.phase === 'cancel'
      ? this.runtime.dishRecommendations!.cancel(
          attempt.windowId,
          attempt.operation,
          attempt.command,
          cancel,
        )
      : this.runtime.dishRecommendations!.submit(
          attempt.windowId,
          attempt.operation,
          attempt.command,
          cancel,
        );
  }
  async recover(retry = false, prepareCancel = false): Promise<void> {
    if (this.view.busy || !this.ready() || !this.restore() || !this.pending)
      return;
    const attempt = this.pending;
    this.clearRead();
    this.update({ receiptMissing: false });
    let settled = false;
    await this.run(
      async (cancel) => {
        this.assertAttempt(attempt, cancel);
        try {
          return await this.runtime.dishRecommendations!.receipt(
            attempt.command.clientRequestId,
            cancel,
          );
        } catch (error) {
          if (!missing(error)) throw error;
          this.assertAttempt(attempt, cancel);
          if (retry) return this.dispatch(attempt, cancel);
          throw error;
        }
      },
      (receipt) => {
        this.settle(receipt);
        settled = true;
      },
      (error) => {
        this.showPending(attempt);
        this.update({
          receiptMissing: missing(error),
          confirming:
            missing(error) && prepareCancel && attempt.phase === 'submit'
              ? 'cancel'
              : null,
          error: dishRecommendationError(error),
        });
      },
    );
    if (settled) await this.reload();
  }
  async confirmCancellation(): Promise<void> {
    if (
      this.view.busy ||
      this.view.confirming !== 'cancel' ||
      !this.view.receiptMissing ||
      !this.pending ||
      !this.ready()
    )
      return;
    const original = this.pending;
    let settled = false;
    await this.run(
      async (cancel) => {
        this.assertAttempt(original, cancel);
        const attempt =
          this.runtime.pendingDishRecommendations!.beginCancellation(original);
        this.showPending(attempt);
        return this.dispatch(attempt, cancel);
      },
      (receipt) => {
        this.settle(receipt);
        settled = true;
      },
      (error) => {
        this.clearRead();
        this.restore();
        this.update({
          receiptMissing: false,
          error: dishRecommendationError(error),
        });
      },
    );
    if (settled) await this.reload();
  }
  private settle(receipt: DishReceipt): void {
    if (!this.pending || this.pending.accountId !== this.accountId())
      invalidDish();
    const attempt = this.pending,
      result = this.runtime.pendingDishRecommendations!.settle(
        attempt,
        receipt,
      );
    this.pending = null;
    this.clearRead();
    this.update({
      frozen: false,
      recoveryWindowId: '',
      recoveryName: '',
      recoveryOperation: '',
      recoveryPhase: '',
      receiptMissing: false,
      blocker: '',
      ...(attempt.windowId === this.selectedWindowId
        ? { nameDraft: attempt.command.dishName }
        : {}),
      receiptStatus:
        result.outcome === 'applied'
          ? `原请求已确认${result.active ? '推荐' : '撤回'}。这是历史回执，当前推荐状态将重新读取。`
          : result.code === 'DISH_CANCELLED'
            ? '服务端已确认取消原请求；延迟到达的原请求不会再写入。'
            : result.code === 'CONTENT_REJECTED'
              ? '本次菜名未通过审核，原请求已确认未写入。'
              : result.code === 'DISH_MEMBERSHIP_REVISION_CONFLICT'
                ? '原请求未写入：自己的推荐已在别处变化，请重新查询后确认。'
                : result.code === 'DISH_ALREADY_RECOMMENDED'
                  ? '原请求未写入：已经推荐过这个菜名。'
                  : result.code === 'DISH_NOT_RECOMMENDED'
                    ? '原请求未写入：当前没有可撤回的自己的推荐。'
                    : '原请求未写入：窗口目录已变化，请重新查询后确认。',
    });
  }
  override cancel(): void {
    this.reloadGeneration += 1;
    super.cancel();
    this.clearRead();
    this.update({ receiptMissing: false });
    this.restore();
  }
}
