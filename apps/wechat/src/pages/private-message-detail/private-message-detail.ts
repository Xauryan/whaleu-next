import type { WxIntersectionObserver } from '../../platform/wechat';
import type { WhaleuApp } from '../../app';
import { privateMessageRows } from './presentation';
import { messagingRuntime, readDetailRoute } from '../../messaging/entry';
import {
  MessagingDetailController,
  initialDetailView,
  type DetailRoute,
} from '../../messaging/detail-controller';
Page({
  data: {
    ...initialDetailView(),
    uiPanel: '',
    uiMessageMenu: '',
    uiKeyboardHeight: 0,
    uiMessages: privateMessageRows([]),
  },
  controller: undefined as MessagingDetailController | undefined,
  route: null as DetailRoute | null,
  visibilityObserver: undefined as WxIntersectionObserver | undefined,
  observeGeneration: 0,
  pageVisible: false,
  onLoad(query: Record<string, string | undefined> = {}) {
    this.route = readDetailRoute(query);
  },
  onShow() {
    this.pageVisible = true;
    this.pauseObservation();
    if (this.controller?.keepPicker) {
      this.controller.resumePicker();
      return;
    }
    this.controller?.dispose();
    this.closeMenus(false);
    this.setData({ uiKeyboardHeight: 0 });
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
        const generation = this.pauseObservation();
        this.setData(
          {
            ...view,
            uiMessages: privateMessageRows(view.messages),
            uiPanel: view.conversation && view.loaded ? this.data.uiPanel : '',
            uiMessageMenu: view.messages.some(
              (message) => message.id === this.data.uiMessageMenu,
            )
              ? this.data.uiMessageMenu
              : '',
            uiKeyboardHeight: view.conversation
              ? this.data.uiKeyboardHeight
              : 0,
          },
          () => {
            done?.();
            if (generation === this.observeGeneration) this.observeLatest();
          },
        );
      },
    );
    void this.controller.load();
  },
  pauseObservation() {
    this.observeGeneration++;
    this.visibilityObserver?.disconnect();
    this.visibilityObserver = undefined;
    return this.observeGeneration;
  },
  canObserveMessages() {
    return (
      this.pageVisible &&
      this.data.loaded &&
      !!this.data.conversation &&
      !this.controller?.keepPicker &&
      !this.data.uiPanel &&
      !this.data.uiMessageMenu &&
      !this.data.confirm
    );
  },
  observeLatest() {
    const generation = this.pauseObservation();
    if (!this.canObserveMessages()) return;
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
          this.canObserveMessages() &&
          result.intersectionRatio >= 0.5
        )
          controller.observeMessage(message.id);
      });
    } catch {
      this.visibilityObserver?.disconnect();
      this.visibilityObserver = undefined;
    }
  },
  onTogglePanel(event: { currentTarget: { dataset: { panel: string } } }) {
    const panel = event.currentTarget.dataset.panel;
    if (!this.data.loaded || !this.data.conversation) return;
    if (panel !== 'conversation' && panel !== 'media') return;
    if (
      panel === 'media' &&
      (this.data.busy || this.data.pending || !this.data.canSend)
    )
      return;
    this.renderMenus({
      uiPanel: this.data.uiPanel === panel ? '' : panel,
      uiMessageMenu: '',
    });
  },
  onMessageMenu(event: { currentTarget: { dataset: { id: string } } }) {
    const id = event.currentTarget.dataset.id;
    if (!this.data.messages.some((message) => message.id === id)) return;
    this.renderMenus({
      uiMessageMenu: this.data.uiMessageMenu === id ? '' : id,
      uiPanel: '',
    });
  },
  renderMenus(
    patch: { uiPanel: string; uiMessageMenu: string },
    resume = true,
  ) {
    const generation = this.pauseObservation();
    this.setData(patch, () => {
      if (resume && generation === this.observeGeneration) this.observeLatest();
    });
  },
  closeMenus(resume = true) {
    this.renderMenus({ uiPanel: '', uiMessageMenu: '' }, resume);
  },
  onCloseMenus() {
    this.closeMenus();
  },
  onKeyboardHeight(event: { detail: { height: number } }) {
    if (!this.data.loaded || !this.data.conversation) {
      this.setData({ uiKeyboardHeight: 0 });
      return;
    }
    const height = Number(event.detail.height);
    this.setData({
      uiKeyboardHeight: Number.isFinite(height) && height > 0 ? height : 0,
    });
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
  onImageAlbum() {
    this.closeMenus(false);
    void this.controller?.pickImage('album');
  },
  onImageCamera() {
    this.closeMenus(false);
    void this.controller?.pickImage('camera');
  },
  onShowImage(event: { currentTarget: { dataset: { id: string } } }) {
    void this.controller?.showImage(event.currentTarget.dataset.id);
  },
  onSend() {
    this.onCloseMenus();
    void this.controller?.send();
  },
  onCancel() {
    this.controller?.cancel();
  },
  onAction(event: {
    currentTarget: { dataset: { kind: string; id?: string } };
  }) {
    this.closeMenus(false);
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
    this.onCloseMenus();
    const data = this.controller?.copyText(event.currentTarget.dataset.id);
    if (data !== null && data !== undefined)
      wx.setClipboardData?.({
        data,
        success: () => undefined,
        fail: () => this.setData({ error: '复制失败，请重试' }),
      });
  },
  onProfile() {
    this.onCloseMenus();
    const url = this.controller?.profilePath();
    if (url)
      wx.navigateTo?.({
        url,
        success: () => undefined,
        fail: () => this.setData({ error: '暂不能打开，请重试' }),
      });
  },
  onSource() {
    this.onCloseMenus();
    const url = this.controller?.sourcePath();
    if (url)
      wx.navigateTo?.({
        url,
        success: () => undefined,
        fail: () => this.setData({ error: '暂不能打开，请重试' }),
      });
  },
  onHide() {
    this.pageVisible = false;
    this.closeMenus(false);
    this.setData({ uiKeyboardHeight: 0 });
    if (this.controller?.keepPicker) {
      this.controller.hide();
      return;
    }
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.pageVisible = false;
    this.pauseObservation();
    this.controller?.dispose();
    this.controller = undefined;
    this.onHide();
  },
});
