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
  decodeFloorCatalog,
  decodeFloorDetail,
  decodeFloorSetScore,
  invalidFloor,
  floorId,
  floorScore,
  type FloorCatalog,
  type FloorDetail,
  type FloorReceipt,
} from './contract';
import type { PendingFloorRating } from './pending';
export type FloorMode = 'catalog' | 'detail';
export interface FloorRatingView extends CommunityView {
  readonly loaded: boolean;
  readonly catalog: FloorCatalog | null;
  readonly canteenOptions: readonly {
    id: string;
    label: string;
    selected: boolean;
  }[];
  readonly floorOptions: readonly { id: string; label: string }[];
  readonly canteenDraft: readonly string[];
  readonly floorDraft: string;
  readonly detail: FloorDetail | null;
  readonly selectedScore: number | null;
  readonly canScore: boolean;
  readonly confirming: 'score' | 'cancel' | null;
  readonly frozen: boolean;
  readonly recoveryFloorId: string;
  readonly recoveryScore: number | null;
  readonly recoveryPhase: 'submit' | 'cancel' | '';
  readonly receiptMissing: boolean;
  readonly receiptStatus: string;
  readonly blocker: string;
}
export const initialFloorRatingView = (): FloorRatingView => ({
  ...initialCommunityView(),
  loaded: false,
  catalog: null,
  canteenOptions: [],
  floorOptions: [],
  canteenDraft: [],
  floorDraft: '',
  detail: null,
  selectedScore: null,
  canScore: false,
  confirming: null,
  frozen: false,
  recoveryFloorId: '',
  recoveryScore: null,
  recoveryPhase: '',
  receiptMissing: false,
  receiptStatus: '',
  blocker: '',
});
export function floorRatingError(error: unknown): string {
  const failure = clientError(error);
  if (failure.kind === 'protocol') return communityError(failure);
  const messages: Record<string, string> = {
    PHONE_VERIFICATION_REQUIRED: '请先完成手机号验证，再重新加载楼层评分',
    WINDOW_CATALOG_UNAVAILABLE:
      '楼层目录来源尚未确认，暂不能展示；这不代表没有楼层',
    FLOOR_NOT_FOUND: '此楼层当前不可查看；原评分仍可独立查询回执',
    FLOOR_HISTORY_UNAVAILABLE: '历史评分尚未确认，不能当作未评分或零条评分',
    FLOOR_REVISION_CONFLICT: '楼层目录已变化，请刷新后重新选择并确认',
    FLOOR_ALREADY_RATED: '已有有效楼层评分，请刷新后重新选择并确认',
    DISCOVERY_RESTART_REQUIRED: '目录或评分已变化，请重新加载当前楼层',
    REQUEST_NOT_FOUND: '暂未查到原回执；可重试原请求，取消必须取得服务端回执',
    SAFETY_ACTION_RESTRICTED: '当前账号暂不能访问楼层评分；原操作仍可查询回执',
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
export class FloorRatingController extends CommunityController<FloorRatingView> {
  private selectedFloorId: string | null = null;
  private pending: PendingFloorRating | null = null;
  constructor(
    runtime: CommunityRuntime,
    private readonly mode: FloorMode,
    render: (view: FloorRatingView) => void,
  ) {
    super(runtime, initialFloorRatingView, render);
  }
  protected override resetPrivate(): void {
    this.pending = null;
  }
  private ready(): boolean {
    if (!this.available()) return false;
    if (!this.runtime.floorRatings || !this.runtime.pendingFloorRatings) {
      this.update({ error: '当前构建未配置楼层评分服务', canScore: false });
      return false;
    }
    return true;
  }
  private clearRead(): void {
    this.update({
      loaded: false,
      detail: null,
      canScore: false,
      confirming: null,
      selectedScore: null,
    });
  }
  private restore(): boolean {
    const accountId = this.accountId();
    if (!accountId || !this.runtime.pendingFloorRatings) return false;
    try {
      this.pending = this.runtime.pendingFloorRatings.load(accountId);
      if (this.pending) this.showPending(this.pending);
      else
        this.update({
          frozen: false,
          recoveryFloorId: '',
          recoveryScore: null,
          recoveryPhase: '',
          receiptMissing: false,
        });
      return true;
    } catch (error) {
      this.clearRead();
      this.update({
        frozen: true,
        error: floorRatingError(error),
        blocker: '原请求暂不能读取，不能创建替代请求',
      });
      return false;
    }
  }
  private showPending(value: PendingFloorRating): void {
    this.pending = value;
    this.update({
      frozen: true,
      canScore: false,
      confirming: null,
      selectedScore: null,
      recoveryFloorId: value.floorId,
      recoveryScore: value.command.score,
      recoveryPhase: value.phase,
      blocker: '原账号、接口来源、请求编号、楼层版本、分数已保存；等待匹配回执',
      status:
        value.phase === 'cancel' ? '原请求取消结果待确认' : '原评分结果待确认',
    });
  }
  async load(id: string | null = null): Promise<void> {
    if (this.view.busy) return;
    if (this.mode === 'detail' && !floorId(id)) {
      this.update({ error: '楼层入口无效，请从目录重新进入' });
      return;
    }
    this.selectedFloorId = id;
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
      });
      let accepted = false;
      await this.run(
        async (cancel) =>
          decodeFloorCatalog(await this.runtime.floorRatings!.catalog(cancel)),
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
            error: floorRatingError(error),
            status: '楼层目录暂不可用',
          }),
      );
      if (accepted)
        this.update({ loaded: true, status: '请选择食堂和原始楼层' });
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
  private async loadDetail(): Promise<void> {
    const id = this.selectedFloorId;
    if (!id) return;
    this.clearRead();
    this.update({ status: '正在核验楼层与当前评分' });
    await this.run(
      async (cancel) => {
        const detail = decodeFloorDetail(
          await this.runtime.floorRatings!.detail(id, cancel),
        );
        if (detail.floor.id !== id) invalidFloor();
        return detail;
      },
      (detail) => {
        const storageReady = this.restore(),
          known =
            detail.myScore.kind === 'not_submitted' &&
            detail.floor.summary.kind === 'known';
        this.update({
          loaded: true,
          detail,
          canScore: storageReady && !this.pending && known,
          blocker:
            this.pending || !storageReady
              ? this.view.blocker
              : known
                ? '可提交 1 至 5 分，支持小数；已有有效评分不能重复提交'
                : detail.myScore.kind === 'recorded'
                  ? '已有有效楼层评分，当前不能重复提交或修改'
                  : '自己的评分或历史总量暂不能确认，不能提交评分',
          status: this.pending
            ? '原评分结果待确认'
            : known
              ? '楼层与当前评分已加载'
              : detail.myScore.kind === 'recorded'
                ? '楼层与我的有效评分已加载'
                : '楼层已加载，评分历史暂不可用',
        });
      },
      (error) => {
        this.clearRead();
        this.update({
          error: floorRatingError(error),
          status: '楼层详情暂不可用',
        });
      },
    );
  }
  chooseScore(value: unknown): void {
    if (
      this.view.busy ||
      this.view.confirming ||
      this.view.frozen ||
      !this.view.canScore
    )
      return;
    if (!this.restore() || this.pending) return;
    this.update({ selectedScore: floorScore(value) ? value : null });
  }
  confirm(): void {
    if (
      this.view.busy ||
      this.view.frozen ||
      !this.view.canScore ||
      !this.view.detail ||
      !floorScore(this.view.selectedScore) ||
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
      !floorScore(this.view.selectedScore) ||
      !this.ready()
    )
      return;
    const detail = this.view.detail,
      score = this.view.selectedScore;
    if (
      detail.myScore.kind !== 'not_submitted' ||
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
        const attempt = this.runtime.pendingFloorRatings!.freeze({
          version: 1,
          accountId,
          origin: this.runtime.pendingFloorRatings!.origin,
          operation: 'floor.score.first.v1',
          floorId: detail.floor.id,
          phase: 'submit',
          command: decodeFloorSetScore({
            clientRequestId: requestId,
            expectedCatalogRevision: detail.catalogRevision,
            expectedCanteenRevision: detail.floor.canteenRevision,
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
        this.update({ error: floorRatingError(error) });
      },
    );
    if (settled) await this.reload();
  }
  private assertAttempt(
    attempt: PendingFloorRating,
    cancel: Cancellation,
  ): void {
    if (cancel.isCancelled) throw new ClientError('cancelled', 'Cancelled');
    if (attempt.accountId !== this.accountId())
      throw new ClientError('stale-session', 'Account changed');
    this.runtime.pendingFloorRatings!.assertOriginal(attempt);
  }
  private dispatch(
    attempt: PendingFloorRating,
    cancel: Cancellation,
  ): Promise<FloorReceipt> {
    this.assertAttempt(attempt, cancel);
    return attempt.phase === 'cancel'
      ? this.runtime.floorRatings!.cancel(
          attempt.floorId,
          attempt.command,
          cancel,
        )
      : this.runtime.floorRatings!.submit(
          attempt.floorId,
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
          return await this.runtime.floorRatings!.receipt(
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
          error: floorRatingError(error),
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
          this.runtime.pendingFloorRatings!.beginCancellation(original);
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
        this.update({ receiptMissing: false, error: floorRatingError(error) });
      },
    );
    if (settled) await this.reload();
  }
  private settle(receipt: FloorReceipt): void {
    if (!this.pending || this.pending.accountId !== this.accountId())
      invalidFloor();
    const result = this.runtime.pendingFloorRatings!.settle(
      this.pending,
      receipt,
    );
    this.pending = null;
    this.clearRead();
    this.update({
      frozen: false,
      recoveryFloorId: '',
      recoveryScore: null,
      recoveryPhase: '',
      receiptMissing: false,
      blocker: '',
      receiptStatus:
        result.outcome === 'applied'
          ? `原请求已确认记为 ${result.score} 分。这是历史回执，当前评分将重新读取。`
          : result.outcome === 'rejected' &&
              result.code === 'FLOOR_SCORE_CANCELLED'
            ? '服务端已确认取消原请求；延迟到达的原请求不会再写入。'
            : result.outcome === 'rejected' &&
                result.code === 'FLOOR_ALREADY_RATED'
              ? '原请求已确认未写入：已有有效楼层评分。请核对当前评分后重新确认。'
              : '原请求已确认未写入：楼层目录已变化。请重新核对并确认。',
    });
  }
  detailPath(id: string): string | null {
    return !this.view.busy &&
      this.view.loaded &&
      this.view.floorOptions.some((item) => item.id === id)
      ? `/pages/canteen-floor-score-detail/canteen-floor-score-detail?floorId=${id}`
      : null;
  }
  override cancel(): void {
    super.cancel();
    this.clearRead();
    this.update({ receiptMissing: false });
    this.restore();
  }
}
