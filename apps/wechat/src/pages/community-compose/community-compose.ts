import type { WhaleuApp } from '../../app';
import { isCategory } from '../../community/contract';
import { isUuid } from '../../profile/contract';
import {
  ComposeController,
  initialComposeView,
  type ComposeTarget,
} from './controller';
Page({
  data: { ...initialComposeView() },
  controller: undefined as ComposeController | undefined,
  target: null as ComposeTarget | null,
  onLoad(query: { spaceId?: string; category?: string; postId?: string } = {}) {
    this.target = isUuid(query.postId)
      ? { operation: 'publish_comment', postId: query.postId }
      : isUuid(query.spaceId) && isCategory(query.category)
        ? {
            operation: 'publish_post',
            spaceId: query.spaceId,
            category: query.category,
          }
        : null;
  },
  onShow() {
    this.controller?.dispose();
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({ error: '环境未初始化，请重新打开小程序' });
      return;
    }
    this.controller = new ComposeController(runtime, this.target, (view) =>
      this.setData({ ...view }),
    );
    void this.controller.load();
  },
  onText(event: { detail: { value: string } }) {
    this.controller?.setText(event.detail.value);
  },
  onMode(event: { currentTarget: { dataset: { mode: string } } }) {
    this.controller?.setAuthorMode(event.currentTarget.dataset.mode);
  },
  onRestricted(event: { detail: { value: boolean } }) {
    this.controller?.setRestricted(event.detail.value);
  },
  onPollEnabled(event: { detail: { value: boolean } }) {
    this.controller?.setPollEnabled(event.detail.value);
  },
  onPollQuestion(event: { detail: { value: string } }) {
    this.controller?.setPollQuestion(event.detail.value);
  },
  onPollMode(event: { currentTarget: { dataset: { mode: string } } }) {
    this.controller?.setPollMode(event.currentTarget.dataset.mode);
  },
  onPollOption(event: {
    detail: { value: string };
    currentTarget: { dataset: { index: number } };
  }) {
    this.controller?.setPollOption(
      Number(event.currentTarget.dataset.index),
      event.detail.value,
    );
  },
  onAddPollOption() {
    this.controller?.addPollOption();
  },
  onRemovePollOption(event: { currentTarget: { dataset: { index: number } } }) {
    this.controller?.removePollOption(
      Number(event.currentTarget.dataset.index),
    );
  },
  onPollFinal(event: { detail: { value: boolean } }) {
    this.controller?.setPollFinal(event.detail.value);
  },
  onSubmit() {
    void this.controller?.submit();
  },
  onReceipt() {
    void this.controller?.recover();
  },
  onRetry() {
    void this.controller?.recover(true);
  },
  onReload() {
    void this.controller?.load();
  },
  onCancel() {
    this.controller?.cancel();
  },
  onHide() {
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.controller?.dispose();
    this.controller = undefined;
  },
});
