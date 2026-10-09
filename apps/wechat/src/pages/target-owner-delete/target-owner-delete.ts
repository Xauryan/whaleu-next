import type { WhaleuApp } from '../../app';
import { DirectoryNavigator } from '../../directory/navigation';
import {
  initialRatingTargetOwnerDeletionView,
  RatingTargetOwnerDeletionController,
} from '../../ratings/target-owner-deletion-controller';
import {
  decodeRatingTargetOwnerDeletionLocator,
  type RatingTargetOwnerDeletionLocator,
} from '../../ratings/target-owner-deletion-contract';
Page({
  data: initialRatingTargetOwnerDeletionView(),
  locator: null as RatingTargetOwnerDeletionLocator | null,
  controller: undefined as RatingTargetOwnerDeletionController | undefined,
  navigator: undefined as DirectoryNavigator | undefined,
  returned: false,
  onLoad(query: unknown = {}) {
    try {
      this.locator = decodeRatingTargetOwnerDeletionLocator(query);
    } catch {
      this.locator = null;
    }
  },
  onShow() {
    this.controller?.dispose();
    this.navigator?.dispose();
    this.controller = undefined;
    this.navigator = undefined;
    this.returned = false;
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({
        ...initialRatingTargetOwnerDeletionView(),
        error: '环境未初始化，请重新打开小程序',
      });
      return;
    }
    this.navigator = new DirectoryNavigator(wx, () =>
      this.setData({ error: '暂不能打开目录，请点击返回目录重试' }),
    );
    this.controller = new RatingTargetOwnerDeletionController(
      runtime,
      (view) => {
        this.setData({ ...view });
        if (view.returnToCatalog && !this.returned) {
          this.returned = true;
          // Catalog/detail pages recreate their controller onShow and read current public state.
          this.navigator?.open('/pages/rating-catalog/rating-catalog');
        }
      },
    );
    void this.controller.load(this.locator);
  },
  onRefresh() {
    void this.controller?.reload();
  },
  onDelete() {
    this.controller?.requestDelete();
  },
  onDismissDelete() {
    this.controller?.dismissDelete();
  },
  onConfirmDelete() {
    void this.controller?.confirmDelete();
  },
  onRecover() {
    void this.controller?.recover();
  },
  onRetry() {
    void this.controller?.recover(true);
  },
  onCancelDeletion() {
    this.controller?.requestCancelDeletion();
  },
  onDismissCancelDeletion() {
    this.controller?.dismissCancelDeletion();
  },
  onConfirmCancelDeletion() {
    void this.controller?.confirmCancelDeletion();
  },
  onCancel() {
    this.controller?.cancel();
  },
  onReturnCatalog() {
    this.navigator?.open('/pages/rating-catalog/rating-catalog');
  },
  onHide() {
    this.controller?.dispose();
    this.controller = undefined;
    this.navigator?.dispose();
    this.navigator = undefined;
  },
  onUnload() {
    this.onHide();
    this.locator = null;
  },
});
