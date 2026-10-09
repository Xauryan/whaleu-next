import type { WhaleuApp } from '../app';
import { DirectoryNavigator } from '../directory/navigation';
import {
  decodeRatingRoute,
  initialRatingView,
  RatingController,
  type RatingMode,
  type RatingRoute,
} from './controller';
type Tap = {
  currentTarget: {
    dataset: {
      id?: string;
      score?: number | string;
      mode?: string;
      sort?: string;
      order?: string;
    };
  };
};
/** Route IDs survive page hide. No body, score, cursor, author input or pending payload enters page persistence. */
export function registerRatingPage(mode: RatingMode): void {
  Page({
    data: { ...initialRatingView(), scores: [1, 2, 3, 4, 5] },
    route: null as RatingRoute | null,
    controller: undefined as RatingController | undefined,
    navigator: undefined as DirectoryNavigator | undefined,
    unsubscribeSession: undefined as (() => void) | undefined,
    unsubscribeHide: undefined as (() => void) | undefined,
    onLoad(query: unknown = {}) {
      try {
        this.route = decodeRatingRoute(query, mode);
      } catch {
        this.route = null;
      }
      const runtime = getApp<WhaleuApp>().community;
      if (!runtime) return;
      let owner = runtime.sessions.snapshot();
      this.unsubscribeSession = runtime.sessions.subscribe(() => {
        const current = runtime.sessions.snapshot();
        if (
          current.epoch !== owner.epoch ||
          current.credentials?.accountId !== owner.credentials?.accountId
        ) {
          owner = current;
          this.navigator?.dispose();
        }
      });
      this.unsubscribeHide = runtime.privateViews?.subscribe((accountId) => {
        if (accountId === undefined) this.navigator?.dispose();
      });
    },
    onShow() {
      this.controller?.dispose();
      this.controller = undefined;
      this.navigator?.dispose();
      this.navigator = undefined;
      const runtime = getApp<WhaleuApp>().community;
      if (!runtime) {
        this.setData({
          ...initialRatingView(),
          error: '环境未初始化，请重新打开小程序',
        });
        return;
      }
      this.navigator = new DirectoryNavigator(wx, () =>
        this.setData({ error: '暂不能打开评分页面，请重试' }),
      );
      this.controller = new RatingController(runtime, mode, (view) =>
        this.setData({ ...view }),
      );
      void this.controller.load(this.route);
    },
    onRefresh() {
      void this.controller?.reload();
    },
    onCancel() {
      this.controller?.cancel();
    },
    onRecover() {
      void this.controller?.recover();
    },
    onRetry() {
      void this.controller?.recover(true);
    },
    onRegions() {
      void this.controller?.loadRegions();
    },
    onRegion(event: Tap) {
      const regionId = event.currentTarget.dataset.id || null;
      const valid =
        this.data.hasSession &&
        this.data.configured &&
        (regionId === null ||
          this.data.regions.some((region) => region.id === regionId));
      if (!valid) return;
      this.route = regionId ? { regionId } : {};
      void this.controller?.selectRegion(regionId);
    },
    onCategory(event: Tap) {
      this.navigator?.open(
        this.controller?.categoryPath(event.currentTarget.dataset.id ?? '') ??
          null,
      );
    },
    onTarget(event: Tap) {
      this.navigator?.open(
        this.controller?.targetPath(event.currentTarget.dataset.id ?? '') ??
          null,
      );
    },
    onSubscription(event: Tap) {
      void this.controller?.toggleSubscription(event.currentTarget.dataset.id);
    },
    onLike(event: Tap) {
      void this.controller?.toggleLike(event.currentTarget.dataset.id ?? '');
    },
    onSort(event: Tap) {
      const { sort, order } = event.currentTarget.dataset;
      if (
        (sort === 'time' || sort === 'likes') &&
        (order === 'asc' || order === 'desc')
      )
        void this.controller?.selectSort(sort, order);
    },
    onDiscussion(event: Tap) {
      this.navigator?.open(
        this.controller?.discussionPath(event.currentTarget.dataset.id ?? '') ??
          null,
      );
    },
    onMoreCategories() {
      void this.controller?.more('categories');
    },
    onMoreTargets() {
      void this.controller?.more('targets');
    },
    onMoreComments() {
      void this.controller?.more('comments');
    },
    onScore(event: Tap) {
      const value = event.currentTarget.dataset.score;
      if (
        typeof value === 'number' ||
        (typeof value === 'string' && /^[1-5]$/.test(value))
      )
        this.controller?.chooseScore(Number(value));
    },
    onDismissScore() {
      this.controller?.dismissScore();
    },
    onConfirmScore() {
      void this.controller?.confirmScore();
    },
    onCompose() {
      this.controller?.openComposer();
    },
    onCloseComposer() {
      this.controller?.closeComposer();
    },
    onText(event: { detail: { value: string } }) {
      this.controller?.setText(event.detail.value);
    },
    onAuthorMode(event: Tap) {
      const authorMode = event.currentTarget.dataset.mode;
      if (authorMode === 'named' || authorMode === 'anonymous')
        this.controller?.setAuthorMode(authorMode);
    },
    onPublish() {
      void this.controller?.publish();
    },
    onDelete(event: Tap) {
      this.controller?.confirmDelete(event.currentTarget.dataset.id ?? '');
    },
    onDismissDelete() {
      this.controller?.dismissDelete();
    },
    onConfirmDelete() {
      void this.controller?.deleteComment();
    },
    onHide() {
      this.controller?.dispose();
      this.controller = undefined;
      this.navigator?.dispose();
      this.navigator = undefined;
    },
    onUnload() {
      this.onHide();
      this.unsubscribeSession?.();
      this.unsubscribeSession = undefined;
      this.unsubscribeHide?.();
      this.unsubscribeHide = undefined;
      this.route = null;
    },
  });
}
