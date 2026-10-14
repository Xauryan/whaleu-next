import type { WhaleuApp } from '../../app';
import { clientConfiguration } from '../../config';
import { WechatStorage } from '../../platform/wechat';
import {
  OfficialController,
  initialOfficialView,
} from '../../official-account-operations/controller';
import { HttpOfficialGateway } from '../../official-account-operations/gateway';
import { OfficialCommandJournal } from '../../official-account-operations/journal';
Page({
  data: { ...initialOfficialView(), programInput: '' },
  controller: undefined as OfficialController | undefined,
  onLoad(options: { programId?: string }) {
    this.setData({ programInput: options.programId ?? '' });
  },
  onShow() {
    this.controller?.dispose();
    const app = getApp<WhaleuApp>();
    if (!app.identity?.api || !app.community) {
      this.setData({ error: '环境尚未配置' });
      return;
    }
    this.controller = new OfficialController(
      app.identity.sessions,
      new HttpOfficialGateway(app.identity.api),
      new OfficialCommandJournal(
        new WechatStorage(wx),
        clientConfiguration.apiOrigin,
      ),
      app.community.newRequestId,
      (view) => this.setData({ ...view }),
    );
    void this.controller.load(this.data.programInput);
  },
  onProgram(event: { detail: { value: string } }) {
    this.controller?.hide();
    this.setData({ programInput: event.detail.value });
  },
  onLoadProgram() {
    void this.controller?.load(this.data.programInput);
  },
  onAuthor(event: { detail: { value: string } }) {
    this.controller?.setAuthor(event.detail.value);
  },
  onArtwork(event: {
    currentTarget: {
      dataset: {
        purpose: 'cover' | 'title';
        action: 'keep' | 'clear' | 'replace';
      };
    };
  }) {
    const { purpose, action } = event.currentTarget.dataset;
    this.controller?.setArtwork(purpose, action);
  },
  onAppearance(event: {
    currentTarget: { dataset: { purpose: 'cover' | 'title' } };
    detail: { value: string };
  }) {
    this.controller?.setArtwork(
      event.currentTarget.dataset.purpose,
      'replace',
      event.detail.value,
    );
  },
  onSave() {
    void this.controller?.save();
  },
  onPreview() {
    void this.controller?.preview('daily_hot');
  },
  onTestPreview() {
    void this.controller?.preview('test');
  },
  onCreateTest() {
    void this.controller?.createTest();
  },
  onRecover() {
    void this.controller?.recover();
  },
  onRetry() {
    void this.controller?.recover('retry');
  },
  onCancel() {
    void this.controller?.recover('cancel');
  },
  onResume() {
    void this.controller?.recover('resume');
  },
  onHide() {
    this.controller?.hide();
  },
  onUnload() {
    this.controller?.dispose();
  },
});
