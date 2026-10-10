import type { SessionTicket } from '../../auth/session';
import {
  initialAvatarEditView,
  type ProfileAvatarController,
} from '../../profile/avatar-controller';
import {
  initialAvatarReadView,
  type AvatarReadController,
} from '../../profile/avatar-read-controller';
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
  data: {
    ...initialProfileView(),
    privateMessages: initialUnreadView(),
    avatar: initialAvatarEditView(),
    avatarRead: initialAvatarReadView(),
  },
  avatarPageGeneration: 0,
  avatarTicket: null as SessionTicket | null,
  avatarController: undefined as ProfileAvatarController | undefined,
  avatarReader: undefined as AvatarReadController | undefined,
  messagingUnread: undefined as MessagingUnreadController | undefined,
  controller: undefined as ProfileController | undefined,
  onShow() {
    const generation = ++this.avatarPageGeneration;
    this.deactivateAvatar();
    this.setData({ ...initialProfileView() });
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
    const holder: { current?: ProfileController } = {};
    const controller = new ProfileController(
      runtime.sessions,
      runtime.api ? new HttpProfileGateway(runtime.api) : undefined,
      (view) => {
        if (this.avatarPageGeneration !== generation) return;
        this.setData({ ...view });
        const ticket = holder.current?.avatarBasicsTicket();
        if (ticket) this.activateAvatar(ticket, generation);
        else this.deactivateAvatar();
      },
    );
    holder.current = controller;
    this.controller = controller;
    void controller.load();
  },
  deactivateAvatar() {
    this.avatarTicket = null;
    const editor = this.avatarController,
      reader = this.avatarReader;
    this.avatarController = undefined;
    this.avatarReader = undefined;
    editor?.dispose();
    reader?.dispose();
    this.setData({
      avatar: initialAvatarEditView(),
      avatarRead: initialAvatarReadView(),
    });
  },
  activateAvatar(ticket: SessionTicket, generation: number) {
    const runtime = getApp<WhaleuApp>().identity;
    if (
      !runtime ||
      this.avatarPageGeneration !== generation ||
      !ticket.credentials
    )
      return;
    try {
      runtime.sessions.assertCurrent(ticket);
    } catch {
      return;
    }
    if (
      this.avatarTicket?.epoch === ticket.epoch &&
      this.avatarTicket.credentials?.accountId === ticket.credentials.accountId
    )
      return;
    this.deactivateAvatar();
    const media = getApp<WhaleuApp>().profileAvatar;
    if (!media) {
      this.setData({
        avatar: { ...initialAvatarEditView(), status: '头像媒体暂不可用' },
      });
      return;
    }
    this.avatarTicket = ticket;
    this.avatarReader = media.createReader((view) =>
      this.setData({ avatarRead: view }),
    );
    this.avatarController = media.createEditor(
      (view) => this.setData({ avatar: view }),
      () => {
        if (this.avatarPageGeneration !== generation) return;
        try {
          runtime.sessions.assertCurrent(ticket);
        } catch {
          return;
        }
        // Fresh basics must finish before the current avatar is loaded again.
        void this.controller?.load();
      },
    );
    void this.avatarController.load();
    void this.avatarReader.load(null);
  },
  onChooseCustomAvatar() {
    if (
      this.data.loading ||
      this.data.saving ||
      this.data.profileDirty ||
      this.data.preferencesDirty
    )
      return;
    void this.avatarController?.chooseCustomAvatar();
  },
  onAvatarCatalog(event: { currentTarget: { dataset: { item: string } } }) {
    if (
      this.data.loading ||
      this.data.saving ||
      this.data.profileDirty ||
      this.data.preferencesDirty
    )
      return;
    void this.avatarController?.selectCatalog(event.currentTarget.dataset.item);
  },
  onClearAvatar() {
    if (
      this.data.loading ||
      this.data.saving ||
      this.data.profileDirty ||
      this.data.preferencesDirty
    )
      return;
    void this.avatarController?.selectClear();
  },
  onSaveAvatar() {
    void this.avatarController?.save();
  },
  onRecoverAvatar() {
    void this.avatarController?.recover();
  },
  onRetryAvatar() {
    void this.avatarController?.recover(true);
  },
  onCancelAvatarCommand() {
    void this.avatarController?.cancelPendingCommand();
  },
  onCancelAvatarEdit() {
    void this.avatarController?.cancelPendingEdit();
  },
  onStopAvatar() {
    this.avatarController?.cancelOperation();
  },
  onReloadAvatar() {
    void this.controller?.load();
  },
  onOpenAvatar() {
    void this.avatarReader?.open();
  },
  onCloseAvatar() {
    void this.avatarReader?.close();
  },
  onAvatarImageError() {
    this.avatarReader?.imageFailed();
  },
  onNickname(event: { detail: { value: string } }) {
    if (
      this.data.avatar.busy ||
      this.data.avatar.canSave ||
      this.data.avatar.needsRecovery
    )
      return;
    this.controller?.setNickname(event.detail.value);
  },
  onBio(event: { detail: { value: string } }) {
    if (
      this.data.avatar.busy ||
      this.data.avatar.canSave ||
      this.data.avatar.needsRecovery
    )
      return;
    this.controller?.setBio(event.detail.value);
  },
  onPreference(event: {
    detail: { value: boolean };
    currentTarget: { dataset: { key: PreferenceKey } };
  }) {
    if (
      this.data.avatar.busy ||
      this.data.avatar.canSave ||
      this.data.avatar.needsRecovery
    )
      return;
    this.controller?.setPreference(
      event.currentTarget.dataset.key,
      event.detail.value,
    );
  },
  async onSaveProfile() {
    if (
      this.data.avatar.busy ||
      this.data.avatar.canSave ||
      this.data.avatar.needsRecovery
    )
      return;
    getApp<WhaleuApp>().profileAvatar?.invalidate();
    await this.controller?.saveProfile();
  },
  async onSavePreferences() {
    if (
      this.data.avatar.busy ||
      this.data.avatar.canSave ||
      this.data.avatar.needsRecovery
    )
      return;
    getApp<WhaleuApp>().profileAvatar?.invalidate();
    await this.controller?.savePreferences();
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
    this.avatarPageGeneration++;
    this.deactivateAvatar();
    this.setData({ ...initialProfileView() });
    this.messagingUnread?.dispose();
    this.messagingUnread = undefined;
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.avatarPageGeneration++;
    this.deactivateAvatar();
    this.setData({ ...initialProfileView() });
    this.messagingUnread?.dispose();
    this.messagingUnread = undefined;
    this.controller?.dispose();
    this.controller = undefined;
  },
});
