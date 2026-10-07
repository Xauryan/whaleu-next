import type { WhaleuApp } from '../../app';
import { initialVerificationView, VerificationController } from './controller';

Page({
  data: { ...initialVerificationView() },
  controller: undefined as VerificationController | undefined,
  onShow() {
    this.controller?.dispose();
    this.controller = undefined;
    const app = getApp<WhaleuApp>();
    if (!app.identity || !app.verification) {
      this.setData({
        ...initialVerificationView(),
        error: '环境未初始化，请重新打开小程序',
      });
      return;
    }
    this.controller = new VerificationController(
      app.identity.sessions,
      app.verification.gateway,
      (view) => this.setData({ ...view }),
      app.verification.privateViews,
    );
    void this.controller.load();
  },
  onReload() {
    void this.controller?.load();
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
