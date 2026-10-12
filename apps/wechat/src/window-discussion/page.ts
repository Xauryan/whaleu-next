import {
  initialWindowDiscussionImageView,
  initialWindowDiscussionGalleryView,
  type WindowDiscussionImageComposer,
  type WindowDiscussionImageGallery,
  type WindowDiscussionImageView,
} from './image-runtime';
import { decodeDiscussionV2Item, type DiscussionV2Notice } from './v2-contract';
import type { WhaleuApp } from '../app';
import { isRecord } from '../api/errors';
import { DirectoryNavigator } from '../directory/navigation';
import { windowId } from '../window-ratings/contract';
import {
  WindowDiscussionController,
  initialWindowDiscussionView,
  type DiscussionMode,
} from './controller';
import {
  WindowDiscussionNoticesController,
  initialWindowDiscussionNoticesView,
} from './notices-controller';
import type { DiscussionTarget } from './contract';
type Tap = {
  currentTarget: {
    dataset: { id?: string; sort?: string; index?: number; source?: string };
  };
};
export function registerWindowDiscussionPage(mode: DiscussionMode): void {
  Page({
    data: {
      ...initialWindowDiscussionView(),
      ...initialWindowDiscussionImageView(),
      ...initialWindowDiscussionGalleryView(),
      imageEnabled: false,
      imageCancelConfirm: false,
      mode,
    },
    imageView: initialWindowDiscussionImageView() as WindowDiscussionImageView,
    images: undefined as WindowDiscussionImageComposer | undefined,
    gallery: undefined as WindowDiscussionImageGallery | undefined,
    pickerSuspended: false,
    windowId: null as string | null,
    rootId: null as string | null,
    validRoute: false,
    notice: null as { noticeId: string; target: DiscussionTarget } | null,
    controller: undefined as WindowDiscussionController | undefined,
    navigator: undefined as DirectoryNavigator | undefined,
    unsubscribe: undefined as (() => void) | undefined,
    onLoad(query: unknown = {}) {
      if (!isRecord(query)) return;
      const keys = Object.keys(query),
        notice = keys.includes('noticeId');
      this.validRoute =
        mode === 'recovery'
          ? keys.length === 0
          : mode === 'roots'
            ? keys.length === 1 && windowId(query.windowId)
            : keys.length === (notice ? 4 : 2) &&
              windowId(query.windowId) &&
              windowId(query.rootId) &&
              (!notice ||
                (windowId(query.noticeId) && windowId(query.commentId)));
      if (!this.validRoute) return;
      this.windowId = windowId(query.windowId) ? query.windowId : null;
      this.rootId = windowId(query.rootId) ? query.rootId : null;
      this.notice = notice
        ? {
            noticeId: query.noticeId as string,
            target: {
              windowId: this.windowId!,
              rootId: this.rootId!,
              commentId: query.commentId as string,
            },
          }
        : null;
    },
    onShow() {
      if (this.pickerSuspended && this.controller && this.images) {
        this.pickerSuspended = false;
        this.images.resumePicker();
        return;
      }
      this.onHide();
      const runtime = getApp<WhaleuApp>().community;
      if (!runtime || !this.validRoute) {
        this.setData({
          ...initialWindowDiscussionView(),
          mode,
          error: runtime
            ? '窗口讨论入口无效，请从窗口详情或通知重新进入'
            : '环境尚未初始化，请重新打开小程序',
        });
        return;
      }
      this.navigator = new DirectoryNavigator(wx, () =>
        this.setData({ error: '暂不能打开讨论，请重试' }),
      );
      let owner = runtime.sessions.snapshot();
      const stops = [
        runtime.sessions.subscribe(() => {
          const current = runtime.sessions.snapshot();
          if (
            current.epoch !== owner.epoch ||
            current.credentials?.accountId !== owner.credentials?.accountId
          ) {
            owner = current;
            this.navigator?.dispose();
          }
        }),
        runtime.privateViews?.subscribe((account) => {
          if (account === undefined) this.navigator?.dispose();
        }),
        runtime.safetyChanges?.subscribe(() => {
          this.navigator?.dispose();
          this.images?.clear();
          this.gallery?.clear();
        }),
      ];
      this.unsubscribe = () => stops.forEach((stop) => stop?.());
      this.controller = new WindowDiscussionController(runtime, mode, (view) =>
        this.setData({ ...view }),
      );
      if (runtime.windowDiscussionImages) {
        this.setData({ imageEnabled: true });
        this.images = runtime.windowDiscussionImages.createComposer((view) => {
          this.imageView = view;
          this.setData({ ...view });
          this.controller?.setImages(
            view.imageCount,
            view.imageFrozen || view.imageBusy,
          );
        });
        this.gallery = runtime.windowDiscussionImages.createGallery((view) =>
          this.setData({ ...view }),
        );
        this.images.restore();
      }
      void this.controller.load(this.windowId, this.rootId, this.notice);
    },
    onRefresh() {
      this.images?.restore();
      this.gallery?.clear();
      this.navigator?.dispose();
      this.navigator = new DirectoryNavigator(wx, () =>
        this.setData({ error: '暂不能打开讨论，请重试' }),
      );
      void this.controller?.reload();
    },
    onNext() {
      this.gallery?.clear();
      void this.controller?.next();
    },
    onSort(e: Tap) {
      this.gallery?.clear();
      void this.controller?.setSort(e.currentTarget.dataset.sort);
    },
    onBody(e: { detail: { value: string } }) {
      this.controller?.setBody(e.detail.value);
    },
    onConfirmPublish() {
      this.controller?.confirmPublish();
    },
    onLike(e: Tap) {
      this.controller?.confirmLike(e.currentTarget.dataset.id ?? '');
    },
    onReply(e: Tap) {
      this.controller?.chooseReply(e.currentTarget.dataset.id ?? null);
    },
    onReplyRoot() {
      this.controller?.chooseReply(null);
    },
    onThread(e: Tap) {
      this.gallery?.clear();
      this.navigator?.open(
        this.controller?.threadPath(e.currentTarget.dataset.id ?? '') ?? null,
      );
    },
    async onSubmit() {
      if (this.images && this.data.confirming === 'publish') {
        const input = this.controller?.publication();
        if (!input || this.imageView.imageBusy) return;
        this.gallery?.clear();
        await this.images.publish(input.context, input.body);
        this.controller?.cancel();
        await this.controller?.reload();
      } else if (!this.imageView.imageBusy && !this.imageView.imageFrozen)
        await this.controller?.submit();
    },
    onPickImage(e: Tap) {
      const context = this.controller?.composition();
      if (!context || this.imageView.imageBusy || this.imageView.imageFrozen)
        return;
      this.gallery?.clear();
      void this.images?.pick(
        context,
        e.currentTarget.dataset.source === 'camera' ? 'camera' : 'album',
      );
    },
    onRecoverImages() {
      void this.images?.recover().then((receipt) => {
        if (receipt) void this.controller?.reload();
      });
    },
    onRequestImageCancel() {
      if (!this.imageView.imageBusy) this.setData({ imageCancelConfirm: true });
    },
    onCloseImageCancel() {
      if (!this.imageView.imageBusy)
        this.setData({ imageCancelConfirm: false });
    },
    async onConfirmImageCancel() {
      if (this.imageView.imageBusy || !this.data.imageCancelConfirm) return;
      this.setData({ imageCancelConfirm: false });
      const receipt = await this.images?.cancelOriginal();
      if (receipt) {
        this.controller?.cancel();
        await this.controller?.reload();
      }
    },
    onImage(e: Tap) {
      const item = [
        ...(this.data.root ? [this.data.root] : []),
        ...this.data.items,
      ].find((value) => value.id === e.currentTarget.dataset.id);
      if (!item || !('protocol' in item) || this.imageView.imageBusy) return;
      const current = decodeDiscussionV2Item(item);
      if (current.images.length)
        void this.gallery?.open(
          current.images,
          Number(e.currentTarget.dataset.index ?? 0),
        );
    },
    onImagePrevious() {
      void this.gallery?.move(-1);
    },
    onImageNext() {
      void this.gallery?.move(1);
    },
    onCloseGallery() {
      this.gallery?.clear();
    },
    onCloseConfirmation() {
      this.controller?.closeConfirmation();
    },
    onRecover() {
      void this.controller?.recover();
    },
    onRetry() {
      void this.controller?.recover(true);
    },
    onRequestCancellation() {
      void this.controller?.recover(false, true);
    },
    onConfirmCancellation() {
      void this.controller?.confirmCancellation();
    },
    onCancelWait() {
      this.images?.clear();
      this.images?.restore();
      this.gallery?.clear();
      this.controller?.cancel();
    },
    onOwnWindow(e: { detail: { value: string } }) {
      this.controller?.setOwnLocator('window', e.detail.value);
    },
    onOwnComment(e: { detail: { value: string } }) {
      this.controller?.setOwnLocator('comment', e.detail.value);
    },
    onLookupOwn() {
      void this.controller?.lookupOwn();
    },
    onUnlike() {
      this.controller?.confirmUnlike();
    },
    onOwnReference(e: Tap) {
      void this.controller?.chooseOwnReference(
        e.currentTarget.dataset.id ?? '',
      );
    },
    onHide() {
      this.gallery?.clear();
      if (this.images?.suspendPicker()) {
        this.pickerSuspended = true;
        return;
      }
      this.images?.dispose();
      this.images = undefined;
      this.gallery?.dispose();
      this.gallery = undefined;
      this.pickerSuspended = false;
      this.imageView = initialWindowDiscussionImageView();
      this.setData({
        ...initialWindowDiscussionImageView(),
        ...initialWindowDiscussionGalleryView(),
        imageCancelConfirm: false,
      });
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.navigator?.dispose();
      this.controller?.dispose();
      this.navigator = undefined;
      this.controller = undefined;
    },
    onUnload() {
      this.images?.clear();
      this.pickerSuspended = false;
      this.onHide();
    },
  });
}
export function registerWindowDiscussionNoticesPage(): void {
  Page({
    data: {
      ...initialWindowDiscussionNoticesView(),
      ...initialWindowDiscussionGalleryView(),
    },
    gallery: undefined as WindowDiscussionImageGallery | undefined,
    validRoute: false,
    controller: undefined as WindowDiscussionNoticesController | undefined,
    navigator: undefined as DirectoryNavigator | undefined,
    unsubscribe: undefined as (() => void) | undefined,
    onLoad(q: unknown = {}) {
      this.validRoute = isRecord(q) && Object.keys(q).length === 0;
    },
    onShow() {
      this.onHide();
      const runtime = getApp<WhaleuApp>().community;
      if (!runtime || !this.validRoute) {
        this.setData({
          ...initialWindowDiscussionNoticesView(),
          error: '通知入口或环境不可用',
        });
        return;
      }
      this.navigator = new DirectoryNavigator(wx, () =>
        this.setData({ error: '暂不能打开通知，请重试' }),
      );
      let owner = runtime.sessions.snapshot();
      const stops = [
        runtime.sessions.subscribe(() => {
          const current = runtime.sessions.snapshot();
          if (
            current.epoch !== owner.epoch ||
            current.credentials?.accountId !== owner.credentials?.accountId
          ) {
            owner = current;
            this.navigator?.dispose();
          }
        }),
        runtime.privateViews?.subscribe((a) => {
          if (a === undefined) this.navigator?.dispose();
        }),
        runtime.safetyChanges?.subscribe(() => {
          this.navigator?.dispose();
          this.gallery?.clear();
        }),
      ];
      this.unsubscribe = () => stops.forEach((stop) => stop?.());
      this.controller = new WindowDiscussionNoticesController(runtime, (view) =>
        this.setData({ ...view }),
      );
      this.gallery = runtime.windowDiscussionImages?.createGallery((view) =>
        this.setData({ ...view }),
      );
      void this.controller.reload();
    },
    onRefresh() {
      this.gallery?.clear();
      this.navigator?.dispose();
      this.navigator = new DirectoryNavigator(wx, () =>
        this.setData({ error: '暂不能打开通知，请重试' }),
      );
      void this.controller?.reload();
    },
    onNext() {
      this.gallery?.clear();
      void this.controller?.next();
    },
    onNoticeImage(e: Tap) {
      const notice = (this.data.items as readonly DiscussionV2Notice[]).find(
        (value) => value.noticeId === e.currentTarget.dataset.id,
      );
      if (
        notice?.status === 'available' &&
        notice.kind === 'reply' &&
        notice.preview.thumbnail
      )
        void this.gallery?.open([notice.preview.thumbnail]);
    },
    onCloseGallery() {
      this.gallery?.clear();
    },
    onImagePrevious() {
      void this.gallery?.move(-1);
    },
    onImageNext() {
      void this.gallery?.move(1);
    },
    onOpen(e: Tap) {
      this.gallery?.clear();
      void this.controller?.open(e.currentTarget.dataset.id ?? '', (path) =>
        this.navigator?.open(path),
      );
    },
    onRead(e: Tap) {
      this.gallery?.clear();
      void this.controller?.read(e.currentTarget.dataset.id ?? '');
    },
    onCancelWait() {
      this.controller?.cancel();
    },
    onHide() {
      this.gallery?.dispose();
      this.gallery = undefined;
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.navigator?.dispose();
      this.controller?.dispose();
      this.navigator = undefined;
      this.controller = undefined;
    },
    onUnload() {
      this.onHide();
    },
  });
}
