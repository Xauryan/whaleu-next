import type { WhaleuApp } from '../../app';
import {
  errandAdminStatusLabels,
  errandAdminStatuses,
} from '../../errands/admin-contract';
import {
  decodeErrandAdminRoute,
  ErrandAdminController,
  initialErrandAdminView,
  type ErrandAdminRoute,
} from '../../errands/admin-controller';
Page({
  data: {
    ...initialErrandAdminView(),
    statusOptions: errandAdminStatuses.map((value) => ({
      value,
      label: errandAdminStatusLabels[value],
    })),
    statusLabels: errandAdminStatusLabels,
  },
  route: null as ErrandAdminRoute | null,
  controller: undefined as ErrandAdminController | undefined,
  onLoad(query: unknown = {}) {
    try {
      this.route = decodeErrandAdminRoute(query);
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
        ...initialErrandAdminView(),
        error: '环境未初始化，请重新打开小程序',
      });
      return;
    }
    this.controller = new ErrandAdminController(runtime, (view) =>
      this.setData({ ...view }),
    );
    void this.controller.load(this.route);
  },
  onRefresh() {
    void this.controller?.reload();
  },
  onNext() {
    void this.controller?.next();
  },
  onPrevious() {
    void this.controller?.previous();
  },
  onCancel() {
    this.controller?.cancel();
  },
  onKeyword(event: { detail: { value: string } }) {
    this.controller?.setKeyword(event.detail.value);
  },
  onSearch() {
    void this.controller?.search();
  },
  onStatus(event: { currentTarget: { dataset: { value?: string } } }) {
    void this.controller?.chooseStatus(event.currentTarget.dataset.value ?? '');
  },
  onRegion(event: { detail: { value: string } }) {
    this.controller?.setRegion(event.detail.value);
  },
  onSelectRegion() {
    void this.controller?.selectRegion();
  },
  onHide() {
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.onHide();
    this.route = null;
  },
});
