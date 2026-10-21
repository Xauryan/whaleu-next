import type {
  SchoolQrReader,
  SchoolQrReadView,
} from '../../school-configuration/qr-runtime';
import type { WhaleuApp } from '../../app';
import { HttpProfileGateway } from '../../profile/gateway';
import { HttpSchoolConfigurationGateway } from '../../school-configuration/gateway';
import {
  SchoolServicesController,
  initialSchoolServicesView,
} from '../../school-configuration/public-controller';
import { schoolKey, schoolUuid } from '../../school-configuration/contract';
Page({
  data: {
    ...initialSchoolServicesView(),
    showInfo: false,
    qr: { status: 'idle', src: '', message: '' } as SchoolQrReadView,
  },
  reader: undefined as SchoolQrReader | undefined,
  campusId: null as string | null,
  routeInvalid: false,
  controller: undefined as SchoolServicesController | undefined,
  onLoad(query: { campusId?: string } = {}) {
    try {
      if (Object.keys(query).some((key) => key !== 'campusId'))
        throw new Error('Invalid route');
      this.campusId = query.campusId ? schoolUuid(query.campusId) : null;
    } catch {
      this.routeInvalid = true;
      this.campusId = null;
      this.setData({ error: '校园入口无效，请重新选择校区' });
    }
  },
  onShow() {
    this.controller?.dispose();
    this.reader?.dispose();
    this.reader = getApp<WhaleuApp>().schoolQr?.createReader((qr) =>
      this.setData({ qr }),
    );
    const runtime = getApp<WhaleuApp>().identity;
    this.setData({ ...initialSchoolServicesView(), showInfo: false });
    if (this.routeInvalid) {
      this.setData({ error: '校园入口无效，请重新选择校区' });
      return;
    }
    if (!runtime?.api) {
      this.setData({ error: '环境尚未配置，请稍后重试' });
      return;
    }
    this.controller = new SchoolServicesController(
      runtime.sessions,
      new HttpSchoolConfigurationGateway(runtime.api),
      new HttpProfileGateway(runtime.api),
      {
        set: (value) =>
          new Promise<void>((resolve, reject) => {
            if (!wx.setClipboardData) {
              reject(new Error('Clipboard unavailable'));
              return;
            }
            wx.setClipboardData({
              data: value,
              success: () => resolve(),
              fail: () => reject(new Error('Clipboard unavailable')),
            });
          }),
      },
      (view) => {
        this.reader?.clear();
        this.setData({ ...view });
      },
    );
    void this.controller.load(this.campusId);
  },
  onToggleInfo() {
    this.setData({ showInfo: !this.data.showInfo });
  },
  onRefresh() {
    this.reader?.clear();
    void this.controller?.refresh();
  },
  onPreview(event: { currentTarget: { dataset: { key: string } } }) {
    try {
      const target = this.controller?.previewContext(
        schoolKey(event.currentTarget.dataset.key),
      );
      if (target && this.reader) void this.reader.load(target);
      else this.setData({ error: '二维码暂不可预览，请刷新当前学校资料' });
    } catch {
      this.setData({ error: '二维码入口无效' });
    }
  },
  onCloseQr() {
    this.reader?.clear();
  },
  onCopy(event: {
    currentTarget: {
      dataset: {
        key: string;
        field: 'wechatId' | 'qqGroupNumber' | 'joinUrl' | 'name';
      };
    };
  }) {
    try {
      void this.controller?.copy(
        schoolKey(event.currentTarget.dataset.key),
        event.currentTarget.dataset.field,
      );
    } catch {
      this.setData({ error: '复制入口无效' });
    }
  },
  onHide() {
    this.setData({ showInfo: false });
    this.controller?.dispose();
    this.controller = undefined;
    this.reader?.dispose();
    this.reader = undefined;
  },
  onUnload() {
    this.setData({ showInfo: false });
    this.controller?.dispose();
    this.controller = undefined;
    this.reader?.dispose();
    this.reader = undefined;
  },
});
