import type { WhaleuApp } from '../../app';
import { tradingCategories } from '../../community/trading-contract';
import {
  SearchController,
  decodeSearchRoute,
  initialSearchView,
  type SearchResume,
  type SearchRoute,
} from './controller';

Page({
  data: {
    ...initialSearchView(),
    tradingCategories,
    searchTypes: [
      { key: 'all', label: '全部内容' },
      { key: 'post', label: '帖子' },
      { key: 'comment', label: '评论' },
      { key: 'reply', label: '回复' },
    ],
    categoryLabels: {
      discussion: '校园日常',
      confession: '表白心事',
      companions: '找搭子',
      pets: '校园萌宠',
      internships: '实习工作',
      scenery: '校园风景',
      dorms: '宿舍生活',
      research: '学术科研',
      deep_sea: '深海树洞',
      trading: '校园交易',
    },
    categories: [
      { key: 'all', label: '全部分类' },
      { key: 'discussion', label: '校园日常' },
      { key: 'confession', label: '表白心事' },
      { key: 'companions', label: '找搭子' },
      { key: 'pets', label: '校园萌宠' },
      { key: 'internships', label: '实习工作' },
      { key: 'scenery', label: '校园风景' },
      { key: 'dorms', label: '宿舍生活' },
      { key: 'research', label: '学术科研' },
      { key: 'deep_sea', label: '深海树洞' },
      { key: 'trading', label: '校园交易' },
    ],
  },
  route: null as SearchRoute | null,
  resume: null as SearchResume | null,
  controller: undefined as SearchController | undefined,
  unsubscribeSession: undefined as (() => void) | undefined,
  unsubscribeHide: undefined as (() => void) | undefined,
  onLoad(query: unknown = {}) {
    try {
      this.route = decodeSearchRoute(query);
    } catch {
      this.route = null;
    }
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) return;
    let owner = runtime.sessions.snapshot();
    // This listener lives until unload, including while the read controller is disposed/hidden.
    this.unsubscribeSession = runtime.sessions.subscribe(() => {
      const current = runtime.sessions.snapshot();
      if (
        current.epoch !== owner.epoch ||
        current.credentials?.accountId !== owner.credentials?.accountId
      ) {
        owner = current;
        this.resume = null;
        this.setData({
          ...initialSearchView(),
          hasSession: !!current.credentials,
        });
      }
    });
    // Capture only a same-session query/scope before the base root-hide clears every DTO/cursor.
    this.unsubscribeHide = runtime.privateViews?.subscribe((accountId) => {
      if (accountId === undefined)
        this.resume = this.controller?.snapshot() ?? this.resume;
    });
  },
  onShow() {
    const resume = this.controller?.snapshot() ?? this.resume;
    this.controller?.dispose();
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({ error: '环境未初始化，请重新打开小程序' });
      return;
    }
    this.resume = null;
    this.controller = new SearchController(runtime, (view) =>
      this.setData({ ...view }),
    );
    void this.controller.load(resume?.route ?? this.route, resume ?? undefined);
  },
  onMode(event: { currentTarget: { dataset: { mode: string } } }) {
    void this.controller?.setMode(event.currentTarget.dataset.mode);
  },
  onInput(event: { detail: { value: string } }) {
    this.controller?.setInput(event.detail.value);
  },
  onSubmit() {
    void this.controller?.submit();
  },
  onAggregateScope(event: { currentTarget: { dataset: { scope: string } } }) {
    void this.controller?.chooseScope(event.currentTarget.dataset.scope);
  },
  onScope(event: { currentTarget: { dataset: { id: string } } }) {
    void this.controller?.chooseSpace(event.currentTarget.dataset.id);
  },
  onCategory(event: { currentTarget: { dataset: { key: string } } }) {
    void this.controller?.setCategory(event.currentTarget.dataset.key);
  },
  onTradingSubtype(event: { currentTarget: { dataset: { key: string } } }) {
    void this.controller?.setTradingSubtype(event.currentTarget.dataset.key);
  },
  onRefresh() {
    void this.controller?.refresh();
  },
  onNext() {
    void this.controller?.next();
  },
  onPrevious() {
    void this.controller?.previous();
  },
  onCancel() {
    this.controller?.cancel();
  },
  onType(event: { currentTarget: { dataset: { key: string } } }) {
    void this.controller?.setType(event.currentTarget.dataset.key);
  },
  onFromDate(event: { detail: { value: string } }) {
    void this.controller?.setDate('from', event.detail.value);
  },
  onToDate(event: { detail: { value: string } }) {
    void this.controller?.setDate('to', event.detail.value);
  },
  onClearDates() {
    void this.controller?.clearDates();
  },
  onWithinPost(event: { currentTarget: { dataset: { postId: string } } }) {
    void this.controller?.withinPost(event.currentTarget.dataset.postId);
  },
  onClearPost() {
    void this.controller?.clearPost();
  },
  onHit(event: { currentTarget: { dataset: { kind: string; id: string } } }) {
    const { kind, id } = event.currentTarget.dataset;
    void this.controller?.openHit(
      kind,
      id,
      (url) =>
        new Promise<void>((resolve, reject) => {
          if (!wx.navigateTo) {
            reject(new Error('Navigation unavailable'));
            return;
          }
          wx.navigateTo({ url, success: () => resolve(), fail: reject });
        }),
    );
  },
  onHide() {
    this.resume = this.controller?.snapshot() ?? this.resume;
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.controller?.dispose();
    this.controller = undefined;
    this.unsubscribeSession?.();
    this.unsubscribeSession = undefined;
    this.unsubscribeHide?.();
    this.unsubscribeHide = undefined;
    this.resume = null;
    this.route = null;
  },
});
