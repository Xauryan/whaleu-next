import type { WhaleuApp } from '../../app';
import {
  decodeHotIntent,
  hotRanges,
  type HotIntent,
} from '../../community/hot-contract';
import { tradingLabels } from '../../community/trading-contract';
import { ViewObserver } from '../../community/view-observer';
import { PUBLIC_EXPERIENCE_COLOR_STYLES } from '../../experience/public-display';
import { systemClock } from '../../platform/clock';
import { AuthorNavigator } from '../../profile/author-navigation';
import { HotController, initialHotView } from './controller';

Page({
  data: {
    ...initialHotView(),
    hotRanges,
    tradingLabels,
    experienceColorStyles: PUBLIC_EXPERIENCE_COLOR_STYLES,
  },
  route: null as HotIntent | null,
  resume: null as HotIntent | null,
  controller: undefined as HotController | undefined,
  authorNavigator: undefined as AuthorNavigator | undefined,
  viewObserver: undefined as ViewObserver | undefined,
  unsubscribeSession: undefined as (() => void) | undefined,
  unsubscribeHide: undefined as (() => void) | undefined,
  onLoad(query: unknown = {}) {
    try {
      this.route = decodeHotIntent(query);
    } catch {
      this.route = null;
    }
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) return;
    let owner = runtime.sessions.snapshot();
    // Keep listening while hidden, so a same-account login cannot revive old intent/cards.
    this.unsubscribeSession = runtime.sessions.subscribe(() => {
      const current = runtime.sessions.snapshot();
      if (
        current.epoch !== owner.epoch ||
        current.credentials?.accountId !== owner.credentials?.accountId
      ) {
        owner = current;
        this.resume = null;
        this.viewObserver?.dispose();
        this.viewObserver = undefined;
        this.setData({
          ...initialHotView(),
          hasSession: !!current.credentials,
        });
      }
    });
    this.unsubscribeHide = runtime.privateViews?.subscribe((accountId) => {
      if (accountId !== undefined) return;
      // Root hide can precede page hide. Preserve only the public selection.
      this.resume = this.controller?.snapshot() ?? this.resume;
      this.viewObserver?.dispose();
      this.viewObserver = undefined;
    });
  },
  onShow() {
    const selected = this.controller?.snapshot() ?? this.resume ?? this.route;
    this.viewObserver?.dispose();
    this.viewObserver = undefined;
    this.controller?.dispose();
    this.controller = undefined;
    this.authorNavigator?.dispose();
    this.authorNavigator = undefined;
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({
        ...initialHotView(),
        error: '环境未初始化，请重新打开小程序',
      });
      return;
    }
    this.resume = null;
    if (runtime.views)
      this.viewObserver = new ViewObserver(
        wx,
        this,
        systemClock,
        runtime.views,
        'list_exposure',
      );
    this.authorNavigator = new AuthorNavigator(
      wx,
      () => this.setData({ error: '暂不能打开主页，请重试' }),
      runtime,
    );
    this.controller = new HotController(runtime, (view) => {
      const presented = this.viewObserver?.render(
        view.loaded && view.hasSession && !view.busy
          ? view.posts.map((post) => post.id)
          : [],
        `${view.selectedSpaceId}:${view.range}`,
      );
      this.setData({ ...view }, presented);
    });
    void this.controller.load(selected);
  },
  onRange(event: { currentTarget: { dataset: { key: string } } }) {
    void this.controller?.setRange(event.currentTarget.dataset.key);
  },
  onRefresh() {
    // A session boundary cleared the controller and its observer owner. Recreate both.
    if (!this.controller?.snapshot()) this.onShow();
    else void this.controller.refresh();
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
      this.data.posts.find((post) => post.id === event.currentTarget.dataset.id)
        ?.author,
    );
  },
  onHide() {
    this.resume = this.controller?.snapshot() ?? this.resume;
    this.viewObserver?.dispose();
    this.viewObserver = undefined;
    this.controller?.dispose();
    this.controller = undefined;
    this.authorNavigator?.dispose();
    this.authorNavigator = undefined;
  },
  onUnload() {
    this.viewObserver?.dispose();
    this.viewObserver = undefined;
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
