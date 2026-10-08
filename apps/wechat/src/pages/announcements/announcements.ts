import type { WhaleuApp } from '../../app';
import {
  AnnouncementReadController,
  decodeAnnouncementRoute,
  initialAnnouncementReadView,
  type AnnouncementRoute,
} from '../../announcements/controller';
import { AnnouncementNavigator } from '../../announcements/navigation';
Page({
  data: { ...initialAnnouncementReadView() },
  route: null as AnnouncementRoute | null,
  controller: undefined as AnnouncementReadController | undefined,
  navigator: undefined as AnnouncementNavigator | undefined,
  subscriptions: [] as (() => void)[],
  onLoad(query: unknown = {}) {
    this.subscriptions = [];
    try {
      this.route = decodeAnnouncementRoute(query, 'list');
    } catch {
      this.route = null;
    }
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) return;
    let owner = runtime.sessions.snapshot();
    const invalidate = () => {
      this.route = { campusId: null };
      this.navigator?.dispose();
      this.navigator = undefined;
    };
    this.subscriptions.push(
      runtime.sessions.subscribe(() => {
        const current = runtime.sessions.snapshot();
        if (
          current.epoch !== owner.epoch ||
          current.credentials?.accountId !== owner.credentials?.accountId
        ) {
          owner = current;
          invalidate();
        }
      }),
    );
    if (runtime.browsingScopeChanges)
      this.subscriptions.push(
        runtime.browsingScopeChanges.subscribe((accountId) => {
          if (
            accountId === undefined ||
            accountId === owner.credentials?.accountId
          )
            invalidate();
        }),
      );
    if (runtime.safetyChanges)
      this.subscriptions.push(
        runtime.safetyChanges.subscribe((accountId) => {
          if (accountId === owner.credentials?.accountId) invalidate();
        }),
      );
    if (runtime.privateViews)
      this.subscriptions.push(
        runtime.privateViews.subscribe((accountId) => {
          if (accountId === undefined) {
            this.navigator?.dispose();
            this.navigator = undefined;
          }
        }),
      );
  },
  onShow() {
    this.controller?.dispose();
    this.controller = undefined;
    this.navigator?.dispose();
    this.navigator = undefined;
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({
        ...initialAnnouncementReadView(),
        error: '环境未初始化，请重新打开小程序',
      });
      return;
    }
    this.navigator = new AnnouncementNavigator(wx, () =>
      this.setData({ error: '暂不能打开公告，请重试' }),
    );
    this.controller = new AnnouncementReadController(runtime, 'list', (view) =>
      this.setData({ ...view }),
    );
    void this.controller.load(this.route);
  },
  onRefresh() {
    this.onShow();
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
  onAnnouncement(event: { currentTarget: { dataset: { id: string } } }) {
    const path =
      this.controller?.detailPath(event.currentTarget.dataset.id) ?? null;
    if (path) {
      this.controller?.cancel();
      this.navigator?.open(path);
    }
  },
  onHide() {
    this.controller?.dispose();
    this.controller = undefined;
    this.navigator?.dispose();
    this.navigator = undefined;
  },
  onUnload() {
    this.onHide();
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.subscriptions = [];
    this.route = null;
  },
});
