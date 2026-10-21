import type { WhaleuApp } from '../../app';
import { FeedController, initialFeedView } from '../community-feed/controller';
import { composeRoute } from '../../shell/navigation';
Page({
  data: { ...initialFeedView(), opening: false },
  controller: undefined as FeedController | undefined,
  onShow() {
    this.controller?.dispose();
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({ error: '环境未初始化，请重新打开小程序' });
      return;
    }
    this.controller = new FeedController(runtime, (view) =>
      this.setData({ ...view }),
    );
    void this.controller.load();
  },
  onCampus(event: { currentTarget: { dataset: { id: string } } }) {
    const campus = this.data.campuses.find(
      (item) => item.id === event.currentTarget.dataset.id,
    );
    if (campus?.isActive) void this.controller?.chooseCampus(campus.id);
  },
  onGlobal(event: { currentTarget: { dataset: { id: string } } }) {
    void this.controller?.chooseGlobal(event.currentTarget.dataset.id);
  },
  onRegional() {
    void this.controller?.chooseRegional();
  },
  onContinue() {
    if (
      !this.data.hasSession ||
      !this.data.space ||
      this.data.busy ||
      this.data.opening
    )
      return;
    if (!wx.navigateTo) {
      this.setData({ error: '当前环境无法打开发布页面' });
      return;
    }
    this.setData({ opening: true });
    wx.navigateTo({
      url: composeRoute(this.data.space.id),
      success: () => this.setData({ opening: false }),
      fail: () =>
        this.setData({ opening: false, error: '无法打开发布页面，请重试' }),
    });
  },
  onRetry() {
    void this.controller?.load();
  },
  onHide() {
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.onHide();
  },
});
