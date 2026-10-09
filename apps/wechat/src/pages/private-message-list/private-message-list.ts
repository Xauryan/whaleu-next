import type { WhaleuApp } from '../../app';
import { messagingRuntime } from '../../messaging/entry';
import {
  MessagingListController,
  initialListView,
} from '../../messaging/list-controller';
Page({
  data: { ...initialListView() },
  controller: undefined as MessagingListController | undefined,
  onShow() {
    this.controller?.dispose();
    const runtime = messagingRuntime(getApp<WhaleuApp>().community);
    if (!runtime) {
      this.setData({ error: '私信环境尚未初始化' });
      return;
    }
    this.controller = new MessagingListController(runtime, (view, done) =>
      this.setData({ ...view }, done),
    );
    void this.controller.load();
  },
  onReload() {
    void this.controller?.load();
  },
  async onPullDownRefresh() {
    try {
      await this.controller?.load();
    } finally {
      wx.stopPullDownRefresh?.();
    }
  },
  onMore() {
    void this.controller?.more();
  },
  onCancel() {
    this.controller?.cancel();
  },
  onHideConversation(event: { currentTarget: { dataset: { id: string } } }) {
    this.controller?.requestHide(event.currentTarget.dataset.id);
  },
  onConfirmHide() {
    void this.controller?.confirmHide();
  },
  onDismiss() {
    this.controller?.dismiss();
  },
  onHide() {
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.onHide();
  },
});
