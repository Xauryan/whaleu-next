import type { WhaleuApp } from '../../app';
import { ClientError } from '../../api/errors';
import { NoticeExposureObserver } from '../../notifications/notice-exposure';
import { systemClock } from '../../platform/clock';
import {
  initialSocialNoticesView,
  socialNoticeKind,
  SocialNoticesController,
  type SocialNoticeKind,
  type SocialNoticesView,
} from './controller';
Page({
  data: { ...initialSocialNoticesView(null), showCoverage: false },
  kind: null as SocialNoticeKind | null,
  controller: undefined as SocialNoticesController | undefined,
  generation: 0,
  noticeExposure: undefined as NoticeExposureObserver | undefined,
  renderNotices(view: SocialNoticesView) {
    const observation = this.noticeExposure?.render(
      view.rows.map(({ busy: _busy, ...row }) => ({
        key: row.id,
        source: row.source,
        noticeId: row.noticeId,
        fingerprint: JSON.stringify(row),
        unread:
          row.unread &&
          view.sources.some(
            (source) =>
              source.key === row.source && source.loaded && !source.error,
          ),
      })),
      `social:${this.kind ?? ''}`,
      view.hasSession && view.loaded && !view.busy && !view.unavailable,
      view.hasSession && view.loaded && view.busy && !view.unavailable,
    );
    this.setData(
      {
        ...view,
        rows: view.rows.map((row) => ({
          ...row,
          observationId: observation?.ids.get(row.id) ?? '',
        })),
      },
      observation?.committed,
    );
  },
  onLoad(query: unknown) {
    this.onHide();
    this.kind = socialNoticeKind(query);
    this.setData({
      ...initialSocialNoticesView(this.kind),
      showCoverage: false,
    });
  },
  async onShow() {
    this.onHide();
    if (!this.kind) {
      this.setData({ error: '互动消息链接无效' });
      return;
    }
    const app = getApp<WhaleuApp>();
    const runtime = app.community;
    if (!runtime) {
      this.setData({ error: '环境未初始化，请重新打开小程序' });
      return;
    }
    const generation = this.generation;
    this.noticeExposure = new NoticeExposureObserver(
      wx,
      this,
      systemClock,
      runtime,
      async (row, guard) => {
        if (generation === this.generation)
          await this.controller?.acknowledge(row.key, guard);
      },
      () => {
        if (generation === this.generation && this.controller)
          this.renderNotices(this.controller.snapshot());
      },
    );
    this.controller = new SocialNoticesController(
      runtime,
      this.kind,
      (view) => {
        if (generation === this.generation) this.renderNotices(view);
      },
      (url) =>
        new Promise<void>((resolve, reject) => {
          if (!wx.navigateTo) {
            reject(new ClientError('configuration', 'Navigation unavailable'));
            return;
          }
          wx.navigateTo({
            url,
            success: resolve,
            fail: () => reject(new ClientError('network', 'Navigation failed')),
          });
        }),
      app.identity?.sessions === runtime.sessions
        ? app.identity.api
        : undefined,
    );
    await this.controller.load();
  },
  onReload() {
    void this.onShow();
  },
  async onPullDownRefresh() {
    try {
      await this.onShow();
    } finally {
      wx.stopPullDownRefresh?.();
    }
  },
  onCoverage() {
    this.noticeExposure?.clear();
    this.setData({ showCoverage: !this.data.showCoverage });
    if (this.controller) this.renderNotices(this.controller.snapshot());
  },
  onMore(event: { currentTarget: { dataset: { source?: string } } }) {
    this.noticeExposure?.clear();
    void this.controller?.more(event.currentTarget.dataset.source);
  },
  onOpen(event: { currentTarget: { dataset: { id: string } } }) {
    this.noticeExposure?.clear();
    void this.controller?.open(event.currentTarget.dataset.id);
  },
  onRead(event: { currentTarget: { dataset: { id: string } } }) {
    this.noticeExposure?.clear();
    void this.controller?.acknowledge(event.currentTarget.dataset.id);
  },
  onCancel() {
    this.noticeExposure?.clear();
    this.controller?.cancel();
  },
  onHide() {
    this.generation++;
    this.noticeExposure?.dispose();
    this.noticeExposure = undefined;
    this.controller?.dispose();
    this.controller = undefined;
    this.setData({
      ...initialSocialNoticesView(this.kind),
      showCoverage: false,
    });
  },
  onUnload() {
    this.onHide();
    this.kind = null;
  },
});
