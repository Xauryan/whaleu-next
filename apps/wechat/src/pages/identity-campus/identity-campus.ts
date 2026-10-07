import type { WhaleuApp } from '../../app';
import {
  IdentityCampusController,
  initialIdentityCampusView,
} from './controller';
Page({
  data: { ...initialIdentityCampusView() },
  controller: undefined as IdentityCampusController | undefined,
  onShow() {
    this.controller?.dispose();
    this.controller = undefined;
    const runtime = getApp<WhaleuApp>().identityCampus;
    if (!runtime) {
      this.setData({
        ...initialIdentityCampusView(),
        error: '环境未初始化，请重新打开小程序',
      });
      return;
    }
    this.controller = new IdentityCampusController(runtime, (view) =>
      this.setData({ ...view }),
    );
    void this.controller.load();
  },
  onChoose(event: { currentTarget: { dataset: { id: string } } }) {
    this.controller?.choose(event.currentTarget.dataset.id);
  },
  onRequestConfirmation() {
    this.controller?.requestConfirmation();
  },
  onDismissConfirmation() {
    this.controller?.dismissConfirmation();
  },
  onConfirm() {
    void this.controller?.confirm();
  },
  onReload() {
    void this.controller?.load();
  },
  onReceipt() {
    void this.controller?.recover();
  },
  onRetry() {
    void this.controller?.recover(true);
  },
  onCancel() {
    this.controller?.cancel();
  },
  onHide() {
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.controller?.dispose();
    this.controller = undefined;
  },
});
