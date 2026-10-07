import type { WhaleuApp } from '../../app';
import {
  BlockMutationController,
  initialBlockMutationView,
} from '../../community/block-controller';
import { BlocksController, initialBlocksView } from './controller';

Page({
  data: {
    ...initialBlocksView(),
    block: initialBlockMutationView(),
  },
  controller: undefined as BlocksController | undefined,
  blockMutations: undefined as BlockMutationController | undefined,
  onShow() {
    this.controller?.dispose();
    this.blockMutations?.dispose();
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({ error: '环境未初始化，请重新打开小程序' });
      return;
    }
    this.blockMutations = new BlockMutationController(runtime, (view) =>
      this.setData({ block: view }),
    );
    this.blockMutations.load();
    this.controller = new BlocksController(runtime, (view) => {
      this.setData({ ...view });
      if (view.busy || !view.loaded) this.blockMutations?.dismissBlock();
    });
    void this.controller.load();
  },
  onReload() {
    this.blockMutations?.dismissBlock();
    void this.controller?.load();
    this.blockMutations?.load();
  },
  async onPullDownRefresh() {
    this.blockMutations?.dismissBlock();
    try {
      await this.controller?.load();
    } finally {
      wx.stopPullDownRefresh?.();
    }
  },
  onMore() {
    void this.controller?.more();
  },
  onUnblock(event: { currentTarget: { dataset: { id: string } } }) {
    const entry = this.data.items.find(
      (item) => item.relationshipId === event.currentTarget.dataset.id,
    );
    if (entry && this.data.loaded && !this.data.busy)
      void this.blockMutations?.unblock(entry);
  },
  onCancel() {
    this.controller?.cancel();
  },
  onConfirmBlock() {
    void this.blockMutations?.confirmBlock();
  },
  onDismissBlock() {
    this.blockMutations?.dismissBlock();
  },
  onBlockReceipt() {
    void this.blockMutations?.recover();
  },
  onBlockRetry() {
    void this.blockMutations?.recover(true);
  },
  onBlockCancel() {
    this.blockMutations?.cancel();
  },
  onHide() {
    this.controller?.dispose();
    this.controller = undefined;
    this.blockMutations?.dispose();
    this.blockMutations = undefined;
  },
  onUnload() {
    this.onHide();
  },
});
