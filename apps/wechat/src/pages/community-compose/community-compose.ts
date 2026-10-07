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
  copySource: null as { kind: 'comment' | 'reply'; id: string } | null,
  onLoad(
    query: {
      spaceId?: string;
      category?: string;
      postId?: string;
      rootCommentId?: string;
      targetReplyId?: string;
      copyCommentId?: string;
      copyReplyId?: string;
    } = {},
  ) {
    this.copySource = isUuid(query.copyReplyId)
      ? { kind: 'reply', id: query.copyReplyId }
      : isUuid(query.copyCommentId)
        ? { kind: 'comment', id: query.copyCommentId }
        : null;
    if (
      (query.copyReplyId !== undefined && !isUuid(query.copyReplyId)) ||
      (query.copyCommentId !== undefined && !isUuid(query.copyCommentId)) ||
      (query.copyReplyId !== undefined && query.copyCommentId !== undefined)
    ) {
      this.target = null;
      this.copySource = null;
      return;
    }
    if (
      query.rootCommentId !== undefined ||
      query.targetReplyId !== undefined
    ) {
      this.target =
        isUuid(query.postId) &&
        isUuid(query.rootCommentId) &&
        (query.targetReplyId === undefined || isUuid(query.targetReplyId))
          ? {
              operation: 'publish_reply',
              postId: query.postId,
              rootCommentId: query.rootCommentId,
              targetReplyId: query.targetReplyId ?? null,
            }
          : null;
      return;
    }
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
    this.controller = new ComposeController(
      runtime,
      this.target,
      (view) => this.setData({ ...view }),
      undefined,
      this.copySource,
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
