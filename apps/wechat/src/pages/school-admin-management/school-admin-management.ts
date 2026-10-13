import type { WhaleuApp } from '../../app';
import { isUuid } from '../../profile/contract';
import {
  SchoolAdminManagementController,
  initialSchoolAdminManagementView,
} from '../../school-admin-management/controller';
import type { SchoolAdminAction } from '../../school-admin-management/contract';
Page({
  data: { ...initialSchoolAdminManagementView(), addressError: '' },
  targetProfileId: '',
  controller: undefined as SchoolAdminManagementController | undefined,
  onLoad(query: { targetProfileId?: string } = {}) {
    this.targetProfileId = '';
    if (query.targetProfileId === undefined) return;
    if (isUuid(query.targetProfileId))
      this.targetProfileId = query.targetProfileId;
    else
      this.setData({ addressError: '公开主页地址无效；仍可恢复本账号原请求' });
  },
  onShow() {
    this.onHide();
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({ addressError: '环境尚未初始化' });
      return;
    }
    this.controller = new SchoolAdminManagementController(
      runtime,
      (view) => this.setData({ ...view }),
      () => getApp<WhaleuApp>().profileAvatar?.invalidate(),
    );
    void this.controller.load(this.targetProfileId);
  },
  onTargetInput(event: { detail: { value: string } }) {
    this.controller?.setTarget(event.detail.value);
    this.targetProfileId = this.data.targetProfileId;
    this.setData({ addressError: '' });
  },
  onReload() {
    void this.controller?.load(
      this.data.targetProfileId || this.targetProfileId,
    );
  },
  onSelectRegion(event: { currentTarget: { dataset: { id: string } } }) {
    this.controller?.selectRegion(event.currentTarget.dataset.id);
  },
  onRequest(event: { currentTarget: { dataset: { action: string } } }) {
    const action = event.currentTarget.dataset.action;
    if (['appoint', 'reassign', 'revoke'].includes(action))
      this.controller?.request(action as SchoolAdminAction);
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
