import type { WhaleuApp } from '../../app';
import {
  ActivityController,
  initialActivityView,
} from '../../activities/controller';
import {
  ActivityVisitController,
  initialActivityVisitView,
} from '../../activities/visit-controller';
import {
  ActivityPreferenceController,
  initialActivityPreferenceView,
} from '../../activities/preference';
import { DirectoryNavigator } from '../../directory/navigation';
Page({
  data: {
    ...initialActivityView(),
    visit: initialActivityVisitView(),
    preference: initialActivityPreferenceView(),
  },
  controller: undefined as ActivityController | undefined,
  visits: undefined as ActivityVisitController | undefined,
  preferences: undefined as ActivityPreferenceController | undefined,
  navigator: undefined as DirectoryNavigator | undefined,
  unsubscribeHide: undefined as (() => void) | undefined,
  validRoute: true,
  onLoad(query: unknown = {}) {
    this.validRoute =
      typeof query === 'object' &&
      query !== null &&
      !Array.isArray(query) &&
      Object.keys(query).length === 0;
  },
  onShow() {
    this.clearPage();
    if (!this.validRoute) {
      this.setData({ error: '活动入口链接无效' });
      return;
    }
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({ error: '环境未初始化，请重新打开小程序' });
      return;
    }
    this.visits = new ActivityVisitController(runtime, (visit) =>
      this.setData({ visit }),
    );
    this.visits.restore();
    this.preferences = new ActivityPreferenceController(runtime, (preference) =>
      this.setData({ preference }),
    );
    this.navigator = new DirectoryNavigator(wx, () =>
      this.setData({ error: '暂不能打开活动详情，请重试' }),
    );
    this.controller = new ActivityController(
      runtime,
      'list',
      (view) => {
        const controller = this.controller;
        this.setData({ ...view }, () => {
          if (controller && this.controller === controller)
            controller.visible(view.renderKey);
        });
      },
      (context) => {
        void this.visits?.acknowledge(context);
      },
      () => this.visits?.cancel(),
    );
    this.unsubscribeHide = runtime.privateViews?.subscribe((accountId) => {
      if (accountId === undefined) this.clearPage();
    });
    void this.controller.load();
    void this.preferences.load();
  },
  onRefresh() {
    void this.controller?.refresh();
  },
  onAll() {
    void this.controller?.chooseAll();
  },
  onNext() {
    void this.controller?.next();
  },
  onPrevious() {
    void this.controller?.previous();
  },
  onCancel() {
    this.controller?.cancel();
  },
  onVisitRetry() {
    void this.visits?.retry();
  },
  onPreference(event: { detail: { value: boolean } }) {
    this.preferences?.choose(event.detail.value);
  },
  onPreferenceSave() {
    void this.preferences?.save();
  },
  onPreferenceReload() {
    void this.preferences?.load();
  },
  onActivity(event: { currentTarget: { dataset: { id: string } } }) {
    this.navigator?.open(
      this.controller?.detailPath(event.currentTarget.dataset.id) ?? null,
    );
  },
  clearPage() {
    this.controller?.dispose();
    this.controller = undefined;
    this.visits?.dispose();
    this.visits = undefined;
    this.preferences?.dispose();
    this.preferences = undefined;
    this.navigator?.dispose();
    this.navigator = undefined;
    this.unsubscribeHide?.();
    this.unsubscribeHide = undefined;
  },
  onHide() {
    this.clearPage();
  },
  onUnload() {
    this.clearPage();
  },
});
