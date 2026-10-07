import {
  DiscussionMutationController,
  initialDiscussionMutationView,
} from '../../community/discussion-controller';
import {
  IdentityOverlayController,
  initialOverlayView,
  type DisplayTarget,
} from '../../identity-privacy/overlay';
import { systemClock } from '../../platform/clock';
import type { WhaleuApp } from '../../app';
import { isUuid } from '../../profile/contract';
import { DetailController, initialDetailView } from './controller';
import {
  PollController,
  initialPollView,
} from '../../community/poll-controller';
Page({
  data: {
    ...initialDetailView(),
    identityOverlay: initialOverlayView(),
    pollView: initialPollView(),
    interaction: initialDiscussionMutationView(),
  },
  controller: undefined as DetailController | undefined,
  postId: '',
  located: null as { commentId: string } | { replyId: string } | null,
  mutations: undefined as DiscussionMutationController | undefined,
  pollController: undefined as PollController | undefined,
  identityOverlay: undefined as IdentityOverlayController | undefined,
  overlayTargets: '',
  onLoad(
    query: { postId?: string; rootCommentId?: string; replyId?: string } = {},
  ) {
    this.postId =
      isUuid(query.postId) &&
      (query.rootCommentId === undefined || isUuid(query.rootCommentId)) &&
      (query.replyId === undefined || isUuid(query.replyId))
        ? query.postId
        : '';
    this.located = isUuid(query.replyId)
      ? { replyId: query.replyId }
      : isUuid(query.rootCommentId)
        ? { commentId: query.rootCommentId }
        : null;
  },
  onShow() {
    this.controller?.dispose();
    this.mutations?.dispose();
    this.pollController?.dispose();
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
    this.pollController = new PollController(runtime, this.postId, (view) =>
      this.setData({ pollView: view }),
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
    this.controller = new DetailController(
      runtime,
      this.postId,
      (view) => {
        this.setData({ ...view });
        const targets: DisplayTarget[] = view.post
          ? [
              {
                kind: 'post',
                id: view.post.id,
                authorMode: view.post.author.kind,
              },
              ...[
                ...new Map(
                  [
                    ...view.comments,
                    ...(view.locatedComment ? [view.locatedComment] : []),
                  ].map((item) => [item.id, item]),
                ).values(),
              ].map((item) => ({
                kind: 'comment' as const,
                id: item.id,
                authorMode: item.author.kind,
              })),
              ...[
                ...new Map(
                  [
                    ...view.comments,
                    ...(view.locatedComment ? [view.locatedComment] : []),
                  ]
                    .flatMap((item) => item.replyPreview.items)
                    .map((item) => [item.id, item]),
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
      (post) => {
        void this.pollController?.load(post);
      },
      this.located,
    );
    void this.controller.load();
  },
  onMoreReplies(event: { currentTarget: { dataset: { id: string } } }) {
    void this.controller?.moreReplies(event.currentTarget.dataset.id);
  },
  onOrder(event: {
    currentTarget: {
      dataset: { sort: 'time' | 'likes'; order: 'asc' | 'desc' };
    };
  }) {
    void this.controller?.setOrdering(event.currentTarget.dataset);
  },
  onLikeComment(event: { currentTarget: { dataset: { id: string } } }) {
    const id = event.currentTarget.dataset.id,
      item =
        this.data.comments.find((item) => item.id === id) ??
        (this.data.locatedComment?.id === id ? this.data.locatedComment : null);
    if (item && !this.data.busy)
      void this.mutations?.apply(
        'set_comment_like',
        this.postId,
        id,
        id,
        !item.viewer.isLiked,
      );
  },
  onPinComment(event: { currentTarget: { dataset: { id: string } } }) {
    const id = event.currentTarget.dataset.id,
      item =
        this.data.comments.find((item) => item.id === id) ??
        (this.data.locatedComment?.id === id ? this.data.locatedComment : null);
    if (item?.viewer.canPin && !this.data.busy)
      void this.mutations?.apply(
        'set_comment_pin',
        this.postId,
        id,
        id,
        !item.isPinned,
      );
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
  onPollOption(event: { currentTarget: { dataset: { id: string } } }) {
    void this.pollController?.select(event.currentTarget.dataset.id);
  },
  onPollSubmit() {
    void this.pollController?.submit();
  },
  onPollReceipt() {
    void this.pollController?.recover();
  },
  onPollRetry() {
    void this.pollController?.recover(true);
  },
  onPollOwnStatus() {
    void this.pollController?.inspectOwnBallot();
  },
  onPollCancel() {
    this.pollController?.cancel();
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
    this.mutations?.dispose();
    this.mutations = undefined;
    this.pollController?.dispose();
    this.pollController = undefined;
    this.identityOverlay?.dispose();
    this.identityOverlay = undefined;
  },
  onUnload() {
    this.controller?.dispose();
    this.controller = undefined;
    this.mutations?.dispose();
    this.mutations = undefined;
    this.pollController?.dispose();
    this.pollController = undefined;
    this.identityOverlay?.dispose();
    this.identityOverlay = undefined;
  },
});
