import { systemNoticeRows } from '../../notifications/details';
import type { WhaleuApp } from '../../app';
import { NoticeExposureObserver } from '../../notifications/notice-exposure';
import { systemClock } from '../../platform/clock';
import {
  SystemTimelineController,
  initialSystemTimelineView,
  type SystemTimelineView,
} from '../../notifications/system-timeline';

Page({
  data: { ...initialSystemTimelineView(), showSources: false },
  controller: undefined as SystemTimelineController | undefined,
  noticeExposure: undefined as NoticeExposureObserver | undefined,
  generation: 0,
  renderNotices(view: SystemTimelineView) {
    const observation = this.noticeExposure?.render(
      view.items.map((row) => ({
        key: row.key,
        source: row.source,
        noticeId: row.noticeId,
        fingerprint: JSON.stringify(row),
        unread:
          row.readAt === null &&
          view.sources.some(
            (source) =>
              source.source === row.source && source.loaded && !source.error,
          ),
      })),
      'system:timeline',
      view.hasSession && view.loaded && !view.busy,
      view.hasSession && view.loaded && view.busy,
    );
    this.setData(
      {
        ...view,
        items: systemNoticeRows(view.items).map((row) => ({
          ...row,
          observationId: observation?.ids.get(row.key) ?? '',
        })),
      },
      observation?.committed,
    );
  },
  onShow() {
    this.onHide();
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({
        ...initialSystemTimelineView(),
        error: '环境未初始化，请重新打开小程序',
      });
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
    this.controller = new SystemTimelineController(
      runtime,
      (view) => {
        if (generation === this.generation) this.renderNotices(view);
      },
      getApp<WhaleuApp>().identity?.api,
      (url) =>
        new Promise<void>((resolve, reject) => {
          if (!wx.navigateTo) {
            reject(new Error('暂时无法打开'));
            return;
          }
          wx.navigateTo({
            url,
            success: () => resolve(),
            fail: () => reject(new Error('暂时无法打开')),
          });
        }),
    );
    void this.controller.load();
  },
  onSources() {
    this.noticeExposure?.clear();
    this.setData({ showSources: !this.data.showSources });
    if (this.controller) this.renderNotices(this.controller.snapshot());
  },
  onReload() {
    this.onShow();
  },
  onMore() {
    this.noticeExposure?.clear();
    void this.controller?.more();
  },
  onRead(event: { currentTarget: { dataset: { id: string } } }) {
    this.noticeExposure?.clear();
    void this.controller?.acknowledge(event.currentTarget.dataset.id);
  },
  onOpen(event: { currentTarget: { dataset: { id: string } } }) {
    this.noticeExposure?.clear();
    const controller = this.controller;
    void controller?.open(event.currentTarget.dataset.id).catch(() => {
      if (this.controller === controller)
        this.setData({ error: '暂时无法打开，请重试' });
    });
  },
  onCancel() {
    this.noticeExposure?.clear();
    this.controller?.cancel();
  },
  onHide() {
    this.generation++;
    this.noticeExposure?.dispose();
    this.noticeExposure = undefined;
    this.setData({ ...initialSystemTimelineView(), showSources: false });
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.onHide();
  },
});
