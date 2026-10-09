import type { WhaleuApp } from '../../app';
import {
  decodeRatingDeletionLocator,
  type RatingDeletionLocator,
} from '../../ratings/deletion-contract';
import {
  initialRatingDeletionView,
  RatingDeletionController,
} from '../../ratings/deletion-controller';
Page({
  data: initialRatingDeletionView(),
  locator: null as RatingDeletionLocator | null,
  controller: undefined as RatingDeletionController | undefined,
  onLoad(query: unknown = {}) {
    try {
      this.locator = decodeRatingDeletionLocator(query);
    } catch {
      this.locator = null;
    }
  },
  onShow() {
    this.controller?.dispose();
    this.controller = undefined;
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({
        ...initialRatingDeletionView(),
        error: '环境未初始化，请重新打开小程序',
      });
      return;
    }
    this.controller = new RatingDeletionController(runtime, (view) =>
      this.setData({ ...view }),
    );
    void this.controller.load(this.locator);
  },
  onOwner() {
    void this.controller?.readContext('owner');
  },
  onAdmin() {
    void this.controller?.readContext('admin');
  },
  onConfirm() {
    void this.controller?.confirmDelete();
  },
  onCancel() {
    this.controller?.cancel();
  },
  onRecover() {
    void this.controller?.recover();
  },
  onRetry() {
    void this.controller?.recover(true);
  },
  onRefresh() {
    void this.controller?.load(this.locator);
  },
  onHide() {
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.onHide();
    this.locator = null;
  },
});
