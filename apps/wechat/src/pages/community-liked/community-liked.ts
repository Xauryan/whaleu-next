import { PUBLIC_EXPERIENCE_COLOR_STYLES } from '../../experience/public-display';
import type { WhaleuApp } from '../../app';
import { AuthorNavigator } from '../../profile/author-navigation';
import { LikedController, initialLikedView } from './controller';
Page({
  data: {
    experienceColorStyles: PUBLIC_EXPERIENCE_COLOR_STYLES,
    ...initialLikedView(),
  },
  controller: undefined as LikedController | undefined,
  authorNavigator: undefined as AuthorNavigator | undefined,
  onShow() {
    this.controller?.dispose();
    this.authorNavigator?.dispose();
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({ error: '环境未初始化，请重新打开小程序' });
      return;
    }
    this.authorNavigator = new AuthorNavigator(
      wx,
      () => this.setData({ error: '暂不能打开主页，请重试' }),
      getApp<WhaleuApp>().community,
    );
    this.controller = new LikedController(runtime, (view) =>
      this.setData({ ...view }),
    );
    void this.controller.load();
  },
  onAuthor(event: { currentTarget: { dataset: { id: string } } }) {
    if (!this.data.loaded || this.data.busy) return;
    const item = this.data.items.find(
      (item) => item.likeId === event.currentTarget.dataset.id,
    );
    this.authorNavigator?.open(item?.preview.author);
  },
  onReload() {
    void this.controller?.load();
  },
  onPrevious() {
    void this.controller?.previous();
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
    this.authorNavigator?.dispose();
    this.authorNavigator = undefined;
  },
  onUnload() {
    this.onHide();
  },
});
