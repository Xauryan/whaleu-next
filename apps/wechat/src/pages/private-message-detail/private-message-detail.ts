import type { WxIntersectionObserver } from '../../platform/wechat';
import type { WhaleuApp } from '../../app';
import { messagingRuntime, readDetailRoute } from '../../messaging/entry';
import {
  MessagingDetailController,
  initialDetailView,
  type DetailRoute,
} from '../../messaging/detail-controller';
Page({
  data: { ...initialDetailView() },
  controller: undefined as MessagingDetailController | undefined,
  route: null as DetailRoute | null,
  visibilityObserver: undefined as WxIntersectionObserver | undefined,
  observeGeneration: 0,
  onLoad(query: Record<string, string | undefined> = {}) {
    this.route = readDetailRoute(query);
  },
  onShow() {
    this.controller?.dispose();
    const runtime = messagingRuntime(getApp<WhaleuApp>().community);
    if (!runtime || !this.route) {
      this.setData({ error: '私信地址无效或环境尚未初始化' });
      return;
    }
    this.controller = new MessagingDetailController(
      runtime,
      this.route,
      (view, done) => {
        if (view.confirmedConversationId)
          this.route = { conversationId: view.confirmedConversationId };
        else if (view.conversation)
          this.route = { conversationId: view.conversation.id };
        this.setData({ ...view }, () => {
          done?.();
          this.observeLatest();
        });
      },
    );
    void this.controller.load();
  },
  observeLatest() {
    this.visibilityObserver?.disconnect();
    this.visibilityObserver = undefined;
    const generation = ++this.observeGeneration;
    const message = this.data.messages[this.data.messages.length - 1],
      controller = this.controller;
    if (!message || !controller || !wx.createIntersectionObserver) return;
    try {
      const observer = wx
        .createIntersectionObserver(this, {
          thresholds: [0, 0.5, 1],
          initialRatio: 0,
        })
        .relativeToViewport();
      this.visibilityObserver = observer;
      observer.observe(`#message-${message.id}`, (result) => {
        if (
          generation === this.observeGeneration &&
          controller === this.controller &&
          result.intersectionRatio >= 0.5
        )
          controller.observeMessage(message.id);
      });
    } catch {
      this.visibilityObserver?.disconnect();
      this.visibilityObserver = undefined;
    }
  },
  onOpen() {
    void this.controller?.open();
  },
  onReload() {
    void this.controller?.latest();
  },
  onMore() {
    void this.controller?.more();
  },
  onLatest() {
    void this.controller?.latest();
  },
  onText(event: { detail: { value: string } }) {
    this.controller?.setText(event.detail.value);
  },
  onSend() {
    void this.controller?.send();
  },
  onCancel() {
    this.controller?.cancel();
  },
  onAction(event: {
    currentTarget: { dataset: { kind: string; id?: string } };
  }) {
    const { kind, id } = event.currentTarget.dataset;
    if (
      kind === 'hide' ||
      kind === 'reopen' ||
      kind === 'block' ||
      kind === 'recall'
    )
      this.controller?.request(kind, id);
  },
  onConfirm() {
    void this.controller?.confirm();
  },
  onDismiss() {
    this.controller?.dismiss();
  },
  onReedit() {
    this.controller?.reedit();
  },
  onCopy(event: { currentTarget: { dataset: { id: string } } }) {
    const data = this.controller?.copyText(event.currentTarget.dataset.id);
    if (data !== null && data !== undefined)
      wx.setClipboardData?.({
        data,
        success: () => undefined,
        fail: () => this.setData({ error: '复制失败，请重试' }),
      });
  },
  onProfile() {
    const url = this.controller?.profilePath();
    if (url)
      wx.navigateTo?.({
        url,
        success: () => undefined,
        fail: () => this.setData({ error: '暂不能打开，请重试' }),
      });
  },
  onSource() {
    const url = this.controller?.sourcePath();
    if (url)
      wx.navigateTo?.({
        url,
        success: () => undefined,
        fail: () => this.setData({ error: '暂不能打开，请重试' }),
      });
  },
  onHide() {
    this.observeGeneration++;
    this.visibilityObserver?.disconnect();
    this.visibilityObserver = undefined;
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.onHide();
  },
});
