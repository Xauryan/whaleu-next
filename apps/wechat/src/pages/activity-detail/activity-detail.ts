import type { WhaleuApp } from '../../app';
import {
  ActivityController,
  decodeActivityRoute,
  initialActivityView,
  type ActivityRoute,
} from '../../activities/controller';
Page({
  data: initialActivityView(),
  route: null as ActivityRoute | null,
  controller: undefined as ActivityController | undefined,
  onLoad(query: unknown = {}) {
    try {
      this.route = decodeActivityRoute(query);
    } catch {
      this.route = null;
    }
  },
  onShow() {
    this.controller?.dispose();
    this.controller = undefined;
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({
        ...initialActivityView(),
        error: '环境未初始化，请重新打开小程序',
      });
      return;
    }
    this.controller = new ActivityController(runtime, 'detail', (view) =>
      this.setData({ ...view }),
    );
    void this.controller.load(this.route);
  },
  onRefresh() {
    void this.controller?.refresh();
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
    this.route = null;
  },
});
