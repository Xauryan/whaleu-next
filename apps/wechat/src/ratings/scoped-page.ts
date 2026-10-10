import { RatingCoverViewport } from './target-cover-viewport';
import type { WhaleuApp } from '../app';
import { DirectoryNavigator } from '../directory/navigation';
import {
  initialRatingScopedView,
  RatingScopedController,
  type RatingScopedMode,
} from './scoped-controller';
import type { RatingScopedNoticeKind } from './scoped-read-contract';
type Tap = {
  currentTarget: {
    dataset: {
      id?: string;
      mode?: string;
      score?: number | string;
      kind?: string;
      sort?: string;
      order?: string;
    };
  };
};
/** Back, Close and app hide dispose this owner; native page state never includes a context token or journal payload. */
export function registerRatingScopedPage(): void {
  Page({
    data: { ...initialRatingScopedView(), scores: [1, 2, 3, 4, 5] },
    route: {} as unknown,
    navigationActive: false,
    controller: undefined as RatingScopedController | undefined,
    coverViewport: undefined as RatingCoverViewport | undefined,
    navigator: undefined as DirectoryNavigator | undefined,
    unsubscribeSession: undefined as (() => void) | undefined,
    unsubscribeHide: undefined as (() => void) | undefined,
    onLoad(query: unknown = {}) {
      this.route = query;
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
          this.navigator = this.navigationActive
            ? new DirectoryNavigator(wx, () =>
                this.setData({ error: '暂不能打开评分页面，请重试' }),
              )
            : undefined;
        }
      });
      this.unsubscribeHide = runtime.privateViews?.subscribe((accountId) => {
        if (accountId === undefined) {
          this.navigationActive = false;
          this.navigator?.dispose();
          this.navigator = undefined;
        }
      });
    },
    onShow() {
      this.coverViewport?.dispose();
      this.controller?.dispose();
      this.navigator?.dispose();
      const runtime = getApp<WhaleuApp>().community;
      if (!runtime) {
        this.setData({
          ...initialRatingScopedView(),
          error: '环境未初始化，请重新打开小程序',
        });
        return;
      }
      this.navigationActive = true;
      this.navigator = new DirectoryNavigator(wx, () =>
        this.setData({ error: '暂不能打开评分页面，请重试' }),
      );
      this.coverViewport = new RatingCoverViewport(
        wx,
        this,
        (id, visible) => this.controller?.coverVisible(id, visible),
        (id) => this.controller?.coverViewportUnavailable(id),
      );
      this.controller = new RatingScopedController(runtime, (view) => {
        const commit = this.coverViewport?.render(
          view.loaded && !view.frozen
            ? view.targets
                .filter(
                  (target) => 'hasCover' in target && target.hasCover === true,
                )
                .map((target) => target.id)
            : [],
        );
        this.setData({ ...view }, commit);
      });
      void this.controller.load(this.route);
    },
    async onCategoryManagement() {
      const controller = this.controller,
        navigator = this.navigator;
      if (!controller || !navigator) return;
      const path = await controller.categoryManagementPath();
      if (this.controller === controller && this.navigator === navigator)
        navigator.open(path);
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
    onRequestCancelPending() {
      this.controller?.requestCancelPending();
    },
    onDismissCancelPending() {
      this.controller?.dismissCancelPending();
    },
    onCancelPending() {
      void this.controller?.cancelPending();
    },
    onOpenCampuses() {
      void this.controller?.openCampusPicker();
    },
    onCloseCampuses() {
      this.controller?.closeCampusPicker();
    },
    onCampusQuery(event: { detail: { value: string } }) {
      this.controller?.setCampusQuery(event.detail.value);
    },
    onSearchCampuses() {
      void this.controller?.searchCampuses(1);
    },
    onNextCampuses() {
      void this.controller?.searchCampuses(this.data.campusPage + 1);
    },
    onPreviousCampuses() {
      void this.controller?.searchCampuses(this.data.campusPage - 1);
    },
    onCampus(event: Tap) {
      void this.controller?.selectCampus(
        event.currentTarget.dataset.id ?? null,
      );
    },
    onNavigate(event: Tap) {
      const mode = event.currentTarget.dataset.mode;
      if (
        mode &&
        ['catalog', 'detail', 'thread', 'random', 'create', 'edit'].includes(
          mode,
        )
      )
        this.navigator?.open(
          this.controller?.navigationPath(
            mode as RatingScopedMode,
            event.currentTarget.dataset.id,
          ) ?? null,
        );
    },
    onSection(event: Tap) {
      const mode = event.currentTarget.dataset.mode;
      if (mode === 'catalog' || mode === 'updates' || mode === 'subscriptions')
        this.navigator?.open(this.controller?.sectionPath(mode) ?? null);
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
    onMoreReplies() {
      void this.controller?.more('replies');
    },
    onScore(event: Tap) {
      const score = event.currentTarget.dataset.score;
      if (
        typeof score === 'number' ||
        (typeof score === 'string' && /^[1-5]$/.test(score))
      )
        this.controller?.chooseScore(Number(score));
    },
    onDismissScore() {
      this.controller?.dismissScore();
    },
    onConfirmScore() {
      void this.controller?.confirmScore();
    },
    onDiscussionImages(event: Tap) {
      this.navigator?.open(
        this.controller?.discussionImagesPath(event.currentTarget.dataset.id) ??
          null,
      );
    },
    onDiscussionImageNotice(event: Tap) {
      this.navigator?.open(
        this.controller?.discussionImageNoticePath(
          event.currentTarget.dataset.id ?? '',
        ) ?? null,
      );
    },
    onCompose(event: Tap) {
      this.controller?.openComposer(event.currentTarget.dataset.id);
    },
    onCloseComposer() {
      this.controller?.closeComposer();
    },
    onText(event: { detail: { value: string } }) {
      this.controller?.setText(event.detail.value);
    },
    onAuthorMode(event: Tap) {
      const mode = event.currentTarget.dataset.mode;
      if (mode === 'named' || mode === 'anonymous')
        this.controller?.setAuthorMode(mode);
    },
    onPublish() {
      void this.controller?.publish();
    },
    onLike(event: Tap) {
      void this.controller?.toggleLike(event.currentTarget.dataset.id ?? '');
    },
    onSubscription(event: Tap) {
      void this.controller?.toggleSubscription(
        event.currentTarget.dataset.id ?? '',
      );
    },
    onCleanup(event: Tap) {
      this.navigator?.open(
        this.controller?.cleanupPath(event.currentTarget.dataset.id) ?? null,
      );
    },
    onSort(event: Tap) {
      const { sort, order } = event.currentTarget.dataset;
      if (
        (sort === 'time' || sort === 'likes') &&
        (order === 'asc' || order === 'desc')
      )
        void this.controller?.selectSort(sort, order);
    },
    onCoverOpen(event: Tap) {
      void this.controller?.openCover(event.currentTarget.dataset.id);
    },
    onCoverClose() {
      this.controller?.closeCover();
    },
    onCoverThumbError(event: Tap) {
      this.controller?.coverThumbnailFailed(
        event.currentTarget.dataset.id ?? '',
      );
    },
    onCoverError() {
      this.controller?.coverFailed();
    },
    onCoverChoose() {
      void this.controller?.chooseCover();
    },
    onCoverKeep() {
      this.controller?.setCoverAction('keep');
    },
    onCoverClear() {
      this.controller?.setCoverAction('clear');
    },
    onCoverRecover() {
      void this.controller?.recoverCover();
    },
    onCoverCancel() {
      void this.controller?.recoverCover(true);
    },
    onName(event: { detail: { value: string } }) {
      this.controller?.setDefinition('name', event.detail.value);
    },
    onDescription(event: { detail: { value: string } }) {
      this.controller?.setDefinition('description', event.detail.value);
    },
    onDefinitionConfirm() {
      this.controller?.confirmDefinition();
    },
    onDefinitionDismiss() {
      this.controller?.dismissDefinition();
    },
    onDefinitionCommit() {
      void this.controller?.commitDefinition();
    },
    onMinimumAverage(event: { detail: { value: string } }) {
      this.controller?.setMinimumAverage(event.detail.value);
    },
    onDraw() {
      void this.controller?.draw();
    },
    onRandomTarget() {
      this.navigator?.open(this.controller?.randomPath() ?? null);
    },
    onNoticeKind(event: Tap) {
      const kind = event.currentTarget.dataset.kind;
      if (
        kind &&
        ['updates', 'like-updates', 'subscription-updates'].includes(kind)
      )
        void this.controller?.selectNoticeKind(kind as RatingScopedNoticeKind);
    },
    onMoreNotices() {
      void this.controller?.more('notices');
    },
    async onNotice(event: Tap) {
      const controller = this.controller,
        navigator = this.navigator;
      if (!controller || !navigator) return;
      const path = await controller.noticePath(
        event.currentTarget.dataset.id ?? '',
      );
      if (this.controller === controller && this.navigator === navigator)
        navigator.open(path);
    },
    onHide() {
      this.coverViewport?.dispose();
      this.coverViewport = undefined;
      this.navigationActive = false;
      const route = this.controller?.snapshotRoute();
      if (route) this.route = route;
      this.controller?.dispose();
      this.controller = undefined;
      this.navigator?.dispose();
      this.navigator = undefined;
    },
    onUnload() {
      this.onHide();
      this.unsubscribeSession?.();
      this.unsubscribeHide?.();
      this.unsubscribeSession = undefined;
      this.unsubscribeHide = undefined;
      this.route = {};
    },
  });
}
