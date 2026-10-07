import type { WhaleuApp } from '../../app';
import {
  ReportMutationController,
  ReportProgressController,
  initialReportMutationView,
  initialReportProgressView,
} from '../../community/report-controller';
import {
  decodeReportTarget,
  type ReportTarget,
} from '../../community/report-contract';
Page({
  data: {
    loaded: false,
    error: '',
    report: initialReportMutationView(),
    juryVote: initialReportMutationView('vote'),
    reportProgress: initialReportProgressView(),
    hasTarget: false,
    addressError: '',
  },
  target: null as ReportTarget | null,
  controller: undefined as ReportMutationController | undefined,
  juryVotes: undefined as ReportMutationController | undefined,
  progress: undefined as ReportProgressController | undefined,
  onLoad(query: { kind?: string; id?: string } = {}) {
    if (query.kind === undefined && query.id === undefined) return;
    try {
      this.target = decodeReportTarget({ kind: query.kind, id: query.id });
      this.setData({ hasTarget: true });
    } catch {
      this.setData({ addressError: '进度地址无效；仍可恢复本账号原请求' });
    }
  },
  onShow() {
    this.onHide();
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({ addressError: '环境尚未初始化' });
      return;
    }
    this.controller = new ReportMutationController(runtime, 'report', (view) =>
      this.setData({ report: view, error: view.error }),
    );
    this.juryVotes = new ReportMutationController(runtime, 'vote', (view) =>
      this.setData({ juryVote: view }),
    );
    this.controller.load();
    this.juryVotes.load();
    if (this.target) {
      this.progress = new ReportProgressController(
        runtime,
        this.target,
        (view) => {
          this.setData({ reportProgress: view });
          if (!view.loaded) {
            this.controller?.dismiss();
            this.juryVotes?.dismiss();
          }
        },
      );
      void this.progress.load();
    }
  },
  onReport() {
    const progress = this.data.reportProgress;
    if (progress.loaded && progress.canReport && progress.progress)
      this.controller?.requestReport(progress.progress.kind, {
        id: progress.progress.id,
        viewer: { isSelf: progress.progress.isSelf },
      });
  },
  onConfirmReport() {
    void this.controller?.confirm();
  },
  onDismissReport() {
    this.controller?.dismiss();
  },
  onReportReceipt() {
    void this.controller?.recover();
  },
  onReportRetry() {
    void this.controller?.recover(true);
  },
  onReportCancel() {
    this.controller?.cancel();
  },
  onJuryChoice(event: { currentTarget: { dataset: { vote: string } } }) {
    const vote = event.currentTarget.dataset.vote;
    if (
      (vote === 'keep' || vote === 'remove') &&
      this.data.reportProgress.progress
    )
      this.juryVotes?.requestVote(this.data.reportProgress.progress, vote);
  },
  onConfirmJuryVote() {
    void this.juryVotes?.confirm();
  },
  onDismissJuryVote() {
    this.juryVotes?.dismiss();
  },
  onJuryReceipt() {
    void this.juryVotes?.recover();
  },
  onJuryRetry() {
    void this.juryVotes?.recover(true);
  },
  onJuryCancel() {
    this.juryVotes?.cancel();
  },
  onReloadReportProgress() {
    void this.progress?.load();
  },
  onCancelReportProgress() {
    this.progress?.cancel();
  },
  onReloadRecovery() {
    this.controller?.load();
    this.juryVotes?.load();
  },
  onHide() {
    this.progress?.dispose();
    this.progress = undefined;
    this.controller?.dispose();
    this.controller = undefined;
    this.juryVotes?.dispose();
    this.juryVotes = undefined;
  },
  onUnload() {
    this.onHide();
  },
});
