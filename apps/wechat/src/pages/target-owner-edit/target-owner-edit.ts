import type { WhaleuApp } from '../../app';
import { DirectoryNavigator } from '../../directory/navigation';
import {
  initialRatingTargetOwnerEditingView,
  RatingTargetOwnerEditingController,
} from '../../ratings/target-owner-editing-controller';
import {
  decodeRatingTargetOwnerEditingLocator,
  type RatingTargetOwnerEditingLocator,
} from '../../ratings/target-owner-editing-contract';
Page({
  data: initialRatingTargetOwnerEditingView(),
  locator: null as RatingTargetOwnerEditingLocator | null,
  controller: undefined as RatingTargetOwnerEditingController | undefined,
  navigator: undefined as DirectoryNavigator | undefined,
  onLoad(query: unknown = {}) {
    try {
      this.locator = decodeRatingTargetOwnerEditingLocator(query);
    } catch {
      this.locator = null;
    }
  },
  onShow() {
    this.controller?.dispose();
    this.navigator?.dispose();
    this.controller = undefined;
    this.navigator = undefined;
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({
        ...initialRatingTargetOwnerEditingView(),
        error: '环境未初始化，请重新打开小程序',
      });
      return;
    }
    this.navigator = new DirectoryNavigator(wx, () =>
      this.setData({ error: '暂不能打开目录，请重试' }),
    );
    this.controller = new RatingTargetOwnerEditingController(runtime, (view) =>
      this.setData({ ...view }),
    );
    void this.controller.load(this.locator);
  },
  onRefresh() {
    if (this.data.busy) return;
    if (this.data.frozen) void this.controller?.recover();
    else void this.controller?.load(this.locator);
  },
  onName(event: { detail: { value: string } }) {
    this.controller?.setName(event.detail.value);
  },
  onDescription(event: { detail: { value: string } }) {
    this.controller?.setDescription(event.detail.value);
  },
  onEdit() {
    this.controller?.requestEdit();
  },
  onDismissEdit() {
    this.controller?.dismissEdit();
  },
  onConfirmEdit() {
    void this.controller?.confirmEdit();
  },
  onRecover() {
    void this.controller?.recover();
  },
  onRetry() {
    void this.controller?.recover(true);
  },
  onCancelEditing() {
    this.controller?.requestCancelEditing();
  },
  onDismissCancelEditing() {
    this.controller?.dismissCancelEditing();
  },
  onConfirmCancelEditing() {
    void this.controller?.confirmCancelEditing();
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
