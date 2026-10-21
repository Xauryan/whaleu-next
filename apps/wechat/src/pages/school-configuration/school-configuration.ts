import type {
  SchoolQrUploader,
  SchoolQrReader,
  SchoolQrUploadView,
  SchoolQrReadView,
} from '../../school-configuration/qr-runtime';
import type { WhaleuApp } from '../../app';
import { clientConfiguration } from '../../config';
import { WechatStorage } from '../../platform/wechat';
import { HttpProfileGateway } from '../../profile/gateway';
import { HttpSchoolConfigurationGateway } from '../../school-configuration/gateway';
import { SchoolCommandJournal } from '../../school-configuration/pending';
import {
  SchoolAdminController,
  initialSchoolAdminView,
} from '../../school-configuration/admin-controller';
import { schoolKey } from '../../school-configuration/contract';
Page({
  data: {
    uiPanel: '',
    ...initialSchoolAdminView(),
    qrUpload: {
      status: 'idle',
      message: '',
      progress: 0,
    } as SchoolQrUploadView,
    qrRead: { status: 'idle', message: '', src: '' } as SchoolQrReadView,
  },
  uploader: undefined as SchoolQrUploader | undefined,
  reader: undefined as SchoolQrReader | undefined,
  controller: undefined as SchoolAdminController | undefined,
  onToggleUiPanel(event: { currentTarget: { dataset: { panel?: string } } }) {
    const panel = event.currentTarget.dataset.panel ?? '';
    this.setData({ uiPanel: this.data.uiPanel === panel ? '' : panel });
  },
  onShow() {
    this.setData({ uiPanel: '' });
    this.controller?.dispose();
    this.uploader?.dispose();
    this.reader?.dispose();
    this.setData({ ...initialSchoolAdminView() });
    const app = getApp<WhaleuApp>(),
      runtime = app.identity;
    if (!runtime?.api || !app.community) {
      this.setData({ error: '环境尚未配置，请稍后重试' });
      return;
    }
    this.uploader = app.schoolQr?.createUploader((qrUpload) =>
      this.setData({ qrUpload }),
    );
    this.reader = app.schoolQr?.createReader((qrRead) =>
      this.setData({ qrRead }),
    );
    this.controller = new SchoolAdminController(
      runtime.sessions,
      new HttpSchoolConfigurationGateway(runtime.api),
      new HttpProfileGateway(runtime.api),
      new SchoolCommandJournal(
        new WechatStorage(wx),
        clientConfiguration.apiOrigin,
      ),
      app.community.newRequestId,
      (view) => {
        this.reader?.clear();
        this.setData({
          ...view,
          ...(!view.loaded || view.management === 'none'
            ? { uiPanel: '' }
            : {}),
        });
      },
    );
    void this.controller.load();
  },
  onRefresh() {
    this.reader?.clear();
    this.uploader?.clear();
    void this.controller?.refresh();
  },
  onCampusQuery(event: { detail: { value: string } }) {
    this.controller?.setCampusQuery(event.detail.value);
  },
  onSearchCampus() {
    void this.controller?.searchCampuses();
  },
  onChooseCampus(event: { currentTarget: { dataset: { id: string } } }) {
    void this.controller?.chooseCampus(event.currentTarget.dataset.id);
  },
  onChooseEntry(event: { currentTarget: { dataset: { key: string } } }) {
    this.reader?.clear();
    this.uploader?.clear();
    try {
      this.controller?.chooseEntry(schoolKey(event.currentTarget.dataset.key));
    } catch {
      this.setData({ error: '配置入口无效' });
    }
  },
  onField(event: {
    currentTarget: { dataset: { field: string } };
    detail: { value: string | boolean };
  }) {
    this.controller?.setField(
      event.currentTarget.dataset.field,
      event.detail.value,
    );
  },
  async onPickQr() {
    const controller = this.controller,
      uploader = this.uploader,
      target = controller?.qrTarget();
    if (!target || !uploader) return;
    const assetId = await uploader.pick(target);
    if (assetId && this.controller === controller && this.uploader === uploader)
      controller?.setQrAsset(target, assetId);
  },
  async onRecoverQr() {
    const controller = this.controller,
      uploader = this.uploader,
      target = controller?.qrTarget();
    if (!target || !uploader) return;
    const assetId = await uploader.recover(target);
    if (assetId && this.controller === controller && this.uploader === uploader)
      controller?.setQrAsset(target, assetId);
  },
  async onCancelQr() {
    const controller = this.controller,
      uploader = this.uploader;
    try {
      uploader?.clear();
      await uploader?.cancelPending();
      if (this.controller === controller && this.uploader === uploader)
        controller?.keepQr();
    } catch {
      this.setData({ error: '上传撤回尚未确认，请重试原上传恢复' });
    }
  },
  onPreviewQr() {
    const target = this.controller?.previewContext();
    if (target && this.reader) void this.reader.load(target);
  },
  onCloseQr() {
    this.reader?.clear();
  },
  onKeepQr() {
    this.controller?.keepQr();
  },
  onRemoveQr() {
    this.controller?.removeQr();
  },
  onSave() {
    void this.controller?.save();
  },
  onRecover() {
    void this.controller?.recover();
  },
  onRetry() {
    void this.controller?.recover(true);
  },
  onCancelPending() {
    void this.controller?.cancelPending();
  },
  onHide() {
    this.setData({ uiPanel: '' });
    this.controller?.dispose();
    this.controller = undefined;
    this.reader?.dispose();
    this.reader = undefined;
    this.uploader?.dispose();
    this.uploader = undefined;
  },
  onUnload() {
    this.setData({ uiPanel: '' });
    this.controller?.dispose();
    this.controller = undefined;
    this.reader?.dispose();
    this.reader = undefined;
    this.uploader?.dispose();
    this.uploader = undefined;
  },
});
