import {
  tradingCategories,
  tradingLabels,
} from '../../community/trading-contract';
import type { WhaleuApp } from '../../app';
import { MineController, initialMineView } from './controller';
Page({
  data: { ...initialMineView(), tradingCategories, tradingLabels },
  controller: undefined as MineController | undefined,
  onShow() {
    this.controller?.dispose();
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({ error: '环境未初始化，请重新打开小程序' });
      return;
    }
    this.controller = new MineController(runtime, (view) =>
      this.setData({ ...view }),
    );
    void this.controller.load();
  },
  onAllPublications() {
    void this.controller?.setTradingOnly(false);
  },
  onOwnTrading() {
    void this.controller?.setTradingOnly(true);
  },
  onTradingSubtype(event: { currentTarget: { dataset: { key: string } } }) {
    void this.controller?.setTradingSubtype(event.currentTarget.dataset.key);
  },
  onReload() {
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
