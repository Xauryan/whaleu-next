import { ClientError } from '../api/errors';
import type { Cancellation, Clock } from '../platform/contracts';
import { systemClock } from '../platform/clock';
import {
  CommunityController,
  communityError,
  initialCommunityView,
  reasonMessage,
  type CommunityView,
} from './controller';
import {
  decodeReportProgress,
  decodeReportReceipt,
  decodeReportTarget,
  matchReportReceipt,
  type JuryVote,
  type ReportIntent,
  type ReportOperation,
  type ReportProgress,
  type ReportReceipt,
  type ReportTarget,
} from './report-contract';
import type { PendingReport } from './report-pending';
import type { CommunityRuntime } from './runtime';
type Confirmation =
  | { readonly operation: 'report'; readonly target: ReportTarget }
  | {
      readonly operation: 'vote';
      readonly postId: string;
      readonly juryId: string;
      readonly vote: JuryVote;
    };
export interface ReportMutationView extends CommunityView {
  readonly operation: ReportOperation;
  readonly frozen: boolean;
  readonly confirmation: Confirmation | null;
  readonly receiptStatus: string;
}
export const initialReportMutationView = (
  operation: ReportOperation = 'report',
): ReportMutationView => ({
  ...initialCommunityView(),
  operation,
  frozen: false,
  confirmation: null,
  receiptStatus: '',
});
/** Report and jury vote are separate immutable operations, never ordinary poll ballots. */
export class ReportMutationController extends CommunityController<ReportMutationView> {
  private pending: PendingReport | null = null;
  constructor(
    runtime: CommunityRuntime,
    private readonly operation: ReportOperation,
    render: (view: ReportMutationView) => void,
  ) {
    super(runtime, () => initialReportMutationView(operation), render);
  }
  private get store() {
    return this.operation === 'report'
      ? this.runtime.pendingReports
      : this.runtime.pendingJuryVotes;
  }
  protected override resetPrivate(): void {
    this.pending = null;
  }
  protected override onSafetyInvalidated(): void {
    this.load();
    const owner = this.runtime.sessions.snapshot();
    void Promise.resolve().then(() => {
      if (!this.view.frozen || !this.available()) return;
      try {
        this.runtime.sessions.assertCurrent(owner);
        const accountId = this.accountId();
        if (accountId && !this.store?.load(accountId)) {
          this.pending = null;
          this.update({ frozen: false });
        }
      } catch {
        /* Retain recovery barrier on ownership or storage uncertainty. */
      }
    });
  }
  private ready(): boolean {
    if (!this.available()) return false;
    if (!this.runtime.reports || !this.store) {
      this.update({
        error: '当前构建尚未配置举报与陪审服务',
        status: '暂不可用',
      });
      return false;
    }
    return true;
  }
  load(): void {
    this.stop();
    this.update({
      busy: false,
      confirmation: null,
      error: '',
      receiptStatus: '',
    });
    if (!this.ready()) return;
    try {
      const pending = this.store!.load(this.accountId()!);
      if (pending) this.show(pending);
      else {
        this.pending = null;
        this.update({ frozen: false, status: '原请求恢复已就绪' });
      }
    } catch (error) {
      this.update({
        frozen: true,
        error: communityError(error),
        status: '无法读取原请求，禁止发送新请求',
      });
    }
  }
  private show(pending: PendingReport): void {
    this.pending = pending;
    this.update({
      frozen: true,
      confirmation: null,
      status: '原请求结果待确认，请查询回执或重试完全相同的请求',
    });
  }
  private canConfirm(): boolean {
    if (
      this.view.busy ||
      this.view.frozen ||
      this.view.confirmation ||
      !this.ready()
    )
      return false;
    try {
      const pending = this.store!.load(this.accountId()!);
      if (pending) {
        this.show(pending);
        return false;
      }
      return true;
    } catch (error) {
      this.update({ frozen: true, error: communityError(error) });
      return false;
    }
  }
  requestReport(
    kind: ReportTarget['kind'],
    item: {
      readonly id: string;
      readonly viewer: { readonly isSelf: boolean };
    },
  ): void {
    if (this.operation !== 'report' || item.viewer.isSelf || !this.canConfirm())
      return;
    try {
      this.update({
        confirmation: {
          operation: 'report',
          target: decodeReportTarget({ kind, id: item.id }),
        },
        error: '',
        receiptStatus: '',
      });
    } catch (error) {
      this.update({ error: communityError(error) });
    }
  }
  requestVote(raw: ReportProgress, vote: JuryVote): void {
    if (this.operation !== 'vote' || !this.canConfirm()) return;
    try {
      const progress = decodeReportProgress(raw);
      if (
        progress.kind !== 'post' ||
        progress.isSelf ||
        progress.hasReported ||
        !progress.jury ||
        progress.jury.state !== 'pending' ||
        progress.jury.ownVote !== null ||
        progress.jury.voteCapability.status !== 'allow' ||
        !['keep', 'remove'].includes(vote)
      )
        return;
      this.update({
        confirmation: {
          operation: 'vote',
          postId: progress.id,
          juryId: progress.jury.juryId,
          vote,
        },
        error: '',
        receiptStatus: '',
      });
    } catch (error) {
      this.update({ error: communityError(error) });
    }
  }
  dismiss(): void {
    this.update({ confirmation: null });
  }
  override cancel(): void {
    super.cancel();
    this.dismiss();
  }
  async confirm(): Promise<void> {
    const confirmation = this.view.confirmation;
    if (!confirmation || this.view.busy || this.view.frozen || !this.ready())
      return;
    this.update({ confirmation: null });
    const accountId = this.accountId()!,
      owner = this.runtime.sessions.snapshot();
    try {
      const old = this.store!.load(accountId);
      if (old) {
        this.show(old);
        return;
      }
    } catch (error) {
      this.update({ frozen: true, error: communityError(error) });
      return;
    }
    await this.run(
      async (cancel) => {
        const clientRequestId = await this.runtime.newRequestId();
        this.runtime.sessions.assertCurrent(owner);
        if (cancel.isCancelled)
          throw new ClientError('cancelled', 'Cancelled before persistence');
        const pending = this.store!.freeze({
          version: 1,
          accountId,
          intent: { ...confirmation, clientRequestId } as ReportIntent,
        });
        this.show(pending);
        return this.dispatch(pending, cancel);
      },
      (result) => this.settle(result),
      (error) =>
        this.update({
          frozen: this.view.frozen || error.kind === 'storage',
          status: '结果未知；原请求可能已受理，请查询原回执',
        }),
    );
  }
  private dispatch(
    pending: PendingReport,
    cancel: Cancellation,
  ): Promise<ReportReceipt> {
    if (pending.accountId !== this.accountId())
      throw new ClientError('stale-session', 'Account changed');
    if (
      JSON.stringify(this.store!.load(pending.accountId)) !==
      JSON.stringify(pending)
    )
      throw new ClientError('storage', 'Pending report changed');
    return this.runtime.reports!.apply(pending.intent, cancel);
  }
  async recover(retry = false): Promise<void> {
    if (this.view.busy || !this.ready()) return;
    try {
      const accountId = this.accountId()!;
      let pending = this.store!.load(accountId);
      if (!pending && this.pending?.accountId === accountId)
        pending = this.store!.freeze(this.pending);
      if (!pending) {
        this.update({ error: '未找到原请求，请重新打开页面' });
        return;
      }
      this.show(pending);
      const original = pending;
      await this.run(
        (cancel) =>
          retry
            ? this.dispatch(original, cancel)
            : this.runtime.reports!.receipt(
                original.intent.clientRequestId,
                cancel,
              ),
        (result) => this.settle(result),
        () =>
          this.update({
            frozen: true,
            status: '原请求仍待确认；未查到回执不代表未受理',
          }),
      );
    } catch (error) {
      this.update({ frozen: true, error: communityError(error) });
    }
  }
  private settle(raw: ReportReceipt): void {
    const pending = this.pending;
    if (!pending || pending.accountId !== this.accountId())
      throw new ClientError('protocol', 'Missing original reporting request');
    const receipt = decodeReportReceipt(raw);
    matchReportReceipt(pending.intent, receipt);
    const receiptStatus =
      receipt.outcome === 'accepted'
        ? receipt.operation === 'report'
          ? '原举报已受理；这不代表已审核或已删除内容'
          : '原陪审意见已受理；最终结果以当前进度或系统通知为准'
        : reasonMessage(receipt.code);
    // A validated committed result invalidates every content owner before fallible journal cleanup.
    this.runtime.safetyChanges?.invalidate(pending.accountId);
    try {
      this.store!.settle(pending, receipt);
    } catch (error) {
      this.pending = pending;
      this.update({
        busy: false,
        frozen: true,
        confirmation: null,
        receiptStatus,
        error: communityError(error),
        status: '服务端结果已确认；本地记录尚未清理，请保留原请求并再次查询',
      });
      return;
    }
    this.pending = null;
    this.update({
      busy: false,
      frozen: false,
      confirmation: null,
      receiptStatus,
      error: '',
      status: '原请求已确认，已重新核验当前内容',
    });
  }
}

