import type { WhaleuApp } from '../../app';
import {
  decodeAdminPostRemovalTarget,
  type AdminPostRemovalTarget,
} from '../../admin-post-removal/contract';
import {
  AdminPostRemovalController,
  initialAdminPostRemovalView,
} from '../../admin-post-removal/controller';
Page({
  data: { ...initialAdminPostRemovalView(), addressError: '' },
  target: null as AdminPostRemovalTarget | null,
  controller: undefined as AdminPostRemovalController | undefined,
  onLoad(query: { kind?: string; id?: string } = {}) {
    this.target = null;
    if (query.kind === undefined && query.id === undefined) return;
    try {
      this.target = decodeAdminPostRemovalTarget({
        kind: query.kind,
        id: query.id,
      });
    } catch {
      this.setData({ addressError: '内容地址无效；仍可恢复本账号原请求' });
    }
  },
  onShow() {
    this.onHide();
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({ addressError: '环境尚未初始化' });
      return;
    }
    this.controller = new AdminPostRemovalController(
      runtime,
      (view) => this.setData({ ...view }),
      () => getApp<WhaleuApp>().profileAvatar?.invalidate(),
    );
    void this.controller.load(this.target ?? undefined);
  },
  onReload() {
    getApp<WhaleuApp>().profileAvatar?.invalidate();
    void this.controller?.load(this.target ?? undefined);
  },
  onRemovePost() {
    if (this.target) void this.controller?.request(this.target);
  },
  onSubmit() {
    getApp<WhaleuApp>().profileAvatar?.invalidate();
    void this.controller?.submit();
  },
  onClose() {
    getApp<WhaleuApp>().profileAvatar?.invalidate();
    this.controller?.closeConfirmation();
  },
  onRecover() {
    void this.controller?.recover();
  },
  onRetry() {
    void this.controller?.recover(true);
  },
  onCancelRequest() {
    this.controller?.requestCancellation();
  },
  onConfirmCancel() {
    void this.controller?.confirmCancellation();
  },
  onStopWaiting() {
    this.controller?.cancel();
  },
  onHide() {
    getApp<WhaleuApp>().profileAvatar?.invalidate();
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.onHide();
  },
});
