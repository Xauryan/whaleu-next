import type { WhaleuApp } from '../../app';
import { DirectoryNavigator } from '../../directory/navigation';
import { decodeRatingRandomRoute } from '../../ratings/random-contract';
import {
  initialRatingRandomView,
  RatingRandomController,
} from '../../ratings/random-controller';

Page({
  data: { ...initialRatingRandomView() },
  route: null as { readonly categoryId: string } | null,
  controller: undefined as RatingRandomController | undefined,
  navigator: undefined as DirectoryNavigator | undefined,
  unsubscribeSession: undefined as (() => void) | undefined,
  unsubscribeHide: undefined as (() => void) | undefined,
  unsubscribeSafety: undefined as (() => void) | undefined,
  onLoad(query: unknown = {}) {
    try {
      this.route = decodeRatingRandomRoute(query);
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
    this.unsubscribeSafety = runtime.safetyChanges?.subscribe(() =>
      this.navigator?.dispose(),
    );
  },
  onShow() {
    this.controller?.dispose();
    this.navigator?.dispose();
    this.controller = undefined;
    this.navigator = undefined;
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({
        ...initialRatingRandomView(),
        error: '环境未初始化，请重新打开小程序',
      });
      return;
    }
    this.navigator = new DirectoryNavigator(wx, () =>
      this.setData({ error: '暂不能打开评分详情，请重试' }),
    );
    this.controller = new RatingRandomController(runtime, (view) =>
      this.setData({ ...view }),
    );
    this.controller.load(this.route);
  },
  onRefresh() {
    this.onShow();
  },
  onDraw() {
    void this.controller?.draw();
  },
  onCancel() {
    this.controller?.cancel();
  },
  onGlobal() {
    this.controller?.selectGlobal();
  },
  onCampusPicker() {
    void this.controller?.openCampusPicker();
  },
  onCloseCampusPicker() {
    this.controller?.closeCampusPicker();
  },
  onCampusQuery(event: { detail: { value: string } }) {
    this.controller?.setCampusSearch('campusQuery', event.detail.value);
  },
  onCampusDistrict(event: { detail: { value: string } }) {
    this.controller?.setCampusSearch('campusDistrict', event.detail.value);
  },
  onSearchCampuses() {
    void this.controller?.searchCampuses();
  },
  onPreviousCampuses() {
    void this.controller?.previousCampuses();
  },
  onNextCampuses() {
    void this.controller?.nextCampuses();
  },
  onChooseCampus(event: { currentTarget: { dataset: { id?: string } } }) {
    this.controller?.chooseCampus(event.currentTarget.dataset.id ?? '');
  },
  onMinimumAverage(event: { detail: { value: string } }) {
    this.controller?.setMinimumAverage(event.detail.value);
  },
  onTarget() {
    this.navigator?.open(this.controller?.targetPath() ?? null);
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
    this.unsubscribeHide?.();
    this.unsubscribeSafety?.();
    this.unsubscribeSession = undefined;
    this.unsubscribeHide = undefined;
    this.unsubscribeSafety = undefined;
    this.route = null;
  },
});
