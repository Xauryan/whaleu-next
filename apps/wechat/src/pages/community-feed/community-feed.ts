import {
  IdentityOverlayController,
  initialOverlayView,
} from '../../identity-privacy/overlay';
import { systemClock } from '../../platform/clock';
import type { WhaleuApp } from '../../app';
import { FeedController, initialFeedView } from './controller';
Page({
  data: {
    ...initialFeedView(),
    identityOverlay: initialOverlayView(),
    categories: [
      { key: 'discussion', label: '校园日常' },
      { key: 'confession', label: '表白心事' },
      { key: 'companions', label: '找搭子' },
      { key: 'pets', label: '校园萌宠' },
      { key: 'internships', label: '实习工作' },
      { key: 'scenery', label: '校园风景' },
      { key: 'dorms', label: '宿舍生活' },
      { key: 'research', label: '学术科研' },
      { key: 'deep_sea', label: '深海树洞' },
    ],
  },
  controller: undefined as FeedController | undefined,
  identityOverlay: undefined as IdentityOverlayController | undefined,
  overlayTargets: '',
  onShow() {
    this.controller?.dispose();
    this.identityOverlay?.dispose();
    this.overlayTargets = '';
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({ error: '环境未初始化，请重新打开小程序' });
      return;
    }
    this.identityOverlay = new IdentityOverlayController(
      runtime.sessions,
      runtime.identityPrivacy,
      systemClock,
      (view) => this.setData({ identityOverlay: view }),
      runtime.privateViews,
    );
    this.controller = new FeedController(runtime, (view) => {
      this.setData({ ...view });
      const key = view.posts
        .map((item) => item.id + ':' + item.author.kind)
        .join(',');
      if (view.busy || !view.loaded) {
        this.identityOverlay?.clear();
        this.overlayTargets = '';
      } else if (key !== this.overlayTargets) {
        this.overlayTargets = key;
        void this.identityOverlay?.show(
          view.posts.map((item) => ({
            kind: 'post',
            id: item.id,
            authorMode: item.author.kind,
          })),
        );
      }
    });
    void this.controller.load();
  },
  onQuery(event: { detail: { value: string } }) {
    this.controller?.setQuery(event.detail.value);
  },
  onSearch() {
    void this.controller?.search();
  },
  onCampus(event: { currentTarget: { dataset: { id: string } } }) {
    void this.controller?.chooseCampus(event.currentTarget.dataset.id);
  },
  onGlobal(event: { currentTarget: { dataset: { id: string } } }) {
    void this.controller?.chooseGlobal(event.currentTarget.dataset.id);
  },
  onRegional() {
    void this.controller?.chooseRegional();
  },
  onCategory(event: { currentTarget: { dataset: { key: string } } }) {
    void this.controller?.setCategory(event.currentTarget.dataset.key);
  },
  onRefresh() {
    void this.controller?.refresh();
  },
  onReload() {
    void this.controller?.load();
  },
  onMore() {
    void this.controller?.more();
  },
  onCancel() {
    this.controller?.cancel();
  },
  onHide() {
    this.controller?.dispose();
    this.controller = undefined;
    this.identityOverlay?.dispose();
    this.identityOverlay = undefined;
  },
  onUnload() {
    this.controller?.dispose();
    this.controller = undefined;
    this.identityOverlay?.dispose();
    this.identityOverlay = undefined;
  },
});
