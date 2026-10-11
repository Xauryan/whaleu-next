import { ClientError } from '../../api/errors';
import type { WhaleuApp } from '../../app';
import {
  FeedbackNoticesController,
  initialFeedbackNoticesView,
} from './controller';

Page({
  data: initialFeedbackNoticesView(),
  controller: undefined as FeedbackNoticesController | undefined,
  onShow() {
    this.controller?.dispose();
    this.controller = undefined;
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({
        ...initialFeedbackNoticesView(),
        error: '环境未初始化，请重新打开小程序',
      });
      return;
    }
    this.controller = new FeedbackNoticesController(
      runtime,
      (view) => this.setData({ ...view }),
      (url) =>
        new Promise<void>((resolve, reject) => {
          if (!wx.navigateTo) {
            reject(new ClientError('configuration', 'Navigation unavailable'));
            return;
          }
          wx.navigateTo({
            url,
            success: resolve,
            fail: () => reject(new ClientError('network', 'Navigation failed')),
          });
        }),
    );
    void this.controller.load();
  },
  onReload() {
    void this.controller?.load();
  },
  onMore() {
    void this.controller?.more();
  },
  onOpen(event: { currentTarget: { dataset: { id: string } } }) {
    void this.controller?.open(event.currentTarget.dataset.id);
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
