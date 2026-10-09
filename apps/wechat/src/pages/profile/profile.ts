import { messagingRuntime } from '../../messaging/entry';
import {
  MessagingUnreadController,
  initialUnreadView,
} from '../../messaging/unread-controller';
import type { WhaleuApp } from '../../app';
import type { PreferenceKey } from '../../profile/contract';
import { HttpProfileGateway } from '../../profile/gateway';
import { initialProfileView, ProfileController } from './controller';
Page({
  data: { ...initialProfileView(), privateMessages: initialUnreadView() },
  messagingUnread: undefined as MessagingUnreadController | undefined,
  controller: undefined as ProfileController | undefined,
  onShow() {
    this.messagingUnread?.dispose();
    const messaging = messagingRuntime(getApp<WhaleuApp>().community);
    if (messaging) {
      this.messagingUnread = new MessagingUnreadController(messaging, (view) =>
        this.setData({ privateMessages: view }),
      );
      void this.messagingUnread.load();
    }
    this.controller?.dispose();
    const runtime = getApp<WhaleuApp>().identity;
    if (!runtime) {
      this.setData({ error: '环境未初始化，请重新打开小程序' });
      return;
    }
    this.controller = new ProfileController(
      runtime.sessions,
      runtime.api ? new HttpProfileGateway(runtime.api) : undefined,
      (view) => this.setData({ ...view }),
    );
    void this.controller.load();
  },
  onNickname(event: { detail: { value: string } }) {
    this.controller?.setNickname(event.detail.value);
  },
  onBio(event: { detail: { value: string } }) {
    this.controller?.setBio(event.detail.value);
  },
  onPreference(event: {
    detail: { value: boolean };
    currentTarget: { dataset: { key: PreferenceKey } };
  }) {
    this.controller?.setPreference(
      event.currentTarget.dataset.key,
      event.detail.value,
    );
  },
  onSaveProfile() {
    void this.controller?.saveProfile();
  },
  onSavePreferences() {
    void this.controller?.savePreferences();
  },
  onReload() {
    void this.controller?.load();
  },
  onCancelEdits() {
    this.controller?.cancelEdits();
  },
  onCancelOperation() {
    this.controller?.cancelOperation();
  },
  onHide() {
    this.messagingUnread?.dispose();
    this.messagingUnread = undefined;
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.messagingUnread?.dispose();
    this.messagingUnread = undefined;
    this.controller?.dispose();
    this.controller = undefined;
  },
});
