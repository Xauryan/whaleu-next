import { withReadingSources } from '../../community/reading-gateway';
import {
  ContentReferenceController,
  initialReferenceView,
  type ReferencePress,
} from '../../content-references/controller';
import { HttpContentReferencesGateway } from '../../content-references/gateway';
import { detailReferenceRows } from '../../content-references/detail-rows';
import { nativeBrowsingHistory } from '../../browsing-history/native';
import { historyObservationSink } from '../../browsing-history/observer';
import { RatingLinkNavigator } from '../../community/rating-link-navigation';
import {
  CategoryReclassificationController,
  initialCategoryReclassificationView,
} from '../../category-reclassification/controller';
import { reclassificationLabels } from '../../category-reclassification/contract';
import {
  OwnerPostVisibilityController,
  initialOwnerVisibilityView,
} from '../../owner-post-visibility/controller';
import {
  PinDetailController,
  initialPinDetailView,
} from '../../post-pins/controller';
import {
  NamedAvatarController,
  initialNamedAvatarView,
} from '../../profile/named-avatar';
import {
  initialMediaReadView,
  type MediaReadController,
} from '../../media/read-controller';
import {
  DiscussionGalleryController,
  discussionImageGroups,
  initialDiscussionGalleryView,
} from '../../media/discussion-gallery';
import {
  MessagingEntryNavigator,
  postEntry,
  commentEntry,
  replyEntry,
} from '../../messaging/entry';
import { ViewObserver } from '../../community/view-observer';
import { PUBLIC_EXPERIENCE_COLOR_STYLES } from '../../experience/public-display';
import {
  PostLikeMutationController,
  initialPostLikeMutationView,
} from '../../community/post-like-controller';
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
  referenceController: undefined as ContentReferenceController | undefined,
  onReferencePress(event: { detail: ReferencePress }) {
    if (this.referenceInteractionBlocked()) return;
    void this.referenceController?.open(event.detail);
  },
  onReferenceThread(event: { detail: ReferencePress }) {
    if (this.referenceInteractionBlocked()) return;
    this.referenceController?.openThread(event.detail);
  },
  onSourceThread(event: {
    currentTarget: { dataset: { rowKey?: string; generation?: number } };
  }) {
    if (this.referenceInteractionBlocked()) return;
    const { rowKey, generation } = event.currentTarget.dataset;
    if (typeof rowKey !== 'string' || typeof generation !== 'number') return;
    const roots = [
      ...this.data.comments,
      ...(this.data.locatedComment ? [this.data.locatedComment] : []),
    ];
    const source =
      roots.find((root) => `comment:${root.id}` === rowKey) ??
      roots
        .flatMap((root) => root.replyPreview.items)
        .find((reply) => `reply:${reply.id}` === rowKey);
    if (
      source?.readingBody?.classification !== 'reviewedSource' ||
      source.readingUseReferences
    )
      return;
    this.referenceController?.openThread({ rowKey, generation });
  },
  referenceInteractionBlocked() {
    return (
      this.data.busy ||
      this.data.needsReload ||
      !this.data.loaded ||
      this.data.block.busy ||
      this.data.block.frozen ||
      this.data.report.busy ||
      this.data.report.frozen ||
      this.data.interaction.busy ||
      this.data.interaction.frozen ||
      this.data.categoryManagement.frozen ||
      this.data.ownerVisibility.frozen ||
      this.data.uiExpandedMenu !== '' ||
      this.data.uiShowPreferences ||
      this.data.uiShowSafety ||
      this.data.deleteTarget !== null ||
      this.data.postPin.confirming !== null ||
      this.data.categoryManagement.confirming !== null ||
      this.data.ownerVisibility.confirming !== null ||
      this.data.report.confirmation !== null ||
      this.data.juryVote.confirmation !== null ||
      this.data.block.confirmSource !== null ||
      this.data.namedAvatar.opened ||
      this.data.mediaRead.expanded ||
      this.data.mediaGallery.expanded ||
      (this.data.mediaGallery.groupId !== '' &&
        this.data.mediaGallery.groupKind !== 'post')
    );
  },
  ratingLinkNavigator: undefined as RatingLinkNavigator | undefined,
  data: {
    references: initialReferenceView(),
    uiExpandedMenu: '',
    uiShowPreferences: false,
    uiShowSafety: false,
    categoryManagement: initialCategoryReclassificationView(),
    reclassificationLabels,
    ownerVisibility: initialOwnerVisibilityView(),
    postPin: initialPinDetailView(),
    namedAvatar: initialNamedAvatarView(),
    mediaRead: initialMediaReadView(),
    mediaGallery: initialDiscussionGalleryView(),
    experienceColorStyles: PUBLIC_EXPERIENCE_COLOR_STYLES,
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
    postLikeMutation: initialPostLikeMutationView(),
    tradingMutation: initialTradingMutationView(),
    tradingContacts: initialTradingContactsView(),
  },
  onToggleMenu(event: { currentTarget: { dataset: { menu: string } } }) {
    const menu = event.currentTarget.dataset.menu;
    this.setData({
      uiExpandedMenu: this.data.uiExpandedMenu === menu ? '' : menu,
    });
  },
  onTogglePanel(event: { currentTarget: { dataset: { panel: string } } }) {
    if (event.currentTarget.dataset.panel === 'preferences') {
      this.setData({ uiShowPreferences: !this.data.uiShowPreferences });
    } else if (event.currentTarget.dataset.panel === 'safety') {
      this.setData({ uiShowSafety: !this.data.uiShowSafety });
    }
  },
  categoryController: undefined as
    CategoryReclassificationController | undefined,
  onCategoryChoose(event: {
    currentTarget: { dataset: { id: string; category: string } };
  }) {
    void this.categoryController?.request(
      event.currentTarget.dataset.id,
      event.currentTarget.dataset.category,
    );
  },
  onCategorySubmit() {
    void this.categoryController?.submit();
  },
  onCategoryRecover() {
    void this.categoryController?.recover();
  },
  onCategoryRetry() {
    void this.categoryController?.recover(true);
  },
  onCategoryCancel() {
    this.categoryController?.requestCancellation();
  },
  onCategoryConfirmCancel() {
    void this.categoryController?.confirmCancellation();
  },
  onCategoryClose() {
    this.categoryController?.closeConfirmation();
  },
  ownerVisibilityController: undefined as
    OwnerPostVisibilityController | undefined,
  onOwnerVisibilityHide(event: { currentTarget: { dataset: { id: string } } }) {
    void this.ownerVisibilityController?.request(
      event.currentTarget.dataset.id,
      true,
    );
  },
  onOwnerVisibilityUnhide(event: {
    currentTarget: { dataset: { id: string } };
  }) {
    void this.ownerVisibilityController?.request(
      event.currentTarget.dataset.id,
      false,
    );
  },
  onOwnerVisibilitySubmit() {
    void this.ownerVisibilityController?.submit();
  },
  onOwnerVisibilityRecover() {
    void this.ownerVisibilityController?.recover();
  },
  onOwnerVisibilityRetry() {
    void this.ownerVisibilityController?.recover(true);
  },
  onOwnerVisibilityCancel() {
    this.ownerVisibilityController?.requestCancellation();
  },
  onOwnerVisibilityConfirmCancel() {
    void this.ownerVisibilityController?.confirmCancellation();
  },
  onOwnerVisibilityClose() {
    this.ownerVisibilityController?.closeConfirmation();
  },
  namedAvatarController: undefined as NamedAvatarController | undefined,
  mediaReadController: undefined as MediaReadController | undefined,
  mediaGalleryController: undefined as DiscussionGalleryController | undefined,
  reportMutations: undefined as ReportMutationController | undefined,
  juryVotes: undefined as ReportMutationController | undefined,
  reportProgressController: undefined as ReportProgressController | undefined,
  blockMutations: undefined as BlockMutationController | undefined,
  blockTargets: '',
  controller: undefined as DetailController | undefined,
  postId: '',
  viewSpaceId: '',
  savedMutations: undefined as SavedMutationController | undefined,
  postLikeMutations: undefined as PostLikeMutationController | undefined,
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
    query: {
      postId?: string;
      rootCommentId?: string;
      replyId?: string;
      viewSpaceId?: string;
    } = {},
  ) {
    this.postId =
      isUuid(query.postId) &&
      (query.viewSpaceId === undefined || isUuid(query.viewSpaceId)) &&
      (query.rootCommentId === undefined || isUuid(query.rootCommentId)) &&
      (query.replyId === undefined || isUuid(query.replyId))
        ? query.postId
        : '';
    this.viewSpaceId = isUuid(query.viewSpaceId) ? query.viewSpaceId : '';
    this.located = isUuid(query.replyId)
      ? { replyId: query.replyId }
      : isUuid(query.rootCommentId)
        ? { commentId: query.rootCommentId }
        : null;
  },
  authorNavigator: undefined as AuthorNavigator | undefined,
  viewObserver: undefined as ViewObserver | undefined,
  historyObserver: undefined as ViewObserver | undefined,
  messagingEntry: undefined as MessagingEntryNavigator | undefined,
  pinController: undefined as PinDetailController | undefined,
  onPinCreate() {
    this.pinController?.confirm('pin');
  },
  onPinUnpin() {
    this.pinController?.confirm('unpin');
  },
  onPinDuration(event: { currentTarget: { dataset: { hours: string } } }) {
    this.pinController?.duration(String(event.currentTarget.dataset.hours));
  },
  onPinHours(event: { detail: { value: string } }) {
    this.pinController?.duration(event.detail.value);
  },
  onPinLevel(event: { currentTarget: { dataset: { level: string } } }) {
    this.pinController?.level(String(event.currentTarget.dataset.level));
  },
  onPinSubmit() {
    void this.pinController?.submit();
  },
  onPinClose() {
    this.pinController?.closeConfirmation();
  },
  onPinRecover() {
    void this.pinController?.recover();
  },
  onPinRetry() {
    void this.pinController?.recover(true);
  },
  onPinCancel() {
    this.pinController?.requestCancellation();
  },
  onPinConfirmCancel() {
    void this.pinController?.confirmCancellation();
  },
  onShow() {
    this.referenceController?.dispose();
    this.referenceController = undefined;
    this.ratingLinkNavigator?.dispose();
    const linkRuntime = getApp<WhaleuApp>().community;
    this.ratingLinkNavigator = linkRuntime
      ? new RatingLinkNavigator(wx, linkRuntime.sessions, () =>
          this.setData({ error: '暂不能打开评分对象，请重试' }),
        )
      : undefined;
    this.categoryController?.dispose();
    this.categoryController = undefined;
    this.ownerVisibilityController?.dispose();
    this.ownerVisibilityController = undefined;
    this.pinController?.dispose();
    this.pinController = undefined;

    this.namedAvatarController?.dispose();
    this.namedAvatarController = new NamedAvatarController(
      getApp<WhaleuApp>().profileAvatar,
      (view) => this.setData({ namedAvatar: view }),
    );
    this.mediaGalleryController?.dispose();
    this.mediaReadController?.dispose();
    this.mediaReadController = getApp<WhaleuApp>().mediaRead?.create((view) =>
      this.setData({ mediaRead: view }),
    );
    this.mediaGalleryController = new DiscussionGalleryController(
      getApp<WhaleuApp>().mediaRead,
      (view) => this.setData({ mediaGallery: view }),
      this.mediaReadController,
    );
    this.messagingEntry?.dispose();
    this.messagingEntry = new MessagingEntryNavigator(
      wx,
      getApp<WhaleuApp>().community,
      () => this.setData({ error: '暂不能打开私信，请重试' }),
    );
    this.viewObserver?.dispose();
    this.viewObserver = undefined;
    this.historyObserver?.dispose();
    this.historyObserver = undefined;
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
    this.postLikeMutations?.dispose();
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
    const existingRuntime = getApp<WhaleuApp>().community;
    const runtime = existingRuntime
      ? withReadingSources(existingRuntime, getApp<WhaleuApp>().identity?.api)
      : undefined;
    if (!runtime || !this.postId) {
      this.setData({ error: '帖子地址无效或环境尚未初始化' });
      return;
    }
    const referenceApi = getApp<WhaleuApp>().identity?.api;
    this.referenceController = new ContentReferenceController(
      runtime,
      referenceApi ? new HttpContentReferencesGateway(referenceApi) : undefined,
      wx,
      (view) => this.setData({ references: view }),
      this.viewSpaceId || undefined,
      () => !this.referenceInteractionBlocked(),
    );
    this.categoryController = new CategoryReclassificationController(
      runtime,
      (view) => {
        this.setData({ categoryManagement: view });
        if (view.frozen) {
          this.referenceController?.suspend();
          this.pinController?.clear();
          this.mediaGalleryController?.clear();
          this.namedAvatarController?.clear();
          this.identityOverlay?.clear();
          this.overlayTargets = '';
        }
      },
      () => {
        if (!runtime.safetyChanges) {
          void this.controller?.load();
          void Promise.resolve().then(() =>
            this.categoryController?.load(this.postId),
          );
        }
      },
    );
    void this.categoryController.load(this.postId);
    this.ownerVisibilityController = new OwnerPostVisibilityController(
      runtime,
      (view) => {
        this.setData({ ownerVisibility: view });
        if (view.frozen) {
          this.referenceController?.suspend();
          this.pinController?.clear();
        }
      },
      () => {
        if (!runtime.safetyChanges) {
          void this.controller?.load();
          void Promise.resolve().then(() =>
            this.ownerVisibilityController?.load(this.postId),
          );
        }
      },
    );
    void this.ownerVisibilityController.load(this.postId);
    this.historyObserver = new ViewObserver(
      wx,
      this,
      systemClock,
      historyObservationSink(
        runtime.sessions,
        nativeBrowsingHistory(runtime.sessions),
      ),
      'detail_visit',
    );
    if (runtime.views)
      this.viewObserver = new ViewObserver(
        wx,
        this,
        systemClock,
        runtime.views,
        'detail_visit',
      );
    this.reportMutations = new ReportMutationController(
      runtime,
      'report',
      (view) => {
        this.setData({ report: view });
        if (view.busy || view.frozen) {
          this.referenceController?.suspend();
          this.mediaGalleryController?.clear();
          this.namedAvatarController?.clear();
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
        this.referenceController?.suspend();
        this.mediaGalleryController?.clear();
        this.namedAvatarController?.clear();
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
          this.mediaGalleryController?.clear();
          this.namedAvatarController?.clear();
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
          this.referenceController?.suspend();
          this.mediaGalleryController?.clear();
          this.namedAvatarController?.clear();
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
    this.postLikeMutations = new PostLikeMutationController(
      runtime,
      (view) => this.setData({ postLikeMutation: view }),
      () => {
        void this.controller?.load();
      },
    );
    this.postLikeMutations.load();
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
    this.pinController = new PinDetailController(runtime, (view) =>
      this.setData({ postPin: view }),
    );
    this.pinController.loadRecovery();
    this.controller = new DetailController(
      runtime,
      this.postId,
      (view) => {
        this.referenceController?.reconcile(
          detailReferenceRows(view),
          this.controller?.readGeneration ?? 0,
        );
        this.mediaGalleryController?.reconcile(
          view.busy || !view.loaded || view.needsReload || !view.post
            ? null
            : discussionImageGroups(view.post, [
                ...view.comments,
                ...(view.locatedComment ? [view.locatedComment] : []),
              ]),
        );
        const presented = this.viewObserver?.render(
          view.loaded && view.post && !view.needsReload ? [view.post.id] : [],
          this.postId,
        );
        if (view.busy || view.needsReload || !view.post)
          this.namedAvatarController?.clear();
        const historyPresented = this.historyObserver?.render(
          view.loaded && view.post && !view.needsReload ? [view.post.id] : [],
          this.postId,
        );
        this.setData({ ...view }, () => {
          presented?.();
          historyPresented?.();
        });
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
          this.data.interaction.frozen ||
          this.data.categoryManagement.frozen
        ) {
          this.mediaGalleryController?.clear();
          this.namedAvatarController?.clear();
          this.identityOverlay?.clear();
          this.overlayTargets = '';
        } else if (key !== this.overlayTargets) {
          this.overlayTargets = key;
          void this.identityOverlay?.show(targets);
        }
      },
      (post, readGeneration) => {
        if (post) {
          const pins = this.pinController;
          // Read acknowledgement follows a committed current native detail
          // render, rather than a successful network fetch alone.
          this.setData({}, () => {
            if (
              this.pinController === pins &&
              this.controller?.readGeneration === readGeneration &&
              this.data.loaded &&
              !this.data.ownerVisibility.frozen &&
              !this.data.categoryManagement.frozen &&
              this.data.post?.id === post.id
            )
              void pins?.load(post.id, true, this.viewSpaceId || post.space.id);
          });
        } else this.pinController?.clear();

        if (post && !this.data.categoryManagement.frozen)
          void this.mediaGalleryController?.select({
            kind: 'post',
            id: post.id,
            images: post.images,
          });
        else this.mediaGalleryController?.clear();
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
      this.viewSpaceId || undefined,
    );
    void this.controller.load();
  },
  onSelectGallery(event: {
    currentTarget: { dataset: { kind: string; id: string } };
  }) {
    if (
      !this.data.post ||
      !this.data.loaded ||
      this.data.busy ||
      this.data.needsReload ||
      this.data.block.busy ||
      this.data.block.frozen ||
      this.data.report.busy ||
      this.data.report.frozen ||
      this.data.interaction.busy ||
      this.data.interaction.frozen ||
      this.data.categoryManagement.frozen
    )
      return;
    this.namedAvatarController?.clear();
    const { kind, id } = event.currentTarget.dataset;
    const group = discussionImageGroups(this.data.post, [
      ...this.data.comments,
      ...(this.data.locatedComment ? [this.data.locatedComment] : []),
    ]).find((item) => item.kind === kind && item.id === id);
    if (group) void this.mediaGalleryController?.select(group);
  },
  onGalleryDismiss() {
    this.mediaGalleryController?.clear();
  },
  onGalleryTouchMove() {
    // Keep overlay gestures from scrolling the content behind the selected group.
  },
  onPageScroll() {
    this.namedAvatarController?.clear();
    if (this.data.mediaGallery.groupKind !== 'post')
      this.mediaGalleryController?.clear();
  },
  onGalleryOpen(event: { currentTarget: { dataset: { index: number } } }) {
    void this.mediaGalleryController?.open(
      Number(event.currentTarget.dataset.index),
    );
  },
  onGalleryWindow(event: { currentTarget: { dataset: { start: number } } }) {
    void this.mediaGalleryController?.window(
      Number(event.currentTarget.dataset.start),
    );
  },
  onGalleryRetry(event: { currentTarget: { dataset: { index: number } } }) {
    void this.mediaGalleryController?.retry(
      Number(event.currentTarget.dataset.index),
    );
  },
  onGalleryClose() {
    void this.mediaGalleryController?.close();
  },
  onGalleryError(event: {
    currentTarget: { dataset: { index: number; src: string; viewId: string } };
  }) {
    this.mediaGalleryController?.imageFailed(
      Number(event.currentTarget.dataset.index),
      event.currentTarget.dataset.src,
      event.currentTarget.dataset.viewId,
    );
  },
  onOpenMedia() {
    void this.mediaReadController?.open();
  },
  onCloseMedia() {
    void this.mediaReadController?.close();
  },
  onMediaError(event: { currentTarget: { dataset: { src?: string } } }) {
    if (event.currentTarget.dataset.src)
      this.mediaReadController?.imageFailed(event.currentTarget.dataset.src);
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
    const post = this.data.post;
    if (!post) return;
    const { kind, id, mode } = event.currentTarget.dataset;
    if (kind === 'post' && post.id === id) {
      this.messagingEntry?.open(postEntry(post, mode === 'anonymous'));
      return;
    }
    const comments = [
      ...this.data.comments,
      ...(this.data.locatedComment ? [this.data.locatedComment] : []),
    ];
    if (kind === 'comment') {
      const comment = comments.find((item) => item.id === id);
      if (comment) this.messagingEntry?.open(commentEntry(post.id, comment));
      return;
    }
    if (kind === 'reply') {
      for (const comment of comments) {
        const reply = comment.replyPreview.items.find((item) => item.id === id);
        if (reply) {
          this.messagingEntry?.open(replyEntry(post.id, comment.id, reply));
          return;
        }
      }
    }
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
  onAuthorAvatar(event: {
    currentTarget: { dataset: { kind: string; id: string } };
  }) {
    if (!this.data.loaded || this.data.busy || this.data.needsReload) return;
    if (
      this.data.block.busy ||
      this.data.block.frozen ||
      this.data.report.busy ||
      this.data.report.frozen ||
      this.data.categoryManagement.frozen
    )
      return;
    // Avatar admission is non-preemptive: retain Community sources and budget.
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
    void this.namedAvatarController?.open(author);
  },
  onAvatarModerationNavigate() {
    this.namedAvatarController?.clear();
  },
  onNamedAvatarClose() {
    this.namedAvatarController?.clear();
  },
  onNamedAvatarError() {
    this.namedAvatarController?.imageFailed();
  },
  onReload() {
    void this.categoryController?.load(this.postId);
    void this.ownerVisibilityController?.load(this.postId);
    this.namedAvatarController?.clear();
    this.reportMutations?.dismiss();
    this.blockMutations?.dismissBlock();
    void this.controller?.load();
  },
  onMore() {
    void this.controller?.more();
  },
  onPrevious() {
    void this.controller?.previous();
  },
  onLike() {
    if (
      this.data.post &&
      this.data.loaded &&
      !this.data.busy &&
      !this.data.needsReload
    )
      void this.postLikeMutations?.setLiked(
        this.data.post,
        !this.data.post.viewer.isLiked,
      );
  },
  onPostLikeReceipt() {
    void this.postLikeMutations?.recover();
  },
  onPostLikeRetry() {
    void this.postLikeMutations?.recover(true);
  },
  onPostLikeCancel() {
    this.postLikeMutations?.cancel();
  },
  onAdminPostRemoval() {
    const post = this.data.post;
    if (
      !post ||
      this.data.busy ||
      this.data.needsReload ||
      this.data.block.busy ||
      this.data.block.frozen ||
      this.data.report.busy ||
      this.data.report.frozen
    )
      return;
    if (post.viewer.isSelf) {
      this.controller?.requestDelete('post', this.postId);
      return;
    }
    this.namedAvatarController?.clear();
    this.mediaGalleryController?.clear();
    this.mediaReadController?.clear();
    if (!wx.navigateTo) {
      this.setData({ error: '当前环境不能打开帖子管理，请重试' });
      return;
    }
    wx.navigateTo({
      success: () => undefined,
      url: `/pages/admin-post-removal/admin-post-removal?kind=post&id=${encodeURIComponent(post.id)}${this.viewSpaceId && this.viewSpaceId !== this.data.post?.space.id ? `&viewSpaceId=${encodeURIComponent(this.viewSpaceId)}` : ''}`,
      fail: () => this.setData({ error: '暂不能打开帖子管理，请重试' }),
    });
  },
  onDeletePost() {
    this.controller?.requestDelete('post', this.postId);
  },
  onAdminDiscussionRemoval(event: {
    currentTarget: { dataset: { kind: string; id: string } };
  }) {
    if (
      !this.data.loaded ||
      !this.data.post ||
      this.data.busy ||
      this.data.needsReload ||
      this.data.block.busy ||
      this.data.block.frozen ||
      this.data.report.busy ||
      this.data.report.frozen ||
      this.data.interaction.busy ||
      this.data.interaction.frozen
    )
      return;
    const { kind, id } = event.currentTarget.dataset;
    if (kind !== 'comment' && kind !== 'reply') return;
    const roots = [
      ...this.data.comments,
      ...(this.data.locatedComment ? [this.data.locatedComment] : []),
    ];
    const selected =
      kind === 'comment'
        ? roots.find((item) => item.id === id)
        : (roots
            .flatMap((item) => item.replyPreview.items)
            .find((item) => item.id === id) ??
          (this.data.locatedReply?.id === id ? this.data.locatedReply : null));
    if (!selected) return;
    if (selected.viewer.isSelf) {
      if (kind === 'comment') {
        this.controller?.requestDelete('comment', selected.id);
        return;
      }
      const rootId = 'rootCommentId' in selected ? selected.rootCommentId : '';
      if (!rootId) return;
      this.namedAvatarController?.clear();
      this.mediaGalleryController?.clear();
      this.mediaReadController?.clear();
      this.identityOverlay?.clear();
      wx.navigateTo?.({
        url: `/pages/community-thread/community-thread?postId=${encodeURIComponent(this.postId)}&rootCommentId=${encodeURIComponent(rootId)}&replyId=${encodeURIComponent(selected.id)}${this.viewSpaceId ? `&viewSpaceId=${encodeURIComponent(this.viewSpaceId)}` : ''}`,
        success: () => undefined,
        fail: () => this.setData({ error: '暂不能返回自己的回复，请重试' }),
      });
      return;
    }
    this.namedAvatarController?.clear();
    this.mediaGalleryController?.clear();
    this.mediaReadController?.clear();
    this.identityOverlay?.clear();
    this.overlayTargets = '';
    if (!wx.navigateTo) {
      this.setData({ error: '当前环境不能打开回复管理，请重试' });
      return;
    }
    wx.navigateTo({
      success: () => undefined,
      url: `/pages/admin-discussion-removal/admin-discussion-removal?kind=${kind}&id=${encodeURIComponent(selected.id)}${this.viewSpaceId && this.viewSpaceId !== this.data.post?.space.id ? `&viewSpaceId=${encodeURIComponent(this.viewSpaceId)}` : ''}`,
      fail: () => this.setData({ error: '暂不能打开回复管理，请重试' }),
    });
  },
  onDeleteComment(event: { currentTarget: { dataset: { id: string } } }) {
    this.controller?.requestDelete('comment', event.currentTarget.dataset.id);
  },
  onConfirmDelete() {
    this.mediaGalleryController?.clear();
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
  onRatingTargetLink(_event: { currentTarget: { dataset: { id?: string } } }) {
    if (this.data.busy) return;
    this.ratingLinkNavigator?.open(this.data.post);
  },
  onHide() {
    this.referenceController?.dispose();
    this.referenceController = undefined;
    this.setData({
      uiExpandedMenu: '',
      uiShowPreferences: false,
      uiShowSafety: false,
    });
    this.ratingLinkNavigator?.dispose();
    this.ratingLinkNavigator = undefined;
    this.categoryController?.dispose();
    this.categoryController = undefined;
    this.ownerVisibilityController?.dispose();
    this.ownerVisibilityController = undefined;
    this.pinController?.dispose();
    this.pinController = undefined;
    this.namedAvatarController?.dispose();
    this.namedAvatarController = undefined;
    this.mediaGalleryController?.dispose();
    this.mediaGalleryController = undefined;
    this.mediaReadController?.dispose();
    this.mediaReadController = undefined;
    this.messagingEntry?.dispose();
    this.messagingEntry = undefined;
    this.viewObserver?.dispose();
    this.viewObserver = undefined;
    this.historyObserver?.dispose();
    this.historyObserver = undefined;
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
    this.postLikeMutations?.dispose();
    this.tradingMutations?.dispose();
    this.tradingContactsController?.dispose();
    this.controller = undefined;
    this.savedMutations = undefined;
    this.postLikeMutations = undefined;
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
    this.referenceController?.dispose();
    this.referenceController = undefined;
    this.ratingLinkNavigator?.dispose();
    this.ratingLinkNavigator = undefined;
    this.categoryController?.dispose();
    this.categoryController = undefined;
    this.ownerVisibilityController?.dispose();
    this.ownerVisibilityController = undefined;
    this.pinController?.dispose();
    this.pinController = undefined;
    this.namedAvatarController?.dispose();
    this.namedAvatarController = undefined;
    this.mediaGalleryController?.dispose();
    this.mediaGalleryController = undefined;
    this.mediaReadController?.dispose();
    this.mediaReadController = undefined;
    this.messagingEntry?.dispose();
    this.messagingEntry = undefined;
    this.viewObserver?.dispose();
    this.viewObserver = undefined;
    this.historyObserver?.dispose();
    this.historyObserver = undefined;
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
    this.postLikeMutations?.dispose();
    this.tradingMutations?.dispose();
    this.tradingContactsController?.dispose();
    this.controller = undefined;
    this.savedMutations = undefined;
    this.postLikeMutations = undefined;
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
