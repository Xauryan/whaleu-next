import type { WhaleuApp } from '../../app';
import {
  SystemNoticesController,
  initialSystemNoticesView,
} from './controller';

Page({
  data: initialSystemNoticesView(),
  controller: undefined as SystemNoticesController | undefined,
  onShow() {
    this.controller?.dispose();
    this.controller = undefined;
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({
        ...initialSystemNoticesView(),
        error: '环境未初始化，请重新打开小程序',
      });
      return;
    }
    this.controller = new SystemNoticesController(runtime, (view) =>
      this.setData({ ...view }),
    );
    void this.controller.load();
  },
  onReload() {
    void this.controller?.load();
  },
  onMore() {
    void this.controller?.more();
  },
  onRead(event: { currentTarget: { dataset: { id: string } } }) {
    void this.controller?.acknowledge(event.currentTarget.dataset.id);
  },
  onCancel() {
    this.controller?.cancel();
  },
  onHide() {
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.onHide();
  },
});
