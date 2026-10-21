import {
  OwnSchoolUidController,
  initialOwnSchoolUidView,
} from '../../school-uid/controller';
import type { SessionTicket } from '../../auth/session';
import {
  initialAvatarEditView,
  type ProfileAvatarController,
} from '../../profile/avatar-controller';
import {
  initialAvatarReadView,
  type AvatarReadController,
} from '../../profile/avatar-read-controller';
import {
  initialCoverEditView,
  type ProfileCoverController,
} from '../../profile/cover-controller';
import { createNativeProfileCoverEditor } from '../../profile/cover-editor-runtime';
import {
  initialCoverReadView,
  type CoverReadController,
} from '../../profile/cover-read-controller';
import { messagingRuntime } from '../../messaging/entry';
import {
  MessagingUnreadController,
  initialUnreadView,
} from '../../messaging/unread-controller';
import type { WhaleuApp } from '../../app';
import type { PreferenceKey } from '../../profile/contract';
import { HttpProfileGateway } from '../../profile/gateway';
import {
  initialProfileDetailsView,
  ProfileDetailsController,
} from '../../profile/details-controller';
import { HttpProfileDetailsGateway } from '../../profile/details-gateway';
import { initialProfileView, ProfileController } from './controller';
declare const getCurrentPages: (() => readonly unknown[]) | undefined;

