import {
  IdentityOverlayController,
  initialOverlayView,
  type DisplayTarget,
} from '../../identity-privacy/overlay';
import { systemClock } from '../../platform/clock';
import type { WhaleuApp } from '../../app';
import { isUuid } from '../../profile/contract';
import { DetailController, initialDetailView } from './controller';
Page({
  data: { ...initialDetailView(), identityOverlay: initialOverlayView() },
  controller: undefined as DetailController | undefined,
  postId: '',
  identityOverlay: undefined as IdentityOverlayController | undefined,
  overlayTargets: '',
  onLoad(query: { postId?: string } = {}) {
    this.postId = isUuid(query.postId) ? query.postId : '';
  },
  onShow() {
    this.controller?.dispose();
    this.identityOverlay?.dispose();
    this.overlayTargets = '';
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime || !this.postId) {
      this.setData({ error: '帖子地址无效或环境尚未初始化' });
      return;
    }
    this.identityOverlay = new IdentityOverlayController(
      runtime.sessions,
      runtime.identityPrivacy,
      systemClock,
      (view) => this.setData({ identityOverlay: view }),
      runtime.privateViews,
    );
    this.controller = new DetailController(runtime, this.postId, (view) => {
      this.setData({ ...view });
      const targets: DisplayTarget[] = view.post
        ? [
            {
              kind: 'post',
              id: view.post.id,
              authorMode: view.post.author.kind,
            },
            ...view.comments.map((item) => ({
              kind: 'comment' as const,
              id: item.id,
              authorMode: item.author.kind,
            })),
          ]
        : [];
      const key = targets
        .map((item) => item.kind + ':' + item.id + ':' + item.authorMode)
        .join(',');
      if (view.busy || !view.loaded) {
        this.identityOverlay?.clear();
        this.overlayTargets = '';
      } else if (key !== this.overlayTargets) {
        this.overlayTargets = key;
        void this.identityOverlay?.show(targets);
      }
    });
    void this.controller.load();
  },
  onReload() {
    void this.controller?.load();
  },
  onMore() {
    void this.controller?.more();
  },
  onLike() {
    if (this.data.post)
      void this.controller?.setLiked(!this.data.post.viewer.isLiked);
  },
  onDeletePost() {
    this.controller?.requestDelete('post', this.postId);
  },
  onDeleteComment(event: { currentTarget: { dataset: { id: string } } }) {
    this.controller?.requestDelete('comment', event.currentTarget.dataset.id);
  },
  onConfirmDelete() {
    void this.controller?.confirmDelete();
  },
  onDismissDelete() {
    this.controller?.dismissDelete();
  },
  onCancel() {
    this.controller?.cancel();
  },
  onHide() {
    this.controller?.dispose();
    this.controller = undefined;
    this.identityOverlay?.dispose();
    this.identityOverlay = undefined;
  },
  onUnload() {
    this.controller?.dispose();
    this.controller = undefined;
    this.identityOverlay?.dispose();
    this.identityOverlay = undefined;
  },
});
