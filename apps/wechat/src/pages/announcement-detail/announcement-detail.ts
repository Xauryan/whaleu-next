import type { AnnouncementMediaReader } from '../../media/announcement-runtime';
import type { AnnouncementMediaSlot } from '../../media/announcement-validation';
import type { WhaleuApp } from '../../app';
import {
  AnnouncementReadController,
  decodeAnnouncementRoute,
  initialAnnouncementReadView,
  type AnnouncementRoute,
} from '../../announcements/controller';
import { AnnouncementNavigator } from '../../announcements/navigation';
Page({
  data: {
    ...initialAnnouncementReadView(),
    showInfo: false,
    image: { status: 'idle', src: '', message: '' },
  },
  reader: undefined as AnnouncementMediaReader | undefined,
  route: null as AnnouncementRoute | null,
  controller: undefined as AnnouncementReadController | undefined,
  navigator: undefined as AnnouncementNavigator | undefined,
  subscriptions: [] as (() => void)[],
  onLoad(query: unknown = {}) {
    this.subscriptions = [];
    try {
      this.route = decodeAnnouncementRoute(query, 'detail');
    } catch {
      this.route = null;
    }
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) return;
    let owner = runtime.sessions.snapshot();
    const invalidate = () => {
      this.route = null;
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
  onToggleInfo() {
    this.setData({ showInfo: !this.data.showInfo });
  },
  onShow() {
    this.setData({ showInfo: false });
    this.reader?.dispose();
    this.reader = getApp<WhaleuApp>().announcementMedia?.createReader((image) =>
      this.setData({ image }),
    );
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
    this.controller = new AnnouncementReadController(
      runtime,
      'detail',
      (view) => {
        if (this.data.detail?.revision !== view.detail?.revision)
          this.reader?.clear();
        this.setData({ ...view });
      },
    );
    void this.controller.load(this.route);
  },
  onImage(event: {
    currentTarget: { dataset: { slot: AnnouncementMediaSlot } };
  }) {
    const detail = this.data.detail;
    if (detail?.media.status !== 'available') return;
    const ref = detail.media.items.find(
      (i) => i.slot === event.currentTarget.dataset.slot,
    );
    if (ref)
      void this.reader?.load({
        ...ref,
        slot: event.currentTarget.dataset.slot,
        audience: 'public',
        campusId: this.data.campusId,
      });
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
    this.setData({ showInfo: false });
    this.reader?.dispose();
    this.reader = undefined;
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
