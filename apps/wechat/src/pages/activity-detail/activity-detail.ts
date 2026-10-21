import type { WhaleuApp } from '../../app';
import {
  ActivityController,
  decodeActivityRoute,
  initialActivityView,
  type ActivityRoute,
} from '../../activities/controller';
import {
  activityDisplayTimestamp,
  initialActivityPanels,
  toggledActivityPanels,
} from '../activity-list/presentation';
Page({
  data: {
    ...initialActivityView(),
    uiPanels: initialActivityPanels(),
    publishedAtLabel: '',
  },
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
    this.setData({
      uiPanels: initialActivityPanels(),
      publishedAtLabel: '',
    });
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({
        ...initialActivityView(),
        error: '环境未初始化，请重新打开小程序',
      });
      return;
    }
    this.controller = new ActivityController(runtime, 'detail', (view) =>
      this.setData({
        ...view,
        publishedAtLabel: activityDisplayTimestamp(
          view.detail?.createdAt.status === 'known'
            ? view.detail.createdAt.value
            : null,
        ),
      }),
    );
    void this.controller.load(this.route);
  },
  onRefresh() {
    void this.controller?.refresh();
  },
  onCancel() {
    this.controller?.cancel();
  },
  onTogglePanel(e: { currentTarget: { dataset: { field: string } } }) {
    this.setData({
      uiPanels: toggledActivityPanels(
        this.data.uiPanels,
        e.currentTarget.dataset.field,
      ),
    });
  },
  onHide() {
    this.controller?.dispose();
    this.controller = undefined;
    this.setData({
      uiPanels: initialActivityPanels(),
      publishedAtLabel: '',
    });
  },
  onUnload() {
    this.controller?.dispose();
    this.controller = undefined;
    this.route = null;
    this.setData({
      uiPanels: initialActivityPanels(),
      publishedAtLabel: '',
    });
  },
});