export interface ReportProgressView extends CommunityView {
  readonly progress: ReportProgress | null;
  readonly loaded: boolean;
  readonly reportReason: string;
  readonly voteReason: string;
  readonly canReport: boolean;
  readonly canVote: boolean;
  readonly showTallies: boolean;
}
export const initialReportProgressView = (): ReportProgressView => ({
  ...initialCommunityView(),
  progress: null,
  loaded: false,
  reportReason: '',
  voteReason: '',
  canReport: false,
  canVote: false,
  showTallies: false,
});
/** Independent status owner: failure is unknown, never a synthetic no-jury result. Timers only reload. */
export class ReportProgressController extends CommunityController<ReportProgressView> {
  private clearTimer: (() => void) | null = null;
  private targetLossInvalidation = false;
  private targetLossEpoch: number | null = null;
  constructor(
    runtime: CommunityRuntime,
    private readonly target: ReportTarget,
    render: (view: ReportProgressView) => void,
    private readonly clock: Clock = systemClock,
  ) {
    super(runtime, initialReportProgressView, render);
  }
  protected override resetPrivate(): void {
    this.clearTimer?.();
    this.clearTimer = null;
  }
  protected override onSafetyInvalidated(): void {
    if (!this.targetLossInvalidation) void this.load();
  }
  private clear(): void {
    this.resetPrivate();
    this.update({
      progress: null,
      loaded: false,
      reportReason: '',
      voteReason: '',
      canReport: false,
      canVote: false,
      showTallies: false,
    });
  }
  async load(): Promise<void> {
    this.stop();
    this.clear();
    this.update({ busy: false, status: '正在独立查询举报与陪审进度' });
    if (!this.available()) return;
    if (!this.runtime.reports) {
      this.update({
        error: '当前构建尚未配置举报与陪审服务',
        status: '进度未知',
      });
      return;
    }
    await this.run(
      (cancel) =>
        this.runtime.reports!.progress(decodeReportTarget(this.target), cancel),
      (raw) => {
        const progress = decodeReportProgress(raw);
        if (
          progress.kind !== this.target.kind ||
          progress.id !== this.target.id
        )
          throw new ClientError('protocol', 'Report progress target mismatch');
        this.targetLossEpoch = null;
        const jury = progress.kind === 'post' ? progress.jury : null;
        const canVote =
          !!jury &&
          jury.state === 'pending' &&
          jury.ownVote === null &&
          !progress.isSelf &&
          !progress.hasReported &&
          jury.voteCapability.status === 'allow';
        this.update({
          progress,
          loaded: true,
          canReport: progress.reportCapability.status === 'allow',
          reportReason:
            progress.reportCapability.status === 'allow'
              ? ''
              : reasonMessage(progress.reportCapability.code),
          canVote,
          voteReason:
            jury && jury.voteCapability.status !== 'allow'
              ? reasonMessage(jury.voteCapability.code)
              : '',
          showTallies: !!jury && !canVote,
          status: '已读取当前可查看内容的进度；操作资格由服务端重新核验',
        });
        if (jury && jury.state !== 'kept') {
          const remaining = Date.parse(jury.deadline) - this.clock.now();
          this.clearTimer = this.clock.schedule(
            () => {
              this.clearTimer = null;
              void this.load();
            },
            remaining > 0 ? Math.min(remaining, 2_147_483_647) : 30_000,
          );
        }
      },
      (error) => {
        this.clear();
        // A current authoritative loss of target visibility clears other content
        // projections too. Suppress our own event reload and repeated observations.
        if (
          error.kind !== 'protocol' &&
          error.details.serverCode === 'REPORT_TARGET_UNAVAILABLE' &&
          this.targetLossEpoch !== this.runtime.sessions.snapshot().epoch
        ) {
          const accountId = this.accountId();
          this.targetLossEpoch = this.runtime.sessions.snapshot().epoch;
          this.targetLossInvalidation = true;
          try {
            if (accountId) this.runtime.safetyChanges?.invalidate(accountId);
          } finally {
            this.targetLossInvalidation = false;
          }
        }
        this.update({
          error: communityError(error),
          status: '进度未知或目标当前不可查看；不能据此认定未举报或没有陪审',
        });
      },
    );
  }
  override cancel(): void {
    super.cancel();
    this.clear();
  }
}
