import type { WhaleuApp } from '../../app';
import { isUuid } from '../../profile/contract';
import {
  IdentityOverlayController,
  initialOverlayView,
  type DisplayTarget,
} from '../../identity-privacy/overlay';
import { systemClock } from '../../platform/clock';
import {
  DiscussionMutationController,
  initialDiscussionMutationView,
} from '../../community/discussion-controller';
import { ThreadController, initialThreadView } from './controller';
Page({
  data: {
    ...initialThreadView(),
    interaction: initialDiscussionMutationView(),
    identityOverlay: initialOverlayView(),
    requestedReplyId: '',
  },
  controller: undefined as ThreadController | undefined,
  mutations: undefined as DiscussionMutationController | undefined,
  identityOverlay: undefined as IdentityOverlayController | undefined,
  postId: '',
  rootCommentId: '',
  replyId: null as string | null,
  overlayTargets: '',
  onLoad(
    query: { postId?: string; rootCommentId?: string; replyId?: string } = {},
  ) {
    const valid =
      isUuid(query.postId) &&
      isUuid(query.rootCommentId) &&
      (query.replyId === undefined || isUuid(query.replyId));
    this.postId = valid ? query.postId! : '';
    this.rootCommentId = valid ? query.rootCommentId! : '';
    this.replyId = valid ? (query.replyId ?? null) : null;
    this.setData({ requestedReplyId: this.replyId ?? '' });
  },
  onShow() {
    this.controller?.dispose();
    this.mutations?.dispose();
    this.identityOverlay?.dispose();
    this.overlayTargets = '';
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime || !this.postId || !this.rootCommentId) {
      this.setData({ error: '讨论地址无效或环境尚未初始化' });
      return;
    }
    this.identityOverlay = new IdentityOverlayController(
      runtime.sessions,
      runtime.identityPrivacy,
      systemClock,
      (view) => this.setData({ identityOverlay: view }),
      runtime.privateViews,
    );
    this.mutations = new DiscussionMutationController(
      runtime,
      (view) => {
        this.setData({ interaction: view });
        if (view.busy || view.frozen) {
          this.identityOverlay?.clear();
          this.overlayTargets = '';
        }
      },
      () => {
        void this.controller?.load();
      },
    );
    this.mutations.load();
    this.controller = new ThreadController(
      runtime,
      this.postId,
      this.rootCommentId,
      this.replyId,
      (view) => {
        this.setData({ ...view });
        const targets: DisplayTarget[] =
          view.post && view.root
            ? [
                {
                  kind: 'post',
                  id: view.post.id,
                  authorMode: view.post.author.kind,
                },
                {
                  kind: 'comment',
                  id: view.root.id,
                  authorMode: view.root.author.kind,
                },
                ...[
                  ...new Map(
                    [
                      ...view.replies,
                      ...view.contextReplies,
                      ...(view.locatedReply ? [view.locatedReply] : []),
                    ].map((item) => [item.id, item]),
                  ).values(),
                ].map((item) => ({
                  kind: 'reply' as const,
                  id: item.id,
                  authorMode: item.author.kind,
                })),
              ]
            : [];
        const key = targets
          .map((item) => item.kind + ':' + item.id + ':' + item.authorMode)
          .join(',');
        if (
          view.busy ||
          !view.loaded ||
          this.data.interaction.busy ||
          this.data.interaction.frozen
        ) {
          this.identityOverlay?.clear();
          this.overlayTargets = '';
        } else if (key !== this.overlayTargets) {
          this.overlayTargets = key;
          void this.identityOverlay?.show(targets);
        }
      },
    );
    void this.controller.load();
  },
  onReload() {
    void this.controller?.load();
  },
  onMore() {
    void this.controller?.more();
  },
  onCancel() {
    this.controller?.cancel();
  },
  onLikeRoot() {
    const root = this.data.root;
    if (root && this.data.loaded && !this.data.busy)
      void this.mutations?.apply(
        'set_comment_like',
        this.postId,
        root.id,
        root.id,
        !root.viewer.isLiked,
      );
  },
  onPinRoot() {
    const root = this.data.root;
    if (root?.viewer.canPin && this.data.loaded && !this.data.busy)
      void this.mutations?.apply(
        'set_comment_pin',
        this.postId,
        root.id,
        root.id,
        !root.isPinned,
      );
  },
  onLikeReply(event: { currentTarget: { dataset: { id: string } } }) {
    const id = event.currentTarget.dataset.id,
      reply =
        [...this.data.replies, ...this.data.contextReplies].find(
          (item) => item.id === id,
        ) ??
        (this.data.locatedReply?.id === id ? this.data.locatedReply : null);
    if (reply && this.data.loaded && !this.data.busy)
      void this.mutations?.apply(
        'set_reply_like',
        this.postId,
        this.rootCommentId,
        id,
        !reply.viewer.isLiked,
      );
  },
  onDeleteReply(event: { currentTarget: { dataset: { id: string } } }) {
    this.controller?.requestDelete(event.currentTarget.dataset.id);
  },
  onConfirmDelete() {
    void this.controller?.confirmDelete();
  },
  onDismissDelete() {
    this.controller?.dismissDelete();
  },
  onInteractionReceipt() {
    void this.mutations?.recover();
  },
  onInteractionRetry() {
    void this.mutations?.recover(true);
  },
  onInteractionCancel() {
    this.mutations?.cancel();
  },
  onHide() {
    this.controller?.dispose();
    this.controller = undefined;
    this.mutations?.dispose();
    this.mutations = undefined;
    this.identityOverlay?.dispose();
    this.identityOverlay = undefined;
  },
  onUnload() {
    this.onHide();
  },
});
