import type { WhaleuApp } from '../../app';
import {
  initialRatingManagementView,
  RatingManagementController,
  decodeRatingCreationContext,
  type RatingCreationContext,
} from '../../ratings/management-controller';
import { isRecord } from '../../api/errors';
Page({
  data: initialRatingManagementView(),
  context: null as RatingCreationContext | null,
  controller: undefined as RatingManagementController | undefined,
  onLoad(query: unknown = {}) {
    try {
      this.context = decodeRatingCreationContext(
        isRecord(query)
          ? { ...query, regionId: query.regionId ?? null }
          : query,
      );
    } catch {
      this.context = null;
    }
  },
  onShow() {
    this.controller?.dispose();
    this.controller = undefined;
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({
        ...initialRatingManagementView(),
        error: '环境未初始化，请重新打开小程序',
      });
      return;
    }
    this.controller = new RatingManagementController(runtime, (view) =>
      this.setData({ ...view }),
    );
    void this.controller.load(this.context);
  },
  onName(event: { detail: { value: string } }) {
    this.controller?.setName(event.detail.value);
  },
  onDescription(event: { detail: { value: string } }) {
    this.controller?.setDescription(event.detail.value);
  },
  onCreate() {
    void this.controller?.create();
  },
  onRefresh() {
    if (this.data.frozen) void this.controller?.recover();
    else this.setData({ status: '请返回目录刷新，再重新进入分类填写创建申请' });
  },
  onRecover() {
    void this.controller?.recover();
  },
  onRetry() {
    void this.controller?.recover(true);
  },
  onCancelCreation() {
    this.controller?.requestCancelCreation();
  },
  onDismissCancelCreation() {
    this.controller?.dismissCancelCreation();
  },
  onConfirmCancelCreation() {
    void this.controller?.confirmCancelCreation();
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
    this.context = null;
  },
});
