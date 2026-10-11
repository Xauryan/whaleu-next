import type { WhaleuApp } from '../../app';
import { FeedbackController, initialFeedbackView } from './controller';
Page({
  data: initialFeedbackView(),
  controller: undefined as FeedbackController | undefined,
  onShow() {
    this.controller?.dispose();
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({ error: '环境未初始化，请重新打开小程序' });
      return;
    }
    this.controller = new FeedbackController(runtime, (view) =>
      this.setData({ ...view }),
    );
    void this.controller.load();
  },
  onRefresh() {
    void this.controller?.load();
  },
  onMore() {
    void this.controller?.more();
  },
  onCancel() {
    this.controller?.cancel();
  },
  onHide() {
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.controller?.dispose();
    this.controller = undefined;
  },
});
