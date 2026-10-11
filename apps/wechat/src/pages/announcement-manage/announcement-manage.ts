import type { WhaleuApp } from '../../app';
import { clientConfiguration } from '../../config';
import { WechatStorage } from '../../platform/wechat';
import { AnnouncementManagementGateway } from '../../announcements/authoring/gateway';
import { AnnouncementPublicationJournal } from '../../announcements/authoring/pending';
import {
  AnnouncementAuthoringController,
  initialAuthoringView,
} from '../../announcements/authoring/controller';
Page({
  data: { ...initialAuthoringView() },
  controller: undefined as AnnouncementAuthoringController | undefined,
  stop: undefined as (() => void) | undefined,
  onShow() {
    this.onHide();
    const app = getApp<WhaleuApp>();
    if (!app.identity?.api || !app.community) {
      this.setData({ error: '环境未配置' });
      return;
    }
    this.controller = new AnnouncementAuthoringController(
      app.identity.sessions,
      new AnnouncementManagementGateway(app.identity.api),
      new AnnouncementPublicationJournal(
        new WechatStorage(wx),
        clientConfiguration.apiOrigin,
      ),
      app.community.newRequestId,
      (v) => this.setData({ ...v }),
    );
    this.stop = app.community.privateViews?.subscribe(() => this.onHide());
    void this.controller.load(null, true);
  },
  onMore() {
    void this.controller?.more();
  },
  onRefresh() {
    this.onShow();
  },
  onNew() {
    if (!this.data.busy && this.data.management !== 'none')
      wx.navigateTo?.({
        url: '/pages/announcement-edit/announcement-edit',
        success() {},
        fail() {},
      });
  },
  onEdit(e: { currentTarget: { dataset: { id: string } } }) {
    const target = e.currentTarget.dataset.id;
    if (this.data.items.some((i) => i.id === target))
      wx.navigateTo?.({
        url: '/pages/announcement-edit/announcement-edit?id=' + target,
        success() {},
        fail() {},
      });
  },
  onRecovery() {
    if (this.data.pending)
      wx.navigateTo?.({
        url: '/pages/announcement-edit/announcement-edit',
        success() {},
        fail() {},
      });
  },
  onHide() {
    this.controller?.dispose();
    this.controller = undefined;
    this.stop?.();
    this.stop = undefined;
  },
  onUnload() {
    this.onHide();
  },
});
