import type { WhaleuApp } from '../../app';
import { messagingRuntime } from '../../messaging/entry';
import {
  MessagingRecoveryController,
  initialRecoveryView,
} from '../../messaging/recovery-controller';
Page({
  data: { ...initialRecoveryView(), uiDetails: false, uiActions: false },
  controller: undefined as MessagingRecoveryController | undefined,
  onShow() {
    this.controller?.dispose();
    this.setData({ uiDetails: false, uiActions: false });
    const runtime = messagingRuntime(getApp<WhaleuApp>().community);
    if (!runtime) {
      this.setData({ error: '私信环境尚未初始化' });
      return;
    }
    this.controller = new MessagingRecoveryController(runtime, (view, done) =>
      this.setData(
        {
          ...view,
          uiActions: view.pending ? this.data.uiActions : false,
          uiDetails: view.loaded ? this.data.uiDetails : false,
        },
        done,
      ),
    );
    this.controller.load();
  },
  onToggleDetails() {
    if (!this.data.loaded) return;
    this.setData({ uiDetails: !this.data.uiDetails });
  },
  onToggleActions() {
    if (!this.data.pending) return;
    this.setData({ uiActions: !this.data.uiActions });
  },
  onCloseActions() {
    this.setData({ uiActions: false });
  },
  onReceipt() {
    void this.controller?.recover();
  },
  onRetry() {
    this.onCloseActions();
    void this.controller?.recover(true);
  },
  onReedit() {
    this.controller?.reedit();
  },
  onDraftText(event: { detail: { value: string } }) {
    this.controller?.setDraftText(event.detail.value);
  },
  onSendDraft() {
    void this.controller?.sendDraft();
  },
  onDiscardDraft() {
    this.controller?.discardDraft();
  },
  onRequestCancel() {
    this.onCloseActions();
    this.controller?.requestCancel();
  },
  onConfirmCancel() {
    void this.controller?.confirmCancel();
  },
  onDismissCancel() {
    this.controller?.dismissCancel();
  },
  onCancel() {
    this.controller?.cancel();
  },
  onHide() {
    this.setData({ uiDetails: false, uiActions: false });
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.onHide();
  },
});
