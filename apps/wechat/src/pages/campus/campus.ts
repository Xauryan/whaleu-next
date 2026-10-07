import type { WhaleuApp } from '../../app';
import { HttpProfileGateway } from '../../profile/gateway';
import { CampusController, initialCampusView } from './controller';
Page({
  data: { ...initialCampusView() },
  controller: undefined as CampusController | undefined,
  onShow() {
    this.controller?.dispose();
    const runtime = getApp<WhaleuApp>().identity;
    if (!runtime) {
      this.setData({ error: '环境未初始化，请重新打开小程序' });
      return;
    }
    this.controller = new CampusController(
      runtime.sessions,
      runtime.api ? new HttpProfileGateway(runtime.api) : undefined,
      (view) => this.setData({ ...view }),
    );
    void this.controller.load();
  },
  onQuery(event: { detail: { value: string } }) {
    this.controller?.setQuery(event.detail.value);
  },
  onDistrict(event: { detail: { value: string } }) {
    this.controller?.setDistrict(event.detail.value);
  },
  onSearch() {
    void this.controller?.search();
  },
  onReload() {
    void this.controller?.load();
  },
  onPrevious() {
    void this.controller?.previous();
  },
  onNext() {
    void this.controller?.next();
  },
  onChoose(event: { currentTarget: { dataset: { id: string } } }) {
    this.controller?.choose(event.currentTarget.dataset.id);
  },
  onSave() {
    void this.controller?.save();
  },
  onCancelSelection() {
    this.controller?.cancelSelection();
  },
  onCancelOperation() {
    this.controller?.cancelOperation();
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
