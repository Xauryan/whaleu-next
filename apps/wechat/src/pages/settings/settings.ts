import type { WhaleuApp } from '../../app';
import type { PreferenceKey } from '../../profile/contract';
import { HttpProfileGateway } from '../../profile/gateway';
import { initialProfileView, ProfileController } from '../profile/controller';
Page({
  data: { ...initialProfileView() },
  controller: undefined as ProfileController | undefined,
  onShow() {
    this.controller?.dispose();
    this.controller = undefined;
    this.setData({ ...initialProfileView() });
    const runtime = getApp<WhaleuApp>().identity;
    if (!runtime) {
      this.setData({ error: '环境未初始化，请重新打开小程序' });
      return;
    }
    this.controller = new ProfileController(
      runtime.sessions,
      runtime.api ? new HttpProfileGateway(runtime.api) : undefined,
      (view) => this.setData({ ...view }),
    );
    void this.controller.load();
  },
  onPreference(event: {
    detail: { value: boolean };
    currentTarget: { dataset: { key: PreferenceKey } };
  }) {
    this.controller?.setPreference(
      event.currentTarget.dataset.key,
      event.detail.value,
    );
  },
  async onSavePreferences() {
    getApp<WhaleuApp>().profileAvatar?.invalidate();
    await this.controller?.savePreferences();
  },
  onCancelEdits() {
    this.controller?.cancelEdits();
  },
  onCancelOperation() {
    this.controller?.cancelOperation();
  },
  onReload() {
    void this.controller?.load();
  },
  onHide() {
    this.controller?.dispose();
    this.controller = undefined;
    this.setData({ ...initialProfileView() });
  },
  onUnload() {
    this.onHide();
  },
});
