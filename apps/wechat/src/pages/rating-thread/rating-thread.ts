import { DirectoryNavigator } from '../../directory/navigation';
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
  navigator: undefined as DirectoryNavigator | undefined,
  unsubscribeSession: undefined as (() => void) | undefined,
  unsubscribeHide: undefined as (() => void) | undefined,
  controller: undefined as RatingThreadController | undefined,
  onLoad(query: unknown = {}) {
    const runtime = getApp<WhaleuApp>().community;
    if (runtime) {
      let owner = runtime.sessions.snapshot();
      this.unsubscribeSession = runtime.sessions.subscribe(() => {
        const current = runtime.sessions.snapshot();
        if (
          current.epoch !== owner.epoch ||
          current.credentials?.accountId !== owner.credentials?.accountId
        ) {
          owner = current;
          this.navigator?.dispose();
        }
      });
      this.unsubscribeHide = runtime.privateViews?.subscribe((accountId) => {
        if (accountId === undefined) this.navigator?.dispose();
      });
    }
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
    this.navigator?.dispose();
    this.navigator = undefined;
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
    this.navigator = new DirectoryNavigator(wx, () =>
      this.setData({ error: '暂不能打开删除选项，请重试' }),
    );
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
  onDeletionOptions(event: Tap) {
    this.navigator?.open(
      this.controller?.deletionPath(event.currentTarget.dataset.id) ?? null,
    );
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
    this.navigator?.dispose();
    this.navigator = undefined;
    const previous = this.controller;
    this.controller = undefined;
    previous?.dispose();
  },
  onUnload() {
    this.onHide();
    this.route = null;
    this.unsubscribeSession?.();
    this.unsubscribeHide?.();
  },
});
