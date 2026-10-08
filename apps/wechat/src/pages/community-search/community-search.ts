import type { WhaleuApp } from '../../app';
import {
  tradingCategories,
  tradingLabels,
} from '../../community/trading-contract';
import { PUBLIC_EXPERIENCE_COLOR_STYLES } from '../../experience/public-display';
import { AuthorNavigator } from '../../profile/author-navigation';
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
    experienceColorStyles: PUBLIC_EXPERIENCE_COLOR_STYLES,
    tradingCategories,
    tradingLabels,
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
  authorNavigator: undefined as AuthorNavigator | undefined,
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
    this.authorNavigator?.dispose();
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({ error: '环境未初始化，请重新打开小程序' });
      return;
    }
    this.resume = null;
    this.authorNavigator = new AuthorNavigator(
      wx,
      () => this.setData({ error: '暂不能打开主页，请重试' }),
      runtime,
    );
    this.controller = new SearchController(runtime, (view) =>
      this.setData({ ...view }),
    );
    void this.controller.load(resume?.route ?? this.route, resume ?? undefined);
  },
  onInput(event: { detail: { value: string } }) {
    this.controller?.setInput(event.detail.value);
  },
  onSubmit() {
    void this.controller?.submit();
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
  onAuthor(event: { currentTarget: { dataset: { id: string } } }) {
    if (!this.data.loaded || this.data.busy) return;
    this.authorNavigator?.open(
      this.data.posts.find((item) => item.id === event.currentTarget.dataset.id)
        ?.author,
    );
  },
  onHide() {
    this.resume = this.controller?.snapshot() ?? this.resume;
    this.controller?.dispose();
    this.controller = undefined;
    this.authorNavigator?.dispose();
    this.authorNavigator = undefined;
  },
  onUnload() {
    this.controller?.dispose();
    this.controller = undefined;
    this.authorNavigator?.dispose();
    this.authorNavigator = undefined;
    this.unsubscribeSession?.();
    this.unsubscribeSession = undefined;
    this.unsubscribeHide?.();
    this.unsubscribeHide = undefined;
    this.resume = null;
    this.route = null;
  },
});
