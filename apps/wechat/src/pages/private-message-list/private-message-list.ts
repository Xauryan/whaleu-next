import type { WhaleuApp } from '../../app';
import { privateMessageTime } from '../private-message-detail/presentation';
import { messagingRuntime } from '../../messaging/entry';
import {
  MessagingListController,
  initialListView,
} from '../../messaging/list-controller';
Page({
  data: {
    ...initialListView(),
    uiMenu: false,
    uiRowMenu: '',
    uiItems: [] as (ReturnType<typeof initialListView>['items'][number] & {
      timeLabel: string;
      initial: string;
    })[],
  },
  controller: undefined as MessagingListController | undefined,
  onShow() {
    this.controller?.dispose();
    this.setData({ uiMenu: false, uiRowMenu: '' });
    const runtime = messagingRuntime(getApp<WhaleuApp>().community);
    if (!runtime) {
      this.setData({ error: '私信环境尚未初始化' });
      return;
    }
    this.controller = new MessagingListController(runtime, (view, done) =>
      this.setData(
        {
          ...view,
          uiMenu: view.loaded ? this.data.uiMenu : false,
          uiRowMenu: view.items.some((item) => item.id === this.data.uiRowMenu)
            ? this.data.uiRowMenu
            : '',
          uiItems: view.items.map((item) => ({
            ...item,
            timeLabel: privateMessageTime(item.updatedAt),
            initial: [...item.conversation.peer.displayName.trim()][0] ?? '',
          })),
        },
        done,
      ),
    );
    void this.controller.load();
  },
  onToggleMenu() {
    this.setData({ uiMenu: !this.data.uiMenu, uiRowMenu: '' });
  },
  onToggleRow(event: { currentTarget: { dataset: { id: string } } }) {
    const id = event.currentTarget.dataset.id;
    if (!this.data.items.some((item) => item.id === id)) return;
    this.setData({
      uiRowMenu: this.data.uiRowMenu === id ? '' : id,
      uiMenu: false,
    });
  },
  onCloseMenus() {
    this.setData({ uiMenu: false, uiRowMenu: '' });
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
    this.onCloseMenus();
    this.controller?.requestHide(event.currentTarget.dataset.id);
  },
  onConfirmHide() {
    void this.controller?.confirmHide();
  },
  onDismiss() {
    this.controller?.dismiss();
  },
  onHide() {
    this.onCloseMenus();
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.onHide();
  },
});
