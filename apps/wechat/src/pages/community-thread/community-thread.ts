import {
  MessagingEntryNavigator,
  postEntry,
  commentEntry,
  replyEntry,
} from '../../messaging/entry';
import { PUBLIC_EXPERIENCE_COLOR_STYLES } from '../../experience/public-display';
import { AuthorNavigator } from '../../profile/author-navigation';
import {
  ReportMutationController,
  initialReportMutationView,
} from '../../community/report-controller';
import {
  BlockMutationController,
  initialBlockMutationView,
} from '../../community/block-controller';
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
    experienceColorStyles: PUBLIC_EXPERIENCE_COLOR_STYLES,
    report: initialReportMutationView(),
    block: initialBlockMutationView(),
    ...initialThreadView(),
    interaction: initialDiscussionMutationView(),
    identityOverlay: initialOverlayView(),
    requestedReplyId: '',
  },
  reportMutations: undefined as ReportMutationController | undefined,
  blockMutations: undefined as BlockMutationController | undefined,
  blockTargets: '',
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
  authorNavigator: undefined as AuthorNavigator | undefined,
  messagingEntry: undefined as MessagingEntryNavigator | undefined,
  onShow() {
    this.messagingEntry?.dispose();
    this.messagingEntry = new MessagingEntryNavigator(
      wx,
      getApp<WhaleuApp>().community,
      () => this.setData({ error: '暂不能打开私信，请重试' }),
    );
    this.authorNavigator?.dispose();
    this.authorNavigator = new AuthorNavigator(
      wx,
      () => this.setData({ error: '暂不能打开主页，请重试' }),
      getApp<WhaleuApp>().community,
    );
    this.reportMutations?.dispose();
    this.reportMutations = undefined;
    this.blockMutations?.dispose();
    this.blockMutations = undefined;
    this.blockTargets = '';
    this.controller?.dispose();
    this.mutations?.dispose();
    this.identityOverlay?.dispose();
    this.overlayTargets = '';
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime || !this.postId || !this.rootCommentId) {
      this.setData({ error: '讨论地址无效或环境尚未初始化' });
      return;
    }
    this.reportMutations = new ReportMutationController(
      runtime,
      'report',
      (view) => {
        this.setData({ report: view });
        if (view.busy || view.frozen) {
          this.identityOverlay?.clear();
          this.overlayTargets = '';
        }
      },
    );
    this.reportMutations.load();
    this.blockMutations = new BlockMutationController(runtime, (view) => {
      this.setData({ block: view });
      if (view.busy || view.frozen) {
        this.identityOverlay?.clear();
        this.overlayTargets = '';
      }
    });
    this.blockMutations.load();
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
        if (view.busy || !view.loaded || key !== this.blockTargets) {
          this.reportMutations?.dismiss();
          this.blockMutations?.dismissBlock();
        }
        this.blockTargets = key;
        if (
          view.busy ||
          !view.loaded ||
          this.data.report.busy ||
          this.data.report.frozen ||
          this.data.block.busy ||
          this.data.block.frozen ||
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
  onReportPost() {
    const post = this.data.post;
    if (post && this.data.loaded && !this.data.busy && !this.data.needsReload)
      this.reportMutations?.requestReport('post', post);
  },
  onReportRoot() {
    const root = this.data.root;
    if (root && this.data.loaded && !this.data.busy && !this.data.needsReload)
      this.reportMutations?.requestReport('comment', root);
  },
  onReportReply(event: { currentTarget: { dataset: { id: string } } }) {
    const id = event.currentTarget.dataset.id,
      reply =
        [...this.data.replies, ...this.data.contextReplies].find(
          (item) => item.id === id,
        ) ??
        (this.data.locatedReply?.id === id ? this.data.locatedReply : null);
    if (reply && this.data.loaded && !this.data.busy && !this.data.needsReload)
      this.reportMutations?.requestReport('reply', reply);
  },
  onConfirmReport() {
    void this.reportMutations?.confirm();
  },
  onDismissReport() {
    this.reportMutations?.dismiss();
  },
  onReportReceipt() {
    void this.reportMutations?.recover();
  },
  onReportRetry() {
    void this.reportMutations?.recover(true);
  },
  onReportCancel() {
    this.reportMutations?.cancel();
  },
  onBlockPost() {
    const post = this.data.post;
    if (post && this.data.loaded && !this.data.busy && !this.data.needsReload)
      this.blockMutations?.requestBlock('post', post);
  },
  onBlockRoot() {
    const root = this.data.root;
    if (root && this.data.loaded && !this.data.busy && !this.data.needsReload)
      this.blockMutations?.requestBlock('comment', root);
  },
  onBlockReply(event: { currentTarget: { dataset: { id: string } } }) {
    const id = event.currentTarget.dataset.id,
      reply =
        [...this.data.replies, ...this.data.contextReplies].find(
          (item) => item.id === id,
        ) ??
        (this.data.locatedReply?.id === id ? this.data.locatedReply : null);
    if (reply && this.data.loaded && !this.data.busy && !this.data.needsReload)
      this.blockMutations?.requestBlock('reply', reply);
  },
  onConfirmBlock() {
    void this.blockMutations?.confirmBlock();
  },
  onDismissBlock() {
    this.blockMutations?.dismissBlock();
  },
  onBlockReceipt() {
    void this.blockMutations?.recover();
  },
  onBlockRetry() {
    void this.blockMutations?.recover(true);
  },
  onBlockCancel() {
    this.blockMutations?.cancel();
  },
  onPrivateMessage(event: {
    currentTarget: { dataset: { kind: string; id: string; mode?: string } };
  }) {
    if (
      !this.data.loaded ||
      this.data.busy ||
      this.data.needsReload ||
      this.data.block.busy ||
      this.data.block.frozen
    )
      return;
    const post = this.data.post,
      root = this.data.root;
    if (!post || !root) return;
    const { kind, id, mode } = event.currentTarget.dataset;
    if (kind === 'post' && post.id === id) {
      this.messagingEntry?.open(postEntry(post, mode === 'anonymous'));
      return;
    }
    if (kind === 'comment' && root.id === id) {
      this.messagingEntry?.open(commentEntry(post.id, root));
      return;
    }
    if (kind === 'reply') {
      const reply = [
        ...this.data.replies,
        ...this.data.contextReplies,
        ...(this.data.locatedReply ? [this.data.locatedReply] : []),
      ].find((item) => item.id === id);
      if (reply) this.messagingEntry?.open(replyEntry(post.id, root.id, reply));
    }
  },
  onAuthor(event: {
    currentTarget: { dataset: { kind: string; id: string } };
  }) {
    if (!this.data.loaded || this.data.busy || this.data.needsReload) return;
    const { kind, id } = event.currentTarget.dataset;
    const reply = [
      ...this.data.replies,
      ...this.data.contextReplies,
      ...(this.data.locatedReply ? [this.data.locatedReply] : []),
    ].find((item) => item.id === id);
    const author =
      kind === 'post' && this.data.post?.id === id
        ? this.data.post.author
        : kind === 'comment' && this.data.root?.id === id
          ? this.data.root.author
          : kind === 'reply'
            ? reply?.author
            : kind === 'reply_target' && reply?.target.status === 'available'
              ? reply.target.author
              : undefined;
    this.authorNavigator?.open(author);
  },
  onReload() {
    this.reportMutations?.dismiss();
    this.blockMutations?.dismissBlock();
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
    this.messagingEntry?.dispose();
    this.messagingEntry = undefined;
    this.authorNavigator?.dispose();
    this.authorNavigator = undefined;
    this.reportMutations?.dispose();
    this.reportMutations = undefined;
    this.blockMutations?.dispose();
    this.blockMutations = undefined;
    this.blockTargets = '';
    this.controller?.dispose();
    this.controller = undefined;
    this.mutations?.dispose();
    this.mutations = undefined;
    this.identityOverlay?.dispose();
    this.identityOverlay = undefined;
  },
  onUnload() {
    this.messagingEntry?.dispose();
    this.messagingEntry = undefined;
    this.authorNavigator?.dispose();
    this.authorNavigator = undefined;
    this.onHide();
  },
});
