import { AuthorNavigator } from '../../profile/author-navigation';
import {
  ReportMutationController,
  initialReportMutationView,
  ReportProgressController,
  initialReportProgressView,
} from '../../community/report-controller';
import {
  BlockMutationController,
  initialBlockMutationView,
} from '../../community/block-controller';
import {
  SavedMutationController,
  initialSavedMutationView,
} from '../../community/saved-controller';
import {
  FormationController,
  FormationContactsController,
  initialFormationView,
  initialFormationContactsView,
} from '../../community/formation-controller';
import { tradingLabels } from '../../community/trading-contract';
import {
  TradingMutationController,
  TradingContactsController,
  initialTradingMutationView,
  initialTradingContactsView,
} from '../../community/trading-controller';
import { ClientError } from '../../api/errors';
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
    report: initialReportMutationView(),
    juryVote: initialReportMutationView('vote'),
    reportProgress: initialReportProgressView(),
    block: initialBlockMutationView(),
    ...initialDetailView(),
    tradingLabels,
    identityOverlay: initialOverlayView(),
    formationIdentityOverlay: initialOverlayView(),
    pollView: initialPollView(),
    formationView: initialFormationView(),
    formationContacts: initialFormationContactsView(),
    interaction: initialDiscussionMutationView(),
    savedMutation: initialSavedMutationView(),
    tradingMutation: initialTradingMutationView(),
    tradingContacts: initialTradingContactsView(),
  },
  reportMutations: undefined as ReportMutationController | undefined,
  juryVotes: undefined as ReportMutationController | undefined,
  reportProgressController: undefined as ReportProgressController | undefined,
  blockMutations: undefined as BlockMutationController | undefined,
  blockTargets: '',
  controller: undefined as DetailController | undefined,
  postId: '',
  savedMutations: undefined as SavedMutationController | undefined,
  formationController: undefined as FormationController | undefined,
  formationContactsController: undefined as
    FormationContactsController | undefined,
  tradingMutations: undefined as TradingMutationController | undefined,
  tradingContactsController: undefined as TradingContactsController | undefined,
  tradingContactsAwaitingFresh: true,
  tradingContactsFreshAfter: 0,
  located: null as { commentId: string } | { replyId: string } | null,
  mutations: undefined as DiscussionMutationController | undefined,
  pollController: undefined as PollController | undefined,
  identityOverlay: undefined as IdentityOverlayController | undefined,
  overlayTargets: '',
  formationOverlayTargets: '',
  formationIdentityOverlay: undefined as IdentityOverlayController | undefined,
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
  authorNavigator: undefined as AuthorNavigator | undefined,
  onShow() {
    this.authorNavigator?.dispose();
    this.authorNavigator = new AuthorNavigator(
      wx,
      () => this.setData({ error: '暂不能打开主页，请重试' }),
      getApp<WhaleuApp>().community,
    );
    this.reportMutations?.dispose();
    this.reportMutations = undefined;
    this.juryVotes?.dispose();
    this.juryVotes = undefined;
    this.reportProgressController?.dispose();
    this.reportProgressController = undefined;
    this.blockMutations?.dispose();
    this.blockMutations = undefined;
    this.blockTargets = '';
    this.controller?.dispose();
    this.savedMutations?.dispose();
    this.tradingMutations?.dispose();
    this.tradingContactsController?.dispose();
    this.tradingContactsAwaitingFresh = true;
    this.tradingContactsFreshAfter = 0;
    this.mutations?.dispose();
    this.pollController?.dispose();
    this.formationController?.dispose();
    this.formationContactsController?.dispose();
    this.identityOverlay?.dispose();
    this.formationIdentityOverlay?.dispose();
    this.overlayTargets = '';
    this.formationOverlayTargets = '';
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime || !this.postId) {
      this.setData({ error: '帖子地址无效或环境尚未初始化' });
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
    this.juryVotes = new ReportMutationController(runtime, 'vote', (view) =>
      this.setData({ juryVote: view }),
    );
    this.juryVotes.load();
    this.reportProgressController = new ReportProgressController(
      runtime,
      { kind: 'post', id: this.postId },
      (view) => {
        this.setData({ reportProgress: view });
        if (!view.loaded) this.juryVotes?.dismiss();
      },
    );
    void this.reportProgressController.load();
    this.blockMutations = new BlockMutationController(runtime, (view) => {
      this.setData({ block: view });
      if (view.busy || view.frozen) {
        this.identityOverlay?.clear();
        this.overlayTargets = '';
        this.formationIdentityOverlay?.clear();
        this.formationOverlayTargets = '';
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
    this.formationIdentityOverlay = new IdentityOverlayController(
      runtime.sessions,
      runtime.identityPrivacy,
      systemClock,
      (view) => this.setData({ formationIdentityOverlay: view }),
      runtime.privateViews,
    );
    this.pollController = new PollController(runtime, this.postId, (view) =>
      this.setData({ pollView: view }),
    );
    this.formationContactsController = new FormationContactsController(
      runtime,
      (view) => {
        this.setData({ formationContacts: view });
        if (view.busy || view.error) {
          // A fresh contact check may discover parent/permission revocation; clear all older private identity views first.
          this.formationIdentityOverlay?.clear();
          this.formationOverlayTargets = '';
          this.identityOverlay?.clear();
          this.overlayTargets = '';
        }
      },
      (text) =>
        new Promise<void>((resolve, reject) => {
          if (!wx.setClipboardData) {
            reject(new ClientError('configuration', 'Clipboard unavailable'));
            return;
          }
          wx.setClipboardData({
            data: text,
            success: resolve,
            fail: () =>
              reject(new ClientError('network', 'Clipboard copy failed')),
          });
        }),
    );
    this.formationController = new FormationController(
      runtime,
      this.postId,
      (view) => {
        this.setData({ formationView: view });
        if (
          view.busy ||
          !view.loaded ||
          view.frozen ||
          this.data.report.busy ||
          this.data.report.frozen ||
          this.data.block.busy ||
          this.data.block.frozen ||
          !view.formation ||
          !this.data.loaded
        ) {
          this.formationIdentityOverlay?.clear();
          this.formationOverlayTargets = '';
        } else {
          const targets: DisplayTarget[] = view.formation.members.map(
            (member) => ({
              kind: 'formation_member',
              id: member.id,
              authorMode: member.author.kind,
            }),
          );
          const key = targets
            .map((target) => target.id + ':' + target.authorMode)
            .join(',');
          if (key !== this.formationOverlayTargets) {
            this.formationOverlayTargets = key;
            void this.formationIdentityOverlay?.show(targets);
          }
        }
        // Roster and contact eligibility change only after a current authoritative formation read.
        if (!view.loaded || !view.formation || !this.data.post)
          this.formationContactsController?.load(null);
        else
          this.formationContactsController?.load({
            ...this.data.post,
            component: { kind: 'formation', formation: view.formation },
          });
      },
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
    this.savedMutations = new SavedMutationController(
      runtime,
      (view) => this.setData({ savedMutation: view }),
      () => {
        void this.controller?.load();
      },
    );
    void this.savedMutations.load();
    this.tradingMutations = new TradingMutationController(
      runtime,
      (view) => {
        this.setData({ tradingMutation: view });
        if (view.busy || view.frozen) {
          // The old detail may still say open while mutation/recovery is pending.
          // Even a delayed older post callback must not restore its disclosure.
          this.tradingContactsAwaitingFresh = true;
          this.tradingContactsFreshAfter = this.controller?.readGeneration ?? 0;
          this.tradingContactsController?.load(null);
        }
      },
      () => {
        void this.controller?.load();
      },
    );
    this.tradingMutations.load();
    this.tradingContactsController = new TradingContactsController(
      runtime,
      (view) => {
        this.setData({ tradingContacts: view });
        if (view.error) {
          this.tradingContactsAwaitingFresh = true;
          this.tradingContactsFreshAfter = this.controller?.readGeneration ?? 0;
        }
      },
      (text) =>
        new Promise<void>((resolve, reject) => {
          if (!wx.setClipboardData) {
            reject(new ClientError('configuration', 'Clipboard unavailable'));
            return;
          }
          wx.setClipboardData({
            data: text,
            success: resolve,
            fail: () =>
              reject(new ClientError('network', 'Clipboard copy failed')),
          });
        }),
    );
    this.controller = new DetailController(
      runtime,
      this.postId,
      (view) => {
        this.setData({ ...view });
        if (view.busy || !view.loaded || view.needsReload)
          this.tradingContactsController?.load(null);
        else if (
          !this.tradingContactsAwaitingFresh &&
          !this.data.tradingMutation.busy &&
          !this.data.tradingMutation.frozen &&
          !this.data.tradingContacts.enabled
        )
          this.tradingContactsController?.load(view.post);
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
      (post, readGeneration) => {
        void this.pollController?.load(post);
        void this.formationController?.load(post);
        this.formationContactsController?.load(null);
        void this.savedMutations?.load(post);
        if (
          post &&
          !this.data.tradingMutation.busy &&
          !this.data.tradingMutation.frozen &&
          readGeneration > this.tradingContactsFreshAfter
        ) {
          this.tradingContactsAwaitingFresh = false;
          this.tradingContactsController?.load(post);
        } else this.tradingContactsController?.load(null);
      },
      this.located,
    );
    void this.controller.load();
  },
  onFormationContact(event: {
    detail: { value: string };
    currentTarget: { dataset: { field: string } };
  }) {
    this.formationController?.setContact(
      event.currentTarget.dataset.field,
      event.detail.value,
    );
  },
  onFormationConsent(event: { detail: { value: boolean } }) {
    this.formationController?.setConsent(event.detail.value);
  },
  onFormationJoin() {
    void this.formationController?.join();
  },
  onFormationReceipt() {
    void this.formationController?.recover();
  },
  onFormationRetry() {
    void this.formationController?.recover(true);
  },
  onFormationOwn() {
    void this.formationController?.inspectOwnMembership();
  },
  onFormationCancel() {
    this.formationController?.cancel();
  },
  onFormationContacts() {
    void this.formationContactsController?.reveal();
  },
  onCopyFormationContact(event: {
    currentTarget: { dataset: { id: string; field: string } };
  }) {
    void this.formationContactsController?.copy(
      event.currentTarget.dataset.id,
      event.currentTarget.dataset.field,
    );
  },
  onDismissFormationContacts() {
    this.formationContactsController?.dismiss();
  },
  onTradingResolution() {
    const post = this.data.post;
    if (post?.trading && !this.data.busy && !this.data.needsReload)
      void this.tradingMutations?.apply(
        post,
        post.trading.resolution === 'open' ? 'resolved' : 'open',
      );
  },
  onTradingReceipt() {
    void this.tradingMutations?.recover();
  },
  onTradingRetry() {
    void this.tradingMutations?.recover(true);
  },
  onTradingCancel() {
    this.tradingMutations?.cancel();
  },
  onTradingContacts() {
    void this.tradingContactsController?.reveal();
  },
  onCopyTradingContact(event: {
    currentTarget: { dataset: { field: string } };
  }) {
    void this.tradingContactsController?.copy(
      event.currentTarget.dataset.field,
    );
  },
  onShareAppMessage() {
    return this.data.loaded && this.data.post?.trading
      ? {
          title: '校园交易信息',
          path: `/pages/community-detail/community-detail?postId=${this.postId}`,
        }
      : { title: '校园社区', path: '/pages/community-feed/community-feed' };
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
  onReportPost() {
    const post = this.data.post;
    if (post && this.data.loaded && !this.data.busy && !this.data.needsReload)
      this.reportMutations?.requestReport('post', post);
  },
  onReportComment(event: { currentTarget: { dataset: { id: string } } }) {
    const id = event.currentTarget.dataset.id,
      comment =
        this.data.comments.find((item) => item.id === id) ??
        (this.data.locatedComment?.id === id ? this.data.locatedComment : null);
    if (
      comment &&
      this.data.loaded &&
      !this.data.busy &&
      !this.data.needsReload
    )
      this.reportMutations?.requestReport('comment', comment);
  },
  onReportReply(event: { currentTarget: { dataset: { id: string } } }) {
    const reply = [
      ...this.data.comments,
      ...(this.data.locatedComment ? [this.data.locatedComment] : []),
    ]
      .flatMap((item) => item.replyPreview.items)
      .find((item) => item.id === event.currentTarget.dataset.id);
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
  onJuryChoice(event: { currentTarget: { dataset: { vote: string } } }) {
    const vote = event.currentTarget.dataset.vote;
    if (
      (vote === 'keep' || vote === 'remove') &&
      this.data.reportProgress.progress
    )
      this.juryVotes?.requestVote(this.data.reportProgress.progress, vote);
  },
  onConfirmJuryVote() {
    void this.juryVotes?.confirm();
  },
  onDismissJuryVote() {
    this.juryVotes?.dismiss();
  },
  onJuryReceipt() {
    void this.juryVotes?.recover();
  },
  onJuryRetry() {
    void this.juryVotes?.recover(true);
  },
  onJuryCancel() {
    this.juryVotes?.cancel();
  },
  onReloadReportProgress() {
    void this.reportProgressController?.load();
  },
  onCancelReportProgress() {
    this.reportProgressController?.cancel();
  },
  onBlockPost() {
    const post = this.data.post;
    if (post && this.data.loaded && !this.data.busy && !this.data.needsReload)
      this.blockMutations?.requestBlock('post', post);
  },
  onBlockComment(event: { currentTarget: { dataset: { id: string } } }) {
    const id = event.currentTarget.dataset.id,
      comment =
        this.data.comments.find((item) => item.id === id) ??
        (this.data.locatedComment?.id === id ? this.data.locatedComment : null);
    if (
      comment &&
      this.data.loaded &&
      !this.data.busy &&
      !this.data.needsReload
    )
      this.blockMutations?.requestBlock('comment', comment);
  },
  onBlockReply(event: { currentTarget: { dataset: { id: string } } }) {
    const reply = [
      ...this.data.comments,
      ...(this.data.locatedComment ? [this.data.locatedComment] : []),
    ]
      .flatMap((item) => item.replyPreview.items)
      .find((item) => item.id === event.currentTarget.dataset.id);
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
  onAuthor(event: {
    currentTarget: { dataset: { kind: string; id: string } };
  }) {
    if (!this.data.loaded || this.data.busy || this.data.needsReload) return;
    const { kind, id } = event.currentTarget.dataset;
    const comments = [
      ...this.data.comments,
      ...(this.data.locatedComment ? [this.data.locatedComment] : []),
    ];
    const author =
      kind === 'post' && this.data.post?.id === id
        ? this.data.post.author
        : kind === 'comment'
          ? comments.find((item) => item.id === id)?.author
          : kind === 'reply'
            ? comments
                .flatMap((item) => item.replyPreview.items)
                .find((item) => item.id === id)?.author
            : kind === 'member' &&
                this.data.formationView.loaded &&
                !this.data.formationView.busy
              ? this.data.formationView.formation?.members.find(
                  (item) => item.id === id,
                )?.author
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
  onSavedToggle() {
    if (this.data.post && !this.data.busy && !this.data.needsReload)
      void this.savedMutations?.setSaved(
        this.data.post,
        !this.data.post.viewer.isSaved,
      );
  },
  onSavedPreference(event: {
    currentTarget: { dataset: { channel: string } };
    detail: { value: boolean };
  }) {
    const channel = event.currentTarget.dataset.channel;
    if (
      (channel === 'saved' || channel === 'external') &&
      !this.data.busy &&
      !this.data.needsReload
    )
      void this.savedMutations?.setPreference(channel, event.detail.value);
  },
  onSavedReceipt() {
    void this.savedMutations?.recover();
  },
  onSavedRetry() {
    void this.savedMutations?.recover(true);
  },
  onSavedCancel() {
    this.savedMutations?.cancel();
  },
  onHide() {
    this.authorNavigator?.dispose();
    this.authorNavigator = undefined;
    this.reportMutations?.dispose();
    this.reportMutations = undefined;
    this.juryVotes?.dispose();
    this.juryVotes = undefined;
    this.reportProgressController?.dispose();
    this.reportProgressController = undefined;
    this.blockMutations?.dispose();
    this.blockMutations = undefined;
    this.blockTargets = '';
    this.controller?.dispose();
    this.savedMutations?.dispose();
    this.tradingMutations?.dispose();
    this.tradingContactsController?.dispose();
    this.controller = undefined;
    this.savedMutations = undefined;
    this.tradingMutations = undefined;
    this.tradingContactsController = undefined;
    this.mutations?.dispose();
    this.mutations = undefined;
    this.pollController?.dispose();
    this.formationController?.dispose();
    this.formationContactsController?.dispose();
    this.pollController = undefined;
    this.formationController = undefined;
    this.formationContactsController = undefined;
    this.identityOverlay?.dispose();
    this.formationIdentityOverlay?.dispose();
    this.identityOverlay = undefined;
    this.formationIdentityOverlay = undefined;
  },
  onUnload() {
    this.authorNavigator?.dispose();
    this.authorNavigator = undefined;
    this.reportMutations?.dispose();
    this.reportMutations = undefined;
    this.juryVotes?.dispose();
    this.juryVotes = undefined;
    this.reportProgressController?.dispose();
    this.reportProgressController = undefined;
    this.blockMutations?.dispose();
    this.blockMutations = undefined;
    this.blockTargets = '';
    this.controller?.dispose();
    this.savedMutations?.dispose();
    this.tradingMutations?.dispose();
    this.tradingContactsController?.dispose();
    this.controller = undefined;
    this.savedMutations = undefined;
    this.tradingMutations = undefined;
    this.tradingContactsController = undefined;
    this.mutations?.dispose();
    this.mutations = undefined;
    this.pollController?.dispose();
    this.formationController?.dispose();
    this.formationContactsController?.dispose();
    this.pollController = undefined;
    this.formationController = undefined;
    this.formationContactsController = undefined;
    this.identityOverlay?.dispose();
    this.formationIdentityOverlay?.dispose();
    this.identityOverlay = undefined;
    this.formationIdentityOverlay = undefined;
  },
});
