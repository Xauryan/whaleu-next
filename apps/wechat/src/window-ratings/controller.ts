import { ClientError, clientError } from '../api/errors';
import {
  CommunityController,
  communityError,
  initialCommunityView,
  type CommunityView,
} from '../community/controller';
import type { CommunityRuntime } from '../community/runtime';
import type { Cancellation } from '../platform/contracts';
import {
  decodeWindowCatalog,
  decodeWindowDetail,
  decodeWindowPage,
  decodeWindowQuery,
  decodeWindowSetScore,
  invalidWindow,
  windowId,
  windowScore,
  type RatingWindow,
  type WindowCatalog,
  type WindowDetail,
  type WindowPage,
  type WindowQuery,
  type WindowReceipt,
} from './contract';
import type { PendingWindowRating } from './pending';
export type WindowMode = 'catalog' | 'detail';
export interface WindowRatingView extends CommunityView {
  readonly loaded: boolean;
  readonly catalog: WindowCatalog | null;
  readonly canteenOptions: readonly {
    id: string;
    label: string;
    selected: boolean;
  }[];
  readonly floorOptions: readonly { id: string; label: string }[];
  readonly canteenDraft: readonly string[];
  readonly floorDraft: string;
  readonly minRatingDraft: string;
  readonly appliedFilter: string;
  readonly items: readonly RatingWindow[];
  readonly detail: WindowDetail | null;
  readonly pageNumber: number;
  readonly canNext: boolean;
  readonly restartRequired: boolean;
  readonly selectedScore: number | null;
  readonly canScore: boolean;
  readonly confirming: 'score' | 'cancel' | null;
  readonly frozen: boolean;
  readonly recoveryWindowId: string;
  readonly recoveryScore: number | null;
  readonly recoveryPhase: 'submit' | 'cancel' | '';
  readonly receiptMissing: boolean;
  readonly receiptStatus: string;
  readonly blocker: string;
}
export const initialWindowRatingView = (): WindowRatingView => ({
  ...initialCommunityView(),
  loaded: false,
  catalog: null,
  canteenOptions: [],
  floorOptions: [],
  canteenDraft: [],
  floorDraft: '',
  minRatingDraft: '',
  appliedFilter: '',
  items: [],
  detail: null,
  pageNumber: 0,
  canNext: false,
  restartRequired: false,
  selectedScore: null,
  canScore: false,
  confirming: null,
  frozen: false,
  recoveryWindowId: '',
  recoveryScore: null,
  recoveryPhase: '',
  receiptMissing: false,
  receiptStatus: '',
  blocker: '',
});
export function windowRatingError(error: unknown): string {
  const failure = clientError(error);
  if (failure.kind === 'protocol') return communityError(failure);
  const messages: Record<string, string> = {
    PHONE_VERIFICATION_REQUIRED: '请先完成手机号验证，再重新加载窗口评分',
    WINDOW_CATALOG_UNAVAILABLE:
      '窗口目录来源尚未确认，暂不能展示；这不代表没有窗口',
    WINDOW_NOT_FOUND: '此窗口当前不可查看；原评分仍可独立查询回执',
    WINDOW_HISTORY_UNAVAILABLE: '历史评分尚未确认，不能当作未评分或零条评分',
    WINDOW_REVISION_CONFLICT: '窗口目录已变化，请刷新后重新选择并确认',
    WINDOW_SCORE_REVISION_CONFLICT:
      '你的评分已在别处变化，请刷新后重新选择并确认',
    WINDOW_CURSOR_INVALID: '分页已失效，请从第一页重新加载',
    WINDOW_RESTART_REQUIRED: '目录或评分排序已变化，请从第一页重新加载',
    DISCOVERY_RESTART_REQUIRED: '目录或评分排序已变化，请从第一页重新加载',
    WINDOW_FILTER_INVALID: '食堂或楼层筛选已失效，请重新加载目录并选择',
    REQUEST_NOT_FOUND: '暂未查到原回执；可重试原请求，取消必须取得服务端回执',
    SAFETY_ACTION_RESTRICTED: '当前账号暂不能访问窗口评分；原操作仍可查询回执',
  };
  return messages[failure.details.serverCode ?? ''] ?? communityError(error);
}
const missing = (error: unknown): boolean => {
  const value = clientError(error);
  return (
    value.kind !== 'protocol' &&
    value.details.serverCode === 'REQUEST_NOT_FOUND' &&
    value.details.httpStatus === 404
  );
};
export class WindowRatingController extends CommunityController<WindowRatingView> {
  private selectedWindowId: string | null = null;
  private pending: PendingWindowRating | null = null;
  private query: WindowQuery = {};
  private snapshot: WindowPage | null = null;
  constructor(
    runtime: CommunityRuntime,
    private readonly mode: WindowMode,
    render: (view: WindowRatingView) => void,
  ) {
    super(runtime, initialWindowRatingView, render);
  }
  protected override resetPrivate(): void {
    this.pending = null;
    this.snapshot = null;
    this.query = {};
  }
  private ready(): boolean {
    if (!this.available()) return false;
    if (!this.runtime.windowRatings || !this.runtime.pendingWindowRatings) {
      this.update({ error: '当前构建未配置窗口评分服务', canScore: false });
      return false;
    }
    return true;
  }
  private clearRead(): void {
    this.update({
      loaded: false,
      detail: null,
      items: [],
      canNext: false,
      canScore: false,
      confirming: null,
      selectedScore: null,
    });
  }
  private restore(): boolean {
    const accountId = this.accountId();
    if (!accountId || !this.runtime.pendingWindowRatings) return false;
    try {
      this.pending = this.runtime.pendingWindowRatings.load(accountId);
      if (this.pending) this.showPending(this.pending);
      else
        this.update({
          frozen: false,
          recoveryWindowId: '',
          recoveryScore: null,
          recoveryPhase: '',
          receiptMissing: false,
        });
      return true;
    } catch (error) {
      this.clearRead();
      this.update({
        frozen: true,
        error: windowRatingError(error),
        blocker: '原请求暂不能读取，不能创建替代请求',
      });
      return false;
    }
  }
  private showPending(value: PendingWindowRating): void {
    this.pending = value;
    this.update({
      frozen: true,
      canScore: false,
      confirming: null,
      selectedScore: null,
      recoveryWindowId: value.windowId,
      recoveryScore: value.command.score,
      recoveryPhase: value.phase,
      blocker:
        '原账号、接口来源、请求编号、窗口版本、原评分版本与分数已保存；等待匹配回执',
      status:
        value.phase === 'cancel' ? '原请求取消结果待确认' : '原评分结果待确认',
    });
  }
  async load(id: string | null = null): Promise<void> {
    if (this.view.busy) return;
    if (this.mode === 'detail' && !windowId(id)) {
      this.update({ error: '窗口入口无效，请从目录重新进入' });
      return;
    }
    this.selectedWindowId = id;
    await this.reload();
  }
  async reload(): Promise<void> {
    if (this.view.busy || !this.ready()) return;
    this.restore();
    if (this.mode === 'detail') await this.loadDetail();
    else {
      this.clearRead();
      this.update({
        catalog: null,
        canteenOptions: [],
        floorOptions: [],
        restartRequired: false,
      });
      let accepted = false;
      await this.run(
        async (cancel) =>
          decodeWindowCatalog(
            await this.runtime.windowRatings!.catalog(cancel),
          ),
        (catalog) => {
          const canteenDraft = this.view.canteenDraft.filter((id) =>
            catalog.canteens.some((item) => item.id === id),
          );
          this.update({ catalog, canteenDraft });
          this.updateFilterOptions();
          accepted = true;
        },
        (error) =>
          this.update({
            error: windowRatingError(error),
            status: '窗口目录暂不可用',
          }),
      );
      if (accepted) await this.search();
    }
  }
  private updateFilterOptions(): void {
    const catalog = this.view.catalog;
    if (!catalog) return;
    const selected = this.view.canteenDraft;
    const floorOptions = catalog.canteens
      .filter((item) => !selected.length || selected.includes(item.id))
      .flatMap((item) =>
        item.floors.map((floor) => ({
          id: floor.id,
          label: `${item.name} · ${floor.label}`,
        })),
      );
    this.update({
      canteenOptions: catalog.canteens.map((item) => ({
        id: item.id,
        label: `${item.campusLabel} · ${item.name}`,
        selected: selected.includes(item.id),
      })),
      floorOptions,
      floorDraft: floorOptions.some((item) => item.id === this.view.floorDraft)
        ? this.view.floorDraft
        : '',
    });
  }
  toggleCanteen(id: string): void {
    if (
      this.view.busy ||
      !this.view.catalog?.canteens.some((item) => item.id === id)
    )
      return;
    const current = this.view.canteenDraft;
    if (!current.includes(id) && current.length >= 20) {
      this.update({ error: '一次最多选择 20 个食堂' });
      return;
    }
    this.update({
      canteenDraft: current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id].sort(),
      floorDraft: '',
    });
    this.updateFilterOptions();
  }
  setFloor(id: string): void {
    if (
      !this.view.busy &&
      (id === '' || this.view.floorOptions.some((item) => item.id === id))
    )
      this.update({ floorDraft: id });
  }
  setMinimum(value: string): void {
    if (!this.view.busy) this.update({ minRatingDraft: value });
  }
  async search(): Promise<void> {
    if (
      this.view.busy ||
      this.mode !== 'catalog' ||
      !this.view.catalog ||
      !this.ready()
    )
      return;
    try {
      const minimum = this.view.minRatingDraft.trim();
      if (minimum && !/^-?(?:\d|10)(?:\.\d{1,4})?$/.test(minimum))
        invalidWindow();
      this.query = decodeWindowQuery({
        ...(this.view.canteenDraft.length
          ? { canteenIds: this.view.canteenDraft }
          : {}),
        ...(this.view.floorDraft ? { floorId: this.view.floorDraft } : {}),
        ...(minimum ? { minRating: Number(minimum) } : {}),
      });
    } catch {
      this.update({ error: '最低均分须为 -10 至 10，最多四位小数' });
      return;
    }
    await this.loadPage(null);
  }
  async next(): Promise<void> {
    if (
      this.view.busy ||
      !this.view.canNext ||
      !this.snapshot?.nextCursor ||
      !this.ready()
    )
      return;
    await this.loadPage(this.snapshot.nextCursor);
  }
  private async loadPage(cursor: string | null): Promise<void> {
    const prior = this.snapshot,
      query = this.query,
      catalog = this.view.catalog,
      pageNumber = cursor ? this.view.pageNumber + 1 : 1;
    this.clearRead();
    this.update({ restartRequired: false, status: '正在核验窗口目录与均分' });
    await this.run(
      async (cancel) => {
        const page = decodeWindowPage(
          await this.runtime.windowRatings!.list(query, cursor, cancel),
        );
        if (
          !catalog ||
          page.catalogRevision !== catalog.catalogRevision ||
          (cursor &&
            (!prior ||
              prior.scoreRevision !== page.scoreRevision ||
              prior.catalogRevision !== page.catalogRevision))
        )
          throw new ClientError('business', 'Window snapshot changed', {
            serverCode: 'WINDOW_RESTART_REQUIRED',
          });
        if (cursor && page.nextCursor === cursor) invalidWindow();
        for (const item of page.items) {
          const canteen = catalog.canteens.find(
              (entry) => entry.id === item.canteenId,
            ),
            floor = canteen?.floors.find((entry) => entry.id === item.floor.id);
          if (
            !canteen ||
            canteen.name !== item.canteenName ||
            !floor ||
            floor.label !== item.floor.label ||
            floor.sourceFloorKey !== item.floor.sourceFloorKey
          )
            invalidWindow();
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
          appliedFilter: [
            query.canteenIds
              ? `已选 ${query.canteenIds.length} 个食堂`
              : '全部食堂',
            query.floorId
              ? (this.view.floorOptions.find(
                  (item) => item.id === query.floorId,
                )?.label ?? '所选楼层')
              : '全部楼层',
            query.minRating === undefined || query.minRating <= 0
              ? '不限均分'
              : `均分至少 ${query.minRating}`,
          ].join(' · '),
          status: page.items.length
            ? '窗口目录已加载，按均分排序'
            : '当前查询已确认没有窗口',
        });
      },
      (error) => {
        this.snapshot = null;
        this.clearRead();
        this.update({
          pageNumber: 0,
          restartRequired:
            cursor !== null ||
            clientError(error).details.serverCode === 'WINDOW_RESTART_REQUIRED',
          error: windowRatingError(error),
          status: '窗口列表暂不可用',
        });
      },
    );
  }
  private async loadDetail(): Promise<void> {
    const id = this.selectedWindowId;
    if (!id) return;
    this.clearRead();
    this.update({ status: '正在核验窗口与当前评分' });
    await this.run(
      async (cancel) => {
        const detail = decodeWindowDetail(
          await this.runtime.windowRatings!.detail(id, cancel),
        );
        if (detail.window.id !== id) invalidWindow();
        return detail;
      },
      (detail) => {
        const storageReady = this.restore(),
          known =
            detail.myScore.kind !== 'unavailable' &&
            detail.window.summary.kind === 'known';
        this.update({
          loaded: true,
          detail,
          canScore: storageReady && !this.pending && known,
          blocker:
            this.pending || !storageReady
              ? this.view.blocker
              : known
                ? '可提交或修改 -10 至 +10 的整数评分，0 也是有效评分'
                : '自己的评分或历史总量暂不能确认，不能提交评分',
          status: this.pending
            ? '原评分结果待确认'
            : known
              ? '窗口与当前评分已加载'
              : '窗口已加载，评分历史暂不可用',
        });
      },
      (error) => {
        this.clearRead();
        this.update({
          error: windowRatingError(error),
          status: '窗口详情暂不可用',
        });
      },
    );
  }
  chooseScore(value: unknown): void {
    if (
      this.view.busy ||
      this.view.confirming ||
      this.view.frozen ||
      !this.view.canScore ||
      !windowScore(value)
    )
      return;
    if (!this.restore() || this.pending) return;
    this.update({ selectedScore: value });
  }
  confirm(): void {
    if (
      this.view.busy ||
      this.view.frozen ||
      !this.view.canScore ||
      !this.view.detail ||
      !windowScore(this.view.selectedScore) ||
      !this.ready()
    )
      return;
    if (!this.restore() || this.pending) return;
    this.update({ confirming: 'score' });
  }
  closeConfirmation(): void {
    if (!this.view.busy) this.update({ confirming: null });
  }
  async submit(): Promise<void> {
    if (
      this.view.busy ||
      this.view.frozen ||
      this.view.confirming !== 'score' ||
      !this.view.canScore ||
      !this.view.detail ||
      !windowScore(this.view.selectedScore) ||
      !this.ready()
    )
      return;
    const detail = this.view.detail,
      score = this.view.selectedScore;
    if (
      detail.myScore.kind === 'unavailable' ||
      !this.restore() ||
      this.pending
    )
      return;
    const accountId = this.accountId()!,
      owner = this.runtime.sessions.snapshot();
    let settled = false;
    await this.run(
      async (cancel) => {
        const requestId = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Cancelled before persistence');
        const attempt = this.runtime.pendingWindowRatings!.freeze({
          version: 1,
          accountId,
          origin: this.runtime.pendingWindowRatings!.origin,
          operation: 'window.score.set.v1',
          windowId: detail.window.id,
          phase: 'submit',
          command: decodeWindowSetScore({
            clientRequestId: requestId,
            expectedCatalogRevision: detail.catalogRevision,
            expectedWindowRevision: detail.window.revision,
            expectedOwnScoreRevision:
              detail.myScore.kind === 'recorded'
                ? detail.myScore.revision
                : null,
            score,
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
        this.update({ error: windowRatingError(error) });
      },
    );
    if (settled) await this.reload();
  }
  private assertAttempt(
    attempt: PendingWindowRating,
    cancel: Cancellation,
  ): void {
    if (cancel.isCancelled) throw new ClientError('cancelled', 'Cancelled');
    if (attempt.accountId !== this.accountId())
      throw new ClientError('stale-session', 'Account changed');
    this.runtime.pendingWindowRatings!.assertOriginal(attempt);
  }
  private dispatch(
    attempt: PendingWindowRating,
    cancel: Cancellation,
  ): Promise<WindowReceipt> {
    this.assertAttempt(attempt, cancel);
    return attempt.phase === 'cancel'
      ? this.runtime.windowRatings!.cancel(
          attempt.windowId,
          attempt.command,
          cancel,
        )
      : this.runtime.windowRatings!.submit(
          attempt.windowId,
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
          return await this.runtime.windowRatings!.receipt(
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
          error: windowRatingError(error),
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
          this.runtime.pendingWindowRatings!.beginCancellation(original);
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
        this.update({ receiptMissing: false, error: windowRatingError(error) });
      },
    );
    if (settled) await this.reload();
  }
  private settle(receipt: WindowReceipt): void {
    if (!this.pending || this.pending.accountId !== this.accountId())
      invalidWindow();
    const result = this.runtime.pendingWindowRatings!.settle(
      this.pending,
      receipt,
    );
    this.pending = null;
    this.clearRead();
    this.update({
      frozen: false,
      recoveryWindowId: '',
      recoveryScore: null,
      recoveryPhase: '',
      receiptMissing: false,
      blocker: '',
      receiptStatus:
        result.outcome === 'applied'
          ? `原请求已确认记为 ${result.score} 分。这是历史回执，当前评分将重新读取。`
          : result.outcome === 'noop'
            ? `原请求已确认无需变更，回执分数为 ${result.score}。当前评分将重新读取。`
            : result.outcome === 'rejected' &&
                result.code === 'WINDOW_SCORE_CANCELLED'
              ? '服务端已确认取消原请求；延迟到达的原请求不会再写入。'
              : result.outcome === 'rejected' &&
                  result.code === 'WINDOW_SCORE_REVISION_CONFLICT'
                ? '原请求已确认未写入：你的评分已在别处变化。请核对当前评分后重新确认。'
                : '原请求已确认未写入：窗口目录已变化。请重新核对并确认。',
    });
  }
  detailPath(id: string): string | null {
    return !this.view.busy &&
      this.view.loaded &&
      this.view.items.some((item) => item.id === id)
      ? `/pages/window-rating-detail/window-rating-detail?windowId=${id}`
      : null;
  }
  override cancel(): void {
    super.cancel();
    this.clearRead();
    this.update({ receiptMissing: false });
    this.restore();
  }
}
