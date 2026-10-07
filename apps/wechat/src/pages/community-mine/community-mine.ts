import { AuthorNavigator } from '../../profile/author-navigation';
import {
  tradingCategories,
  tradingLabels,
} from '../../community/trading-contract';
import type { WhaleuApp } from '../../app';
import { MineController, initialMineView } from './controller';
Page({
  data: { ...initialMineView(), tradingCategories, tradingLabels },
  controller: undefined as MineController | undefined,
  authorNavigator: undefined as AuthorNavigator | undefined,
  onShow() {
    this.authorNavigator?.dispose();
    this.authorNavigator = new AuthorNavigator(
      wx,
      () => this.setData({ error: '暂不能打开主页，请重试' }),
      getApp<WhaleuApp>().community,
    );
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
  onAuthor(event: { currentTarget: { dataset: { id: string } } }) {
    if (!this.data.loaded || this.data.busy) return;
    this.authorNavigator?.open(
      this.data.tradingPosts.find(
        (item) => item.id === event.currentTarget.dataset.id,
      )?.author,
    );
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
    this.authorNavigator?.dispose();
    this.authorNavigator = undefined;
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.authorNavigator?.dispose();
    this.authorNavigator = undefined;
    this.controller?.dispose();
    this.controller = undefined;
  },
});
