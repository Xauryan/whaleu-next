import type { WhaleuApp } from '../../app';
import { ClientError, isRecord } from '../../api/errors';
import {
  initialRatingUpdatesView,
  RatingUpdatesController,
} from '../../ratings/updates-controller';
Page({
  data: initialRatingUpdatesView(),
  validRoute: false,
  controller: undefined as RatingUpdatesController | undefined,
  onLoad(query: unknown = {}) {
    this.validRoute = isRecord(query) && Object.keys(query).length === 0;
  },
  onShow() {
    this.controller?.dispose();
    this.controller = undefined;
    if (!this.validRoute) {
      this.setData({
        ...initialRatingUpdatesView(),
        error: '评分更新链接无效',
      });
      return;
    }
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({
        ...initialRatingUpdatesView(),
        error: '环境未初始化，请重新打开小程序',
      });
      return;
    }
    this.controller = new RatingUpdatesController(
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
  onRefresh() {
    void this.controller?.load();
  },
  onCategory(event: { currentTarget: { dataset: { category?: string } } }) {
    const category = event.currentTarget.dataset.category;
    if (
      category === 'reply' ||
      category === 'like' ||
      category === 'subscription'
    )
      void this.controller?.selectCategory(category);
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
    this.validRoute = false;
  },
});
