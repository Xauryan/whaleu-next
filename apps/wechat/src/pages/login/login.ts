import { Cancellation } from '../../platform/contracts';
import { routeSuspendedLogin } from '../../account-moderation/login-routing';
import type { WhaleuApp } from '../../app';
import { initialLoginView, LoginController } from './controller';

Page({
  data: { ...initialLoginView() },
  visible: false,
  moderationRead: undefined as Cancellation | undefined,
  controller: undefined as LoginController | undefined,
  onLoad() {
    const runtime = getApp<WhaleuApp>().identity;
    if (!runtime) {
      this.setData({ error: '登录环境未初始化，请重新打开小程序' });
      return;
    }
    this.controller = new LoginController(runtime, (view) =>
      this.setData({ ...view }),
    );
  },
  onShow() {
    this.visible = true;
    this.controller?.syncSession();
  },
  async onLogin() {
    const controller = this.controller;
    await controller?.login();
    if (controller === this.controller) await this.routeRestriction();
  },
  async onCheckSession() {
    const controller = this.controller;
    await controller?.checkSession();
    if (controller === this.controller) await this.routeRestriction();
  },
  async routeRestriction() {
    const runtime = getApp<WhaleuApp>().identity;
    if (!runtime || !this.visible) return;
    this.moderationRead?.cancel();
    const cancellation = new Cancellation();
    this.moderationRead = cancellation;
    await routeSuspendedLogin(
      runtime,
      wx,
      cancellation,
      () => this.visible && this.moderationRead === cancellation,
    );
  },
  onHide() {
    this.visible = false;
    this.moderationRead?.cancel();
    this.moderationRead = undefined;
  },
  onLogout() {
    void this.controller?.logout();
  },
  onUnload() {
    this.onHide();
    this.controller?.dispose();
    this.controller = undefined;
  },
});
