import type { WhaleuApp } from '../../app';
import { initialLoginView, LoginController } from './controller';

Page({
  data: { ...initialLoginView() },
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
  onLogin() {
    void this.controller?.login();
  },
  onCheckSession() {
    void this.controller?.checkSession();
  },
  onLogout() {
    void this.controller?.logout();
  },
  onUnload() {
    this.controller?.dispose();
    this.controller = undefined;
  },
});
