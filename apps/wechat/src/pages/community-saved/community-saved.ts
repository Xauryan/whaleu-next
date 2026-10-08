import { PUBLIC_EXPERIENCE_COLOR_STYLES } from '../../experience/public-display';
import { AuthorNavigator } from '../../profile/author-navigation';
import {
  IdentityOverlayController,
  initialOverlayView,
} from '../../identity-privacy/overlay';
import { systemClock } from '../../platform/clock';
import type { WhaleuApp } from '../../app';
import {
  SavedMutationController,
  initialSavedMutationView,
} from '../../community/saved-controller';
import { tradingLabels } from '../../community/trading-contract';
import { SavedController, initialSavedView } from './controller';
Page({
  data: {
    experienceColorStyles: PUBLIC_EXPERIENCE_COLOR_STYLES,
    ...initialSavedView(),
    identityOverlay: initialOverlayView(),
    savedMutation: initialSavedMutationView(),
    tradingLabels,
  },
  identityOverlay: undefined as IdentityOverlayController | undefined,
  overlayTargets: '',
  controller: undefined as SavedController | undefined,
  savedMutations: undefined as SavedMutationController | undefined,
  authorNavigator: undefined as AuthorNavigator | undefined,
  onShow() {
    this.authorNavigator?.dispose();
    this.authorNavigator = new AuthorNavigator(
      wx,
      () => this.setData({ error: '暂不能打开主页，请重试' }),
      getApp<WhaleuApp>().community,
    );
    this.controller?.dispose();
    this.savedMutations?.dispose();
    this.identityOverlay?.dispose();
    this.overlayTargets = '';
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({ error: '环境未初始化，请重新打开小程序' });
      return;
    }
    this.identityOverlay = new IdentityOverlayController(
      runtime.sessions,
      runtime.identityPrivacy,
      systemClock,
      (view) => this.setData({ identityOverlay: view }),
      runtime.privateViews,
    );
    this.controller = new SavedController(runtime, (view) => {
      this.setData({ ...view });
      const targets = view.items.map((item) => ({
        kind: 'post' as const,
        id: item.post.id,
        authorMode: item.post.author.kind,
      }));
      const key = targets
        .map((item) => item.id + ':' + item.authorMode)
        .join(',');
      if (view.busy || !view.loaded) {
        this.identityOverlay?.clear();
        this.overlayTargets = '';
      } else if (key !== this.overlayTargets) {
        this.overlayTargets = key;
        void this.identityOverlay?.show(targets);
      }
    });
    this.savedMutations = new SavedMutationController(
      runtime,
      (view) => this.setData({ savedMutation: view }),
      () => {
        void this.controller?.load();
      },
    );
    void this.savedMutations.load();
    void this.controller.load();
  },
  onAuthor(event: { currentTarget: { dataset: { id: string } } }) {
    if (!this.data.loaded || this.data.busy) return;
    this.authorNavigator?.open(
      this.data.items.find(
        (item) => item.post.id === event.currentTarget.dataset.id,
      )?.post.author,
    );
  },
  onReload() {
    void this.controller?.load();
    void this.savedMutations?.load();
  },
  onMore() {
    void this.controller?.more();
  },
  onCancel() {
    this.controller?.cancel();
  },
  onUnsave(event: { currentTarget: { dataset: { id: string } } }) {
    const post = this.data.items.find(
      (item) => item.post.id === event.currentTarget.dataset.id,
    )?.post;
    if (post && !this.data.busy)
      void this.savedMutations?.setSaved(post, false);
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
    this.controller?.dispose();
    this.controller = undefined;
    this.savedMutations?.dispose();
    this.savedMutations = undefined;
    this.identityOverlay?.dispose();
    this.identityOverlay = undefined;
    this.overlayTargets = '';
  },
  onUnload() {
    this.authorNavigator?.dispose();
    this.authorNavigator = undefined;
    this.controller?.dispose();
    this.controller = undefined;
    this.savedMutations?.dispose();
    this.savedMutations = undefined;
    this.identityOverlay?.dispose();
    this.identityOverlay = undefined;
    this.overlayTargets = '';
  },
});
