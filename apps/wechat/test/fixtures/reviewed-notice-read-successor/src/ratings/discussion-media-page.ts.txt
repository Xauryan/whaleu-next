import type { WhaleuApp } from '../app';
import { DirectoryNavigator } from '../directory/navigation';
import {
  RatingDiscussionMediaPageController,
  initialDiscussionMediaPage,
} from './discussion-media-page-controller';
type Tap = {
  currentTarget: {
    dataset: { id?: string; mode?: string; direction?: string; sort?: string };
  };
};
export function registerDiscussionMediaPage(): void {
  Page({
    data: initialDiscussionMediaPage(),
    route: {} as unknown,
    controller: undefined as RatingDiscussionMediaPageController | undefined,
    navigator: undefined as DirectoryNavigator | undefined,
    onLoad(query: unknown = {}) {
      this.route = query;
    },
    onShow() {
      this.onHide();
      const runtime = getApp<WhaleuApp>().community;
      if (!runtime) {
        this.setData({ error: '环境尚未初始化' });
        return;
      }
      this.navigator = new DirectoryNavigator(wx, () =>
        this.setData({ error: '页面暂不能打开' }),
      );
      this.controller = new RatingDiscussionMediaPageController(
        runtime,
        (view) => this.setData({ ...view }),
      );
      void this.controller.load(this.route);
    },
    onSort(event: Tap) {
      const sort = event.currentTarget.dataset.sort;
      if (sort === 'time' || sort === 'likes')
        void this.controller?.selectSort(sort);
    },
    onRefresh() {
      void this.controller?.reload();
    },
    onMore() {
      void this.controller?.more();
    },
    onCompose(event: Tap) {
      void this.controller?.compose(event.currentTarget.dataset.id);
    },
    onCloseComposer() {
      this.controller?.closeComposer();
    },
    onText(event: { detail: { value: string } }) {
      this.controller?.text(event.detail.value);
    },
    onAuthorMode(event: Tap) {
      this.controller?.author(event.currentTarget.dataset.mode ?? '');
    },
    onChoose() {
      void this.controller?.append();
    },
    onRemove(event: Tap) {
      void this.controller?.remove(event.currentTarget.dataset.id ?? '');
    },
    onMove(event: Tap) {
      void this.controller?.reorder(
        event.currentTarget.dataset.id ?? '',
        event.currentTarget.dataset.direction === '-1' ? -1 : 1,
      );
    },
    onPublish() {
      void this.controller?.publish();
    },
    onRecover() {
      void this.controller?.recover();
    },
    onRetry() {
      void this.controller?.recover(true);
    },
    onRequestCancel() {
      this.controller?.requestCancel();
    },
    onDismissCancel() {
      this.controller?.dismissCancel();
    },
    onCancelOriginal() {
      void this.controller?.cancelOriginal();
    },
    onLike(event: Tap) {
      void this.controller?.toggle(event.currentTarget.dataset.id ?? '');
    },
    onSubscription() {
      void this.controller?.toggle();
    },
    onDelete(event: Tap) {
      this.navigator?.open(
        this.controller?.deletionPath(event.currentTarget.dataset.id ?? '') ??
          null,
      );
    },
    onThread(event: Tap) {
      this.navigator?.open(
        this.controller?.threadPath(event.currentTarget.dataset.id ?? '') ??
          null,
      );
    },
    onImage(event: Tap) {
      void this.controller?.openImage(event.currentTarget.dataset.id ?? '');
    },
    onPreviousImage() {
      void this.controller?.moveImage(-1);
    },
    onNextImage() {
      void this.controller?.moveImage(1);
    },
    onCloseImage() {
      this.controller?.closeImage();
    },
    onHide() {
      this.controller?.dispose();
      this.controller = undefined;
      this.navigator?.dispose();
      this.navigator = undefined;
    },
    onUnload() {
      this.onHide();
      this.route = {};
    },
  });
}
