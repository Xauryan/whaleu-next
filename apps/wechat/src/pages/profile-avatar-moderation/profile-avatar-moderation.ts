import type { WhaleuApp } from '../../app';
import {
  decodeProfileAvatarModerationTarget,
  type ProfileAvatarModerationTarget,
} from '../../profile-avatar-moderation/contract';
import {
  ProfileAvatarModerationController,
  initialProfileAvatarModerationView,
} from '../../profile-avatar-moderation/controller';
Page({
  onToggleDetails() {
    this.setData({ detailsExpanded: !this.data.detailsExpanded });
  },
  data: {
    detailsExpanded: false,
    ...initialProfileAvatarModerationView(),
    addressError: '',
  },
  target: null as ProfileAvatarModerationTarget | null,
  controller: undefined as ProfileAvatarModerationController | undefined,
  onLoad(query: { kind?: string; id?: string } = {}) {
    this.target = null;
    if (query.kind === undefined && query.id === undefined) return;
    try {
      this.target = decodeProfileAvatarModerationTarget({
        kind: query.kind,
        id: query.id,
      });
    } catch {
      this.setData({ addressError: '内容地址无效；仍可恢复本账号原请求' });
    }
  },
  onShow() {
    this.onHide();
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({ addressError: '环境尚未初始化' });
      return;
    }
    this.controller = new ProfileAvatarModerationController(
      runtime,
      (view) => this.setData({ ...view }),
      () => getApp<WhaleuApp>().profileAvatar?.invalidate(),
    );
    void this.controller.load(this.target ?? undefined);
  },
  onReload() {
    getApp<WhaleuApp>().profileAvatar?.invalidate();
    void this.controller?.load(this.target ?? undefined);
  },
  onClearCustomAvatar() {
    if (this.target) void this.controller?.request(this.target);
  },
  onSubmit() {
    getApp<WhaleuApp>().profileAvatar?.invalidate();
    void this.controller?.submit();
  },
  onClose() {
    getApp<WhaleuApp>().profileAvatar?.invalidate();
    this.controller?.closeConfirmation();
  },
  onRecover() {
    void this.controller?.recover();
  },
  onRetry() {
    void this.controller?.recover(true);
  },
  onCancelRequest() {
    this.controller?.requestCancellation();
  },
  onConfirmCancel() {
    void this.controller?.confirmCancellation();
  },
  onStopWaiting() {
    this.controller?.cancel();
  },
  onHide() {
    getApp<WhaleuApp>().profileAvatar?.invalidate();
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.onHide();
  },
});
