import type { WhaleuApp } from '../../app';
import { PUBLIC_EXPERIENCE_COLOR_STYLES } from '../../experience/public-display';
import { AuthorNavigator } from '../../profile/author-navigation';
import {
  ExperienceRankingController,
  initialExperienceRankingView,
} from './controller';
Page({
  data: {
    ...initialExperienceRankingView(),
    experienceColorStyles: PUBLIC_EXPERIENCE_COLOR_STYLES,
  },
  controller: undefined as ExperienceRankingController | undefined,
  authorNavigator: undefined as AuthorNavigator | undefined,
  onShow() {
    this.controller?.dispose();
    this.authorNavigator?.dispose();
    this.controller = undefined;
    this.authorNavigator = undefined;
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({
        ...initialExperienceRankingView(),
        error: '环境未初始化，请重新打开小程序',
      });
      return;
    }
    this.authorNavigator = new AuthorNavigator(
      wx,
      () => this.setData({ error: '暂不能打开主页，请重试' }),
      runtime,
    );
    this.controller = new ExperienceRankingController(runtime, (view) =>
      this.setData({ ...view }),
    );
    void this.controller.load();
  },
  onRefresh() {
    this.onShow();
  },
  onCancel() {
    this.controller?.cancel();
  },
  onProfile(event: { currentTarget: { dataset: { profileId: string } } }) {
    if (!this.data.loaded || this.data.busy) return;
    const item = this.data.items.find(
      (item) => item.profileId === event.currentTarget.dataset.profileId,
    );
    if (item)
      this.authorNavigator?.open({ kind: 'named', ...item, avatar: null });
  },
  onHide() {
    this.controller?.dispose();
    this.controller = undefined;
    this.authorNavigator?.dispose();
    this.authorNavigator = undefined;
  },
  onUnload() {
    this.onHide();
  },
});
