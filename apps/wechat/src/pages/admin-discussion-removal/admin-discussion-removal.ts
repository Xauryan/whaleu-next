import { isUuid } from '../../profile/contract';
import type { WhaleuApp } from '../../app';
import {
  decodeAdminDiscussionRemovalTarget,
  type AdminDiscussionRemovalTarget,
} from '../../admin-discussion-removal/contract';
import {
  AdminDiscussionRemovalController,
  initialAdminDiscussionRemovalView,
} from '../../admin-discussion-removal/controller';
Page({
  data: {
    ...initialAdminDiscussionRemovalView(),
    addressError: '',
    punishmentKind: 'none',
    punishmentUnit: 'days',
    punishmentValue: '7',
    punishmentReason: '',
  },
  target: null as AdminDiscussionRemovalTarget | null,
  viewSpaceId: undefined as string | undefined,
  controller: undefined as AdminDiscussionRemovalController | undefined,
  onLoad(query: { kind?: string; id?: string; viewSpaceId?: string } = {}) {
    this.target = null;
    this.viewSpaceId = undefined;
    if (query.kind === undefined && query.id === undefined) return;
    try {
      if (query.viewSpaceId !== undefined && !isUuid(query.viewSpaceId))
        throw new Error('Invalid view space');
      this.viewSpaceId = query.viewSpaceId;
      this.target = decodeAdminDiscussionRemovalTarget({
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
    this.controller = new AdminDiscussionRemovalController(
      runtime,
      (view) => this.setData({ ...view }),
      () => getApp<WhaleuApp>().profileAvatar?.invalidate(),
    );
    void this.controller.load(this.target ?? undefined, this.viewSpaceId);
  },
  onReload() {
    getApp<WhaleuApp>().profileAvatar?.invalidate();
    void this.controller?.load(this.target ?? undefined, this.viewSpaceId);
  },
  onRemoveDiscussion() {
    this.setData({
      punishmentKind: 'none',
      punishmentUnit: 'days',
      punishmentValue: '7',
      punishmentReason: '',
    });
    if (this.target)
      void this.controller?.request(this.target, this.viewSpaceId);
  },
  onPunishmentKind(event: { detail: { value: string } }) {
    this.setData({ punishmentKind: event.detail.value });
  },
  onPunishmentUnit(event: { detail: { value: string } }) {
    this.setData({ punishmentUnit: event.detail.value });
  },
  onPunishmentValue(event: { detail: { value: string } }) {
    this.setData({ punishmentValue: event.detail.value });
  },
  onPunishmentReason(event: { detail: { value: string } }) {
    this.setData({ punishmentReason: event.detail.value });
  },
  onSubmit() {
    const kind = this.data.punishmentKind;
    const options = this.data.management?.punishmentOptions;
    if (
      kind !== 'none' &&
      kind !== 'interaction_mute' &&
      kind !== 'access_suspension'
    )
      return;
    if (kind !== 'none' && !options) return;
    if (
      !this.controller?.selectPunishment(
        kind === 'none'
          ? null
          : {
              kind,
              expectedRevision: options![kind].revision,
              reason: this.data.punishmentReason.trim(),
              duration:
                this.data.punishmentUnit === 'permanent'
                  ? { kind: 'permanent' }
                  : {
                      kind: 'finite',
                      unit: this.data.punishmentUnit,
                      value: Number(this.data.punishmentValue),
                    },
            },
      )
    )
      return;
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
