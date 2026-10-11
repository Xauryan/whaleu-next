import type { WhaleuApp } from '../../app';
import { clientConfiguration } from '../../config';
import { WechatStorage } from '../../platform/wechat';
import {
  HttpPhoneGateway,
  PhoneBindingController,
} from '../../verification/phone-binding';
Page({
  data: {
    busy: false,
    hasSession: false,
    configured: false,
    phase: 'idle',
    requestId: '',
    message: '',
  },
  phone: undefined as PhoneBindingController | undefined,
  onShow() {
    this.phone?.dispose();
    const app = getApp<WhaleuApp>();
    if (!app.identity?.api || !app.community) {
      this.setData({
        busy: false,
        hasSession: false,
        configured: false,
        phase: 'idle',
        requestId: '',
        message: '手机号授权暂不可用，请先配置 API 并登录。',
      });
      return;
    }
    this.phone = new PhoneBindingController(
      app.identity.sessions,
      app.identity.api ? new HttpPhoneGateway(app.identity.api) : undefined,
      new WechatStorage(wx),
      clientConfiguration.apiOrigin,
      app.community.newRequestId,
      (view) => this.setData({ ...view }),
      app.verification?.privateViews,
    );
    void this.phone.restore();
  },
  onPrepare() {
    void this.phone?.prepare();
  },
  onRecover() {
    void this.phone?.recover();
  },
  onClose() {
    void this.phone?.close();
  },
  onPhone(event: { detail: { errMsg?: string; code?: string } }) {
    void this.phone?.authorize(event.detail);
  },
  onHide() {
    this.phone?.dispose();
    this.phone = undefined;
  },
  onUnload() {
    this.phone?.dispose();
    this.phone = undefined;
  },
});
