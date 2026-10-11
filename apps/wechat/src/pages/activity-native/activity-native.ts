import type { WhaleuApp } from '../../app';
import { Cancellation } from '../../platform/contracts';
import { HttpActivityPublicationGateway } from '../../activities/publication/gateway';
import type { NativeActivity } from '../../activities/publication/contract';
Page({
  data: {
    items: [] as NativeActivity[],
    loaded: false,
    busy: false,
    error: '',
    more: false,
    mine: false,
  },
  gateway: undefined as HttpActivityPublicationGateway | undefined,
  cancel: undefined as Cancellation | undefined,
  cursor: null as string | null,
  generation: 0,
  invalid: false,
  stop: undefined as (() => void) | undefined,
  scopeStop: undefined as (() => void) | undefined,
  onLoad(query: Record<string, string> = {}) {
    this.invalid =
      Object.keys(query).some((k) => k !== 'mode') ||
      (query.mode !== undefined && query.mode !== 'mine');
    this.setData({ mine: query.mode === 'mine' });
  },
  onShow() {
    this.clear();
    if (this.invalid) {
      this.setData({ error: '活动目录入口无效' });
      return;
    }
    const app = getApp<WhaleuApp>();
    if (!app.identity?.api) {
      this.setData({ error: '环境未配置' });
      return;
    }
    this.gateway = new HttpActivityPublicationGateway(app.identity.api);
    this.cancel = new Cancellation();
    const epoch = app.identity.sessions.snapshot().epoch;
    this.stop = app.identity.sessions.subscribe(() => {
      if (app.identity?.sessions.snapshot().epoch !== epoch) this.clear();
    });
    this.scopeStop = app.community?.directoryScopeChanges?.subscribe(() =>
      this.clear(),
    );
    void this.load(false);
  },
  async load(more: boolean) {
    if (
      this.data.busy ||
      !this.gateway ||
      !this.cancel ||
      (more && !this.cursor)
    )
      return;
    const generation = this.generation,
      cancel = this.cancel;
    this.setData({ busy: true, error: '' });
    try {
      const page = await this.gateway.list(
        this.data.mine,
        cancel,
        more ? this.cursor! : undefined,
      );
      if (generation !== this.generation || cancel.isCancelled) return;
      this.cursor = page.nextCursor;
      this.setData({
        items: more ? [...this.data.items, ...page.items] : page.items,
        more: !!page.nextCursor,
        loaded: true,
      });
    } catch {
      if (generation === this.generation)
        this.setData({ error: '活动目录暂不可用，请刷新重试' });
    } finally {
      if (generation === this.generation) this.setData({ busy: false });
    }
  },
  onMore() {
    void this.load(true);
  },
  onRefresh() {
    this.cursor = null;
    void this.load(false);
  },
  onDetail(e: { currentTarget: { dataset: { id: string } } }) {
    if (this.data.items.some((i) => i.id === e.currentTarget.dataset.id))
      wx.navigateTo?.({
        success: () => undefined,
        fail: () => this.setData({ error: '无法打开活动页面，请重试' }),
        url: `/pages/activity-native-detail/activity-native-detail?id=${e.currentTarget.dataset.id}`,
      });
  },
  onPublish() {
    wx.navigateTo?.({
      success: () => undefined,
      fail: () => this.setData({ error: '无法打开活动页面，请重试' }),
      url: '/pages/activity-publish/activity-publish',
    });
  },
  onLegacy() {
    wx.navigateTo?.({
      success: () => undefined,
      fail: () => this.setData({ error: '无法打开活动页面，请重试' }),
      url: '/pages/activity-list/activity-list',
    });
  },
  onMine() {
    wx.navigateTo?.({
      success: () => undefined,
      fail: () => this.setData({ error: '无法打开活动页面，请重试' }),
      url: '/pages/activity-native/activity-native?mode=mine',
    });
  },
  clear() {
    this.generation++;
    this.stop?.();
    this.scopeStop?.();
    this.stop = undefined;
    this.scopeStop = undefined;
    this.cancel?.cancel();
    this.cancel = undefined;
    this.gateway = undefined;
    this.cursor = null;
    this.setData({
      items: [],
      loaded: false,
      busy: false,
      error: '',
      more: false,
    });
  },
  onHide() {
    this.clear();
  },
  onUnload() {
    this.clear();
  },
});
