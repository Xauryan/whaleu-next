import type { WhaleuApp } from '../../app';
import { DirectoryNavigator } from '../../directory/navigation';
import { messagingRuntime } from '../../messaging/entry';
import {
  initialListView,
  MessagingListController,
} from '../../messaging/list-controller';
import {
  initialNoticeSenders,
  NoticeSendersController,
  type NoticeSenderSnapshot,
} from '../../notifications/senders';
import { systemClock } from '../../platform/clock';
import {
  conversationRows,
  filterConversationRows,
  type InboxRow,
} from './presentation';
import { socialNoticeKind } from '../social-notices/contract';

Page({
  data: {
    list: initialListView(),
    rows: conversationRows(
      initialListView(),
      initialNoticeSenders(),
      systemClock.now(),
    ),
    searchOpen: false,
    searchQuery: '',
    filteredRows: [] as InboxRow[],
    chatHelpOpen: false,
    hasSession: false,
    noticesBusy: false,
    navigationError: '',
  },
  controller: undefined as MessagingListController | undefined,
  notices: undefined as NoticeSendersController | undefined,
  navigator: undefined as DirectoryNavigator | undefined,
  noticeSnapshots: initialNoticeSenders() as readonly NoticeSenderSnapshot[],
  generation: 0,
  unsubscribeSession: undefined as (() => void) | undefined,
  unsubscribeHide: undefined as (() => void) | undefined,
  async onShow() {
    this.onHide();
    const generation = this.generation;
    const pending: Promise<void>[] = [];
    const app = getApp<WhaleuApp>();
    const runtime = app.community;
    const messaging = messagingRuntime(runtime);
    const sessions = runtime?.sessions ?? messaging?.sessions;
    this.navigator = new DirectoryNavigator(wx, () => {
      if (this.generation === generation)
        this.setData({ navigationError: '暂时无法打开这条会话，请重试。' });
    });
    this.setData({ hasSession: !!sessions?.snapshot().credentials });
    if (sessions) {
      const owner = sessions.snapshot();
      this.unsubscribeSession = sessions.subscribe(() => {
        const current = sessions.snapshot();
        if (
          current.epoch !== owner.epoch ||
          current.credentials?.accountId !== owner.credentials?.accountId
        ) {
          this.onHide();
          this.setData({
            hasSession: !!current.credentials,
            navigationError: '登录状态已变化，请下拉刷新消息。',
          });
        }
      });
    }
    this.unsubscribeHide = runtime?.privateViews?.subscribe((accountId) => {
      if (accountId === undefined) this.onHide();
    });
    if (messaging) {
      this.controller = new MessagingListController(messaging, (list) => {
        if (this.generation !== generation) return;
        this.setData({
          list,
          hasSession: list.hasSession,
          ...this.rowProjection(
            conversationRows(list, this.noticeSnapshots, systemClock.now()),
          ),
        });
      });
      pending.push(this.controller.load());
    } else {
      this.setData({
        list: { ...initialListView(), error: '私信服务暂未连接' },
      });
    }
    if (runtime?.sessions) {
      this.notices = new NoticeSendersController(
        runtime,
        (snapshots) => {
          if (this.generation !== generation) return;
          this.noticeSnapshots = snapshots;
          this.setData({
            noticesBusy: snapshots.some((row) => row.busy),
            ...this.rowProjection(
              conversationRows(this.data.list, snapshots, systemClock.now()),
            ),
          });
        },
        app.identity?.api,
      );
      pending.push(this.notices.load());
    }
    await Promise.all(pending);
  },
  rowProjection(rows: InboxRow[]) {
    return {
      rows,
      filteredRows: filterConversationRows(rows, this.data.searchQuery),
    };
  },
  onSearch() {
    const searchOpen = !this.data.searchOpen;
    this.setData({
      searchOpen,
      searchQuery: '',
      filteredRows: this.data.rows,
      chatHelpOpen: false,
    });
  },
  onSearchInput(event: { detail: { value: string } }) {
    const searchQuery =
      typeof event.detail.value === 'string'
        ? event.detail.value.slice(0, 120)
        : '';
    this.setData({
      searchQuery,
      filteredRows: filterConversationRows(this.data.rows, searchQuery),
    });
  },
  onChatHelp() {
    this.setData({ chatHelpOpen: true });
  },
  onDismissChatHelp() {
    this.setData({ chatHelpOpen: false });
  },
  onSheetContent() {},
  onConversation(event: { currentTarget: { dataset: { key: string } } }) {
    const row = (
      this.data.searchOpen ? this.data.filteredRows : this.data.rows
    ).find((item) => item.key === event.currentTarget.dataset.key);
    if (
      !row ||
      (row.kind === 'person' && (this.data.list.busy || !this.data.list.loaded))
    )
      return;
    this.navigator?.open(row.url);
  },
  onSocial(event: { currentTarget: { dataset: { kind?: string } } }) {
    const kind = socialNoticeKind({ kind: event.currentTarget.dataset.kind });
    if (kind)
      this.navigator?.open(`/pages/social-notices/social-notices?kind=${kind}`);
  },
  async onPullDownRefresh() {
    try {
      if (!this.controller || !this.notices) await this.onShow();
      else await Promise.all([this.controller?.load(), this.notices?.load()]);
    } finally {
      wx.stopPullDownRefresh?.();
    }
  },
  onReload() {
    if (!this.controller || !this.notices) void this.onShow();
    else {
      void this.controller?.load();
      void this.notices?.load();
    }
  },
  onMore() {
    void this.controller?.more();
  },
  onCancel() {
    this.controller?.cancel();
    this.notices?.dispose();
    this.notices = undefined;
    this.noticeSnapshots = initialNoticeSenders();
    this.setData({
      noticesBusy: false,
      ...this.rowProjection(
        conversationRows(
          this.data.list,
          this.noticeSnapshots,
          systemClock.now(),
        ),
      ),
    });
  },
  onHide() {
    this.generation++;
    this.unsubscribeSession?.();
    this.unsubscribeSession = undefined;
    this.unsubscribeHide?.();
    this.unsubscribeHide = undefined;
    this.controller?.dispose();
    this.controller = undefined;
    this.notices?.dispose();
    this.notices = undefined;
    this.navigator?.dispose();
    this.navigator = undefined;
    this.noticeSnapshots = initialNoticeSenders();
    this.setData({
      list: initialListView(),
      rows: conversationRows(
        initialListView(),
        this.noticeSnapshots,
        systemClock.now(),
      ),
      hasSession: false,
      noticesBusy: false,
      navigationError: '',
      searchOpen: false,
      searchQuery: '',
      filteredRows: [],
      chatHelpOpen: false,
    });
  },
  onUnload() {
    this.onHide();
  },
});
