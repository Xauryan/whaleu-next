import type { WhaleuApp } from '../../app';
import { messagingRuntime } from '../../messaging/entry';
import {
  MessagingRecoveryController,
  initialRecoveryView,
} from '../../messaging/recovery-controller';
Page({
  data: { ...initialRecoveryView() },
  controller: undefined as MessagingRecoveryController | undefined,
  onShow() {
    this.controller?.dispose();
    const runtime = messagingRuntime(getApp<WhaleuApp>().community);
    if (!runtime) {
      this.setData({ error: '私信环境尚未初始化' });
      return;
    }
    this.controller = new MessagingRecoveryController(runtime, (view, done) =>
      this.setData({ ...view }, done),
    );
    this.controller.load();
  },
  onReceipt() {
    void this.controller?.recover();
  },
  onRetry() {
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
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.onHide();
  },
});