Page({
  data: {
    ...initialProfileView(),
    schoolUidView: initialOwnSchoolUidView(),
    privateMessages: initialUnreadView(),
    avatar: initialAvatarEditView(),
    avatarRead: initialAvatarReadView(),
    details: initialProfileDetailsView(),
    detailGenderLabels: ['私密', '女', '男'],
    showAvatarTools: false,
    showMoreTools: false,
    showCoverTools: false,
    showDetailsVisibility: false,
    showPreferences: false,
    cover: initialCoverEditView(),
    coverRead: initialCoverReadView(),
    coverConfigured: false,
    canGoBack: false,
  },
  avatarPageGeneration: 0,
  avatarTicket: null as SessionTicket | null,
  avatarController: undefined as ProfileAvatarController | undefined,
  avatarReader: undefined as AvatarReadController | undefined,
  messagingUnread: undefined as MessagingUnreadController | undefined,
  controller: undefined as ProfileController | undefined,
  schoolUidController: undefined as OwnSchoolUidController | undefined,
  detailsController: undefined as ProfileDetailsController | undefined,
  coverController: undefined as ProfileCoverController | undefined,
  coverReader: undefined as CoverReadController | undefined,
  onToggleEditorPanel(event: {
    currentTarget: { dataset: { panel: string } };
  }) {
    if (event.currentTarget.dataset.panel === 'visibility')
      this.setData({ showDetailsVisibility: !this.data.showDetailsVisibility });
    else if (event.currentTarget.dataset.panel === 'preferences')
      this.setData({ showPreferences: !this.data.showPreferences });
  },
  onToggleCoverTools() {
    this.setData({ showCoverTools: !this.data.showCoverTools });
  },
  activateCoverEditor() {
    const app = getApp<WhaleuApp>();
    this.setData({ coverConfigured: !!app.profileCover });
    this.coverReader?.dispose();
    this.coverReader = undefined;
    if (!app.identity?.sessions.snapshot().credentials) {
      this.coverController?.dispose();
      this.coverController = undefined;
      return;
    }
    this.coverReader = app.profileCover?.createReader((coverRead) =>
      this.setData({ coverRead }),
    );
    void this.coverReader?.load(null, true);
    if (this.coverController?.isNativePickerPending()) {
      this.coverController.resume();
      return;
    }
    this.coverController?.dispose();
    this.coverController = app.profileCover
      ? createNativeProfileCoverEditor(
          app.profileCover,
          (cover) => this.setData({ cover }),
          () => void this.coverReader?.load(null, true),
        )
      : undefined;
    void this.coverController?.load();
  },
  onChooseCover() {
    void this.coverController?.chooseCustomCover();
  },
  onClearCover() {
    void this.coverController?.selectClear();
  },
  async onSaveCover() {
    await this.coverController?.save();
    if (this.data.cover.needsReload) await this.coverController?.load();
  },
  onReloadCover() {
    void this.coverController?.load();
    void this.coverReader?.load(null, true);
  },
  onRecoverCover() {
    void this.coverController?.recover();
  },
  onRetryCover() {
    void this.coverController?.recover(true);
  },
  onCancelCoverCommand() {
    void this.coverController?.cancelPendingCommand();
  },
  onCancelCoverEdit() {
    void this.coverController?.cancelPendingEdit();
  },
  onStopCover() {
    this.coverController?.cancelOperation();
  },
  onCoverImageError() {
    this.coverReader?.imageFailed();
  },
  onToggleAvatarTools() {
    this.setData({ showAvatarTools: !this.data.showAvatarTools });
  },
  onToggleMoreTools() {
    this.setData({ showMoreTools: !this.data.showMoreTools });
  },
  onShow() {
    this.setData({
      canGoBack:
        typeof getCurrentPages === 'function' && getCurrentPages().length > 1,
    });
    this.activateCoverEditor();
    this.detailsController?.dispose();
    const app = getApp<WhaleuApp>();
    if (app.community) {
      this.detailsController = new ProfileDetailsController(
        app.community,
        app.identity?.api
          ? new HttpProfileDetailsGateway(app.identity.api)
          : undefined,
        (details) => this.setData({ details }),
      );
      void this.detailsController.load();
    }
    this.schoolUidController?.dispose();
    const schoolUidRuntime = getApp<WhaleuApp>().community;
    if (schoolUidRuntime) {
      this.schoolUidController = new OwnSchoolUidController(
        schoolUidRuntime,
        (view) => this.setData({ schoolUidView: view }),
      );
      void this.schoolUidController.load();
    }
    const generation = ++this.avatarPageGeneration;
    this.deactivateAvatar();
    this.setData({
      ...initialProfileView(),
      showDetailsVisibility: false,
      showPreferences: false,
      showMoreTools: false,
    });
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
    void this.detailsController?.load();
    void this.schoolUidController?.load();
    void this.controller?.load();
  },
  onDetailsRegion(event: { detail: { value: string } }) {
    this.detailsController?.setRegion(event.detail.value);
  },
  onDetailsAge(event: { detail: { value: string } }) {
    this.detailsController?.setAge(event.detail.value);
  },
  onDetailsGender(event: { detail: { value: string } }) {
    const value = ['', 'female', 'male'][Number(event.detail.value)];
    if (value !== undefined) this.detailsController?.setGender(value);
  },
  onDetailsVisibility(event: {
    currentTarget: { dataset: { key: string } };
    detail: { value: boolean };
  }) {
    this.detailsController?.setVisibility(
      event.currentTarget.dataset.key,
      event.detail.value,
    );
  },
  onSaveDetails() {
    void this.detailsController?.save();
  },
  onReloadDetails() {
    void this.detailsController?.load();
  },
  onCancelDetails() {
    this.detailsController?.cancelEdits();
  },
  onCancelEdits() {
    this.controller?.cancelEdits();
  },
  onCancelOperation() {
    this.controller?.cancelOperation();
  },
  onHide() {
    this.coverReader?.dispose();
    this.coverReader = undefined;
    if (this.coverController?.isNativePickerPending())
      this.coverController.hide();
    else {
      this.coverController?.dispose();
      this.coverController = undefined;
    }
    this.detailsController?.dispose();
    this.detailsController = undefined;
    this.schoolUidController?.dispose();
    this.schoolUidController = undefined;
    this.avatarPageGeneration++;
    this.deactivateAvatar();
    this.setData({
      ...initialProfileView(),
      showDetailsVisibility: false,
      showPreferences: false,
      showMoreTools: false,
    });
    this.messagingUnread?.dispose();
    this.messagingUnread = undefined;
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.coverReader?.dispose();
    this.coverReader = undefined;
    this.coverController?.dispose();
    this.coverController = undefined;
    this.detailsController?.dispose();
    this.detailsController = undefined;
    this.schoolUidController?.dispose();
    this.schoolUidController = undefined;
    this.avatarPageGeneration++;
    this.deactivateAvatar();
    this.setData({
      ...initialProfileView(),
      showDetailsVisibility: false,
      showPreferences: false,
      showMoreTools: false,
    });
    this.messagingUnread?.dispose();
    this.messagingUnread = undefined;
    this.controller?.dispose();
    this.controller = undefined;
  },
});
