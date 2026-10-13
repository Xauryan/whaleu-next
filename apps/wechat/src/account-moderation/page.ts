import type { WhaleuApp } from '../app';
import {
  ModerationController,
  initialModerationView,
  type Mode,
} from './controller';
import type { Decision } from './contract';
interface Owner {
  controller: ModerationController | undefined;
  navigation: { punishmentId?: string; appealId?: string };
  setData(patch: Record<string, unknown>): void;
  onHide(): void;
}
export function moderationPage(mode: Mode) {
  return {
    data: { ...initialModerationView(mode) },
    navigation: {} as { punishmentId?: string; appealId?: string },
    controller: undefined as ModerationController | undefined,
    onLoad(
      this: Owner,
      query: { punishmentId?: string; appealId?: string } = {},
    ) {
      this.navigation = { ...query };
    },
    onShow(this: Owner) {
      this.onHide();
      const runtime = getApp<WhaleuApp>().community;
      if (!runtime) {
        this.setData({ error: '环境尚未初始化' });
        return;
      }
      this.controller = new ModerationController(
        runtime,
        (view) => this.setData({ ...view }),
        mode,
      );
      void this.controller.load(this.navigation);
    },
    onReload(this: Owner) {
      void this.controller?.load();
    },
    onMore(this: Owner) {
      void this.controller?.more();
    },
    onHistory(this: Owner) {
      void this.controller?.history();
    },
    onMoreHistory(this: Owner) {
      void this.controller?.history(true);
    },
    onSelectPunishment(
      this: Owner,
      event: { currentTarget: { dataset: { id: string } } },
    ) {
      this.controller?.selectPunishment(event.currentTarget.dataset.id);
    },
    onSelectAppeal(
      this: Owner,
      event: { currentTarget: { dataset: { id: string } } },
    ) {
      this.controller?.selectAppeal(event.currentTarget.dataset.id);
    },
    onText(this: Owner, event: { detail: { value: string } }) {
      this.controller?.setText(event.detail.value);
    },
    onReason(this: Owner, event: { detail: { value: string } }) {
      this.controller?.setReason(event.detail.value);
    },
    onRequestAppeal(this: Owner) {
      this.controller?.request('submit_appeal');
    },
    onRequestRelease(this: Owner) {
      this.controller?.request('release');
    },
    onRequestDecision(
      this: Owner,
      event: { currentTarget: { dataset: { decision: Decision } } },
    ) {
      this.controller?.request(
        'decide_appeal',
        event.currentTarget.dataset.decision,
      );
    },
    onSubmit(this: Owner) {
      void this.controller?.submit();
    },
    onClose(this: Owner) {
      this.controller?.closeConfirmation();
    },
    onRecover(this: Owner) {
      void this.controller?.recover();
    },
    onRetry(this: Owner) {
      void this.controller?.recover(true);
    },
    onCancelRequest(this: Owner) {
      this.controller?.requestCancellation();
    },
    onConfirmCancel(this: Owner) {
      void this.controller?.confirmCancellation();
    },
    onStopWaiting(this: Owner) {
      this.controller?.cancel();
    },
    onHide(this: Owner) {
      this.controller?.dispose();
      this.controller = undefined;
    },
    onUnload(this: Owner) {
      this.onHide();
    },
  };
}
