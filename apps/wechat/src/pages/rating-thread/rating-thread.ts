import type { WhaleuApp } from '../../app';
import {
  decodeRatingThreadRoute,
  initialRatingThreadView,
  RatingThreadController,
  type RatingThreadRoute,
} from '../../ratings/discussion-controller';
type Tap = { currentTarget: { dataset: { id?: string; mode?: string } } };
Page({
  data: initialRatingThreadView(),
  route: null as RatingThreadRoute | null,
  controller: undefined as RatingThreadController | undefined,
  onLoad(query: unknown = {}) {
    const previous = this.controller;
    this.controller = undefined;
    previous?.dispose();
    try {
      this.route = decodeRatingThreadRoute(query);
    } catch {
      this.route = null;
    }
  },
  onShow() {
    const previous = this.controller;
    this.controller = undefined;
    previous?.dispose();
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({
        ...initialRatingThreadView(),
        error: '环境未初始化，请重新打开小程序',
      });
      return;
    }
    this.controller = new RatingThreadController(runtime, (view) => {
      this.setData({ ...view });
      this.route = this.controller?.currentRoute() ?? this.route;
    });
    void this.controller.load(this.route);
  },
  onRefresh() {
    void this.controller?.reload();
  },
  onMore() {
    void this.controller?.more();
  },
  onFirst() {
    void this.controller?.first();
  },
  onCollapse() {
    this.controller?.collapse();
  },
  onExpand() {
    void this.controller?.expand();
  },
  onLike(event: Tap) {
    void this.controller?.toggleLike(event.currentTarget.dataset.id ?? '');
  },
  onRootReply() {
    this.controller?.compose();
  },
  onReply(event: Tap) {
    if (event.currentTarget.dataset.id)
      this.controller?.compose(event.currentTarget.dataset.id);
  },
  onText(event: { detail: { value: string } }) {
    this.controller?.setText(event.detail.value);
  },
  onAuthorMode(event: Tap) {
    const mode = event.currentTarget.dataset.mode;
    if (mode === 'named' || mode === 'anonymous')
      this.controller?.setAuthorMode(mode);
  },
  onPublish() {
    void this.controller?.publish();
  },
  onDismiss() {
    this.controller?.dismiss();
  },
  onDelete(event: Tap) {
    this.controller?.confirmDelete(event.currentTarget.dataset.id ?? '');
  },
  onConfirmDelete() {
    void this.controller?.deleteReply();
  },
  onRecover() {
    void this.controller?.recover();
  },
  onRetry() {
    void this.controller?.recover(true);
  },
  onCancel() {
    this.controller?.cancel();
  },
  onHide() {
    const previous = this.controller;
    this.controller = undefined;
    previous?.dispose();
  },
  onUnload() {
    this.onHide();
    this.route = null;
  },
});
