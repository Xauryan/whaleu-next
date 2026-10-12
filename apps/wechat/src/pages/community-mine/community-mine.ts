import {
  OwnerPostVisibilityController,
  initialOwnerVisibilityView,
} from '../../owner-post-visibility/controller';
import { PUBLIC_EXPERIENCE_COLOR_STYLES } from '../../experience/public-display';
import { AuthorNavigator } from '../../profile/author-navigation';
import {
  tradingCategories,
  tradingLabels,
} from '../../community/trading-contract';
import type { WhaleuApp } from '../../app';
import { MineController, initialMineView } from './controller';
Page({
  data: {
    ownerVisibility: initialOwnerVisibilityView(),
    experienceColorStyles: PUBLIC_EXPERIENCE_COLOR_STYLES,
    ...initialMineView(),
    tradingCategories,
    tradingLabels,
  },
  ownerVisibilityController: undefined as
    OwnerPostVisibilityController | undefined,
  onOwnerVisibilityHide(event: { currentTarget: { dataset: { id: string } } }) {
    void this.ownerVisibilityController?.request(
      event.currentTarget.dataset.id,
      true,
    );
  },
  onOwnerVisibilityUnhide(event: {
    currentTarget: { dataset: { id: string } };
  }) {
    void this.ownerVisibilityController?.request(
      event.currentTarget.dataset.id,
      false,
    );
  },
  onOwnerVisibilitySubmit() {
    void this.ownerVisibilityController?.submit();
  },
  onOwnerVisibilityRecover() {
    void this.ownerVisibilityController?.recover();
  },
  onOwnerVisibilityRetry() {
    void this.ownerVisibilityController?.recover(true);
  },
  onOwnerVisibilityCancel() {
    this.ownerVisibilityController?.requestCancellation();
  },
  onOwnerVisibilityConfirmCancel() {
    void this.ownerVisibilityController?.confirmCancellation();
  },
  onOwnerVisibilityClose() {
    this.ownerVisibilityController?.closeConfirmation();
  },
  controller: undefined as MineController | undefined,
  authorNavigator: undefined as AuthorNavigator | undefined,
  onShow() {
    this.ownerVisibilityController?.dispose();
    this.ownerVisibilityController = undefined;
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
    this.ownerVisibilityController = new OwnerPostVisibilityController(
      runtime,
      (view) => this.setData({ ownerVisibility: view }),
      () => {
        if (!runtime.safetyChanges) void this.controller?.load();
      },
    );
    void this.ownerVisibilityController.load();
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
    void this.ownerVisibilityController?.load();
    void this.controller?.load();
  },
  onMore() {
    void this.controller?.more();
  },
  onCancel() {
    this.controller?.cancel();
  },
  onHide() {
    this.ownerVisibilityController?.dispose();
    this.ownerVisibilityController = undefined;
    this.authorNavigator?.dispose();
    this.authorNavigator = undefined;
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.ownerVisibilityController?.dispose();
    this.ownerVisibilityController = undefined;
    this.authorNavigator?.dispose();
    this.authorNavigator = undefined;
    this.controller?.dispose();
    this.controller = undefined;
  },
});
