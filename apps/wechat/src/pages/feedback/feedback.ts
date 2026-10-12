import {
  PinFeedController,
  PinDetailController,
  initialPinDetailView,
  initialPinFeedView,
} from '../../post-pins/controller';
import type { Post } from '../../community/contract';
import type { WhaleuApp } from '../../app';
import { FeedbackController, initialFeedbackView } from './controller';
Page({
  data: {
    ...initialFeedbackView(),
    postPin: initialPinFeedView(),
    postPinManagement: initialPinDetailView(),
  },
  controller: undefined as FeedbackController | undefined,
  pinController: undefined as PinFeedController | undefined,
  pinManager: undefined as PinDetailController | undefined,
  pinScope: '',
  pinRenderRevision: 0,
  pinRenderedId: '',
  ordinaryPosts: [] as readonly Post[],
  renderOrdinaryPins() {
    this.setData({
      posts: this.ordinaryPosts.filter((p) => p.id !== this.pinRenderedId),
    });
  },
  onSlotUnpin() {
    this.pinManager?.confirm('unpin');
  },
  onSlotSubmit() {
    void this.pinManager?.submit();
  },
  onSlotClose() {
    this.pinManager?.closeConfirmation();
  },
  onSlotRecover() {
    void this.pinManager?.recover();
  },
  onSlotRetry() {
    void this.pinManager?.recover(true);
  },
  onSlotCancel() {
    this.pinManager?.requestCancellation();
  },
  onSlotConfirmCancel() {
    void this.pinManager?.confirmCancellation();
  },
  onPinOpen() {
    const route = this.pinController?.route();
    if (!route) return;
    if (!wx.navigateTo) {
      this.setData({ error: '当前环境无法打开置顶详情' });
      return;
    }
    wx.navigateTo({
      url: route,
      success: () => undefined,
      fail: () => this.setData({ error: '无法打开置顶详情，请重试' }),
    });
  },
  onPinExpand() {
    this.pinController?.expand();
  },
  onPinDismiss() {
    this.pinController?.dismiss();
  },
  onPinConfirmDismiss() {
    this.pinController?.confirmDismiss();
  },
  onPinCloseDismiss() {
    this.pinController?.closeDismiss();
  },
  onShow() {
    this.pinRenderRevision++;
    this.pinRenderedId = '';
    this.ordinaryPosts = [];
    this.pinScope = '';
    this.pinManager?.dispose();
    this.pinManager = undefined;
    this.pinController?.dispose();
    this.pinController = undefined;

    this.controller?.dispose();
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({ error: '环境未初始化，请重新打开小程序' });
      return;
    }
    this.pinManager = new PinDetailController(
      runtime,
      (view) => this.setData({ postPinManagement: view }),
      () => {
        void this.controller?.load();
      },
    );
    if (runtime.sessions.snapshot().credentials) this.pinManager.loadRecovery();
    this.pinController = new PinFeedController(runtime, (view) => {
      const revision = ++this.pinRenderRevision;
      this.setData({ postPin: view }, () => {
        if (revision !== this.pinRenderRevision) return;
        this.pinRenderedId = view.item?.post.id ?? '';
        this.renderOrdinaryPins();
      });
    });
    this.controller = new FeedbackController(runtime, (view) => {
      this.ordinaryPosts = view.posts;
      this.setData({ ...view });
      this.renderOrdinaryPins();
      if (!view.loaded) {
        this.pinScope = '';
        this.pinController?.clear();
        this.pinManager?.clear();
      } else if (!view.busy && view.space && this.pinScope !== view.space.id) {
        this.pinScope = view.space.id;
        const reader = this.pinController,
          manager = this.pinManager;
        const spaceId = view.space.id;
        // Serialize the two mandatory owner proofs from this same page.
        void reader?.load({ spaceId, category: 'feedback' }).then(() => {
          if (
            this.pinScope === spaceId &&
            this.pinController === reader &&
            this.pinManager === manager &&
            view.hasSession
          )
            void manager?.loadSlot(spaceId);
        });
      }
    });
    void this.controller.load();
  },
  onRefresh() {
    void this.controller?.load();
  },
  onMore() {
    void this.controller?.more();
  },
  onCancel() {
    this.controller?.cancel();
  },
  onHide() {
    this.pinRenderRevision++;
    this.pinRenderedId = '';
    this.ordinaryPosts = [];
    this.pinScope = '';
    this.pinManager?.dispose();
    this.pinManager = undefined;
    this.pinController?.dispose();
    this.pinController = undefined;
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.pinRenderRevision++;
    this.pinRenderedId = '';
    this.ordinaryPosts = [];
    this.pinScope = '';
    this.pinManager?.dispose();
    this.pinManager = undefined;
    this.pinController?.dispose();
    this.pinController = undefined;
    this.controller?.dispose();
    this.controller = undefined;
  },
});
