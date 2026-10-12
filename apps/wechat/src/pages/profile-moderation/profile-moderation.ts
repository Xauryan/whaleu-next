import type { WhaleuApp } from '../../app';
import {
  decodeProfileModerationTarget,
  type ProfileModerationTarget,
} from '../../profile-moderation/contract';
import {
  ProfileModerationController,
  initialProfileModerationView,
} from '../../profile-moderation/controller';
Page({
  data: { ...initialProfileModerationView(), addressError: '' },
  target: null as ProfileModerationTarget | null,
  controller: undefined as ProfileModerationController | undefined,
  onLoad(query: { kind?: string; id?: string } = {}) {
    this.target = null;
    if (query.kind === undefined && query.id === undefined) return;
    try {
      this.target = decodeProfileModerationTarget({
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
    this.controller = new ProfileModerationController(runtime, (view) =>
      this.setData({ ...view }),
    );
    void this.controller.load(this.target ?? undefined);
  },
  onReload() {
    void this.controller?.load(this.target ?? undefined);
  },
  onResetNickname() {
    if (this.target) void this.controller?.request(this.target);
  },
  onSubmit() {
    void this.controller?.submit();
  },
  onClose() {
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
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.onHide();
  },
});
