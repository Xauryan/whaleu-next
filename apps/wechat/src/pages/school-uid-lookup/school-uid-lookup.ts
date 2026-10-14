import type { WhaleuApp } from '../../app';
import {
  SchoolUidLookupController,
  initialSchoolUidLookupView,
} from '../../school-uid/controller';
Page({
  data: { ...initialSchoolUidLookupView() },
  controller: undefined as SchoolUidLookupController | undefined,
  onShow() {
    this.onHide();
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({ error: '环境尚未初始化' });
      return;
    }
    this.controller = new SchoolUidLookupController(runtime, (view) =>
      this.setData({ ...view }),
    );
    void this.controller.load();
  },
  onReload() {
    void this.controller?.load();
  },
  onQuery(event: { detail: { value: string } }) {
    this.controller?.setQuery(event.detail.value);
  },
  onUid(event: { detail: { value: string } }) {
    this.controller?.setUid(event.detail.value);
  },
  onSearch() {
    void this.controller?.search();
  },
  onPrevious() {
    if (this.data.campusPage > 1)
      void this.controller?.search(this.data.campusPage - 1);
  },
  onNext() {
    if (this.data.campusPage * 20 < this.data.campusTotal)
      void this.controller?.search(this.data.campusPage + 1);
  },
  onChoose(event: { currentTarget: { dataset: { id: string } } }) {
    this.controller?.selectCampus(event.currentTarget.dataset.id);
  },
  onLookup() {
    void this.controller?.lookup();
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
