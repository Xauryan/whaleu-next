import { PUBLIC_EXPERIENCE_COLOR_STYLES } from '../../experience/public-display';
import { AuthorNavigator } from '../../profile/author-navigation';
import {
  SystemNoticesBadgeController,
  initialSystemNoticesBadgeView,
} from '../system-notices/controller';
import {
  ReportMutationController,
  initialReportMutationView,
} from '../../community/report-controller';
import {
  BlockMutationController,
  initialBlockMutationView,
} from '../../community/block-controller';
import {
  UpdatesBadgeController,
  initialUpdatesBadgeView,
} from '../community-updates/controller';
import {
  tradingCategories,
  tradingLabels,
} from '../../community/trading-contract';
import {
  IdentityOverlayController,
  initialOverlayView,
} from '../../identity-privacy/overlay';
import { systemClock } from '../../platform/clock';
import type { WhaleuApp } from '../../app';
import { FeedController, initialFeedView } from './controller';
Page({
  data: {
    experienceColorStyles: PUBLIC_EXPERIENCE_COLOR_STYLES,
    report: initialReportMutationView(),
    block: initialBlockMutationView(),
    ...initialFeedView(),
    systemNoticesBadge: initialSystemNoticesBadgeView(),
    updatesBadge: initialUpdatesBadgeView(),
    tradingCategories,
    tradingLabels,
    identityOverlay: initialOverlayView(),
    categories: [
      { key: 'all', label: '全部普通帖子' },
      { key: 'trading', label: '校园交易' },
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
  reportMutations: undefined as ReportMutationController | undefined,
  blockMutations: undefined as BlockMutationController | undefined,
  blockTargets: '',
  controller: undefined as FeedController | undefined,
  systemNoticesBadge: undefined as SystemNoticesBadgeController | undefined,
  updatesBadge: undefined as UpdatesBadgeController | undefined,
  identityOverlay: undefined as IdentityOverlayController | undefined,
  overlayTargets: '',
  authorNavigator: undefined as AuthorNavigator | undefined,
  onShow() {
    this.authorNavigator?.dispose();
    this.authorNavigator = new AuthorNavigator(
      wx,
      () => this.setData({ error: '暂不能打开主页，请重试' }),
      getApp<WhaleuApp>().community,
    );
    this.reportMutations?.dispose();
    this.reportMutations = undefined;
    this.blockMutations?.dispose();
    this.blockMutations = undefined;
    this.blockTargets = '';
    this.systemNoticesBadge?.dispose();
    this.systemNoticesBadge = undefined;
    this.updatesBadge?.dispose();
    this.updatesBadge = undefined;
    this.controller?.dispose();
    this.identityOverlay?.dispose();
    this.overlayTargets = '';
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({ error: '环境未初始化，请重新打开小程序' });
      return;
    }
    this.systemNoticesBadge = new SystemNoticesBadgeController(
      runtime,
      (view) => this.setData({ systemNoticesBadge: view }),
    );
    void this.systemNoticesBadge.load();
    this.updatesBadge = new UpdatesBadgeController(runtime, (view) =>
      this.setData({ updatesBadge: view }),
    );
    void this.updatesBadge.load();
    this.reportMutations = new ReportMutationController(
      runtime,
      'report',
      (view) => {
        this.setData({ report: view });
        if (view.busy || view.frozen) {
          this.identityOverlay?.clear();
          this.overlayTargets = '';
        }
      },
    );
    this.reportMutations.load();
    this.blockMutations = new BlockMutationController(runtime, (view) => {
      this.setData({ block: view });
      if (view.busy || view.frozen) {
        this.identityOverlay?.clear();
        this.overlayTargets = '';
      }
    });
    this.blockMutations.load();
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
      if (view.busy || !view.loaded || key !== this.blockTargets) {
        this.reportMutations?.dismiss();
        this.blockMutations?.dismissBlock();
      }
      this.blockTargets = key;
      if (
        view.busy ||
        !view.loaded ||
        this.data.report.busy ||
        this.data.report.frozen ||
        this.data.block.busy ||
        this.data.block.frozen
      ) {
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
  onTradingSubtype(event: { currentTarget: { dataset: { key: string } } }) {
    void this.controller?.setTradingSubtype(event.currentTarget.dataset.key);
  },
  onRefresh() {
    void this.systemNoticesBadge?.load();
    void this.updatesBadge?.load();
    void this.controller?.refresh();
  },
  onReportPost(event: { currentTarget: { dataset: { id: string } } }) {
    const post = this.data.posts.find(
      (item) => item.id === event.currentTarget.dataset.id,
    );
    if (post && this.data.loaded && this.data.hasSession && !this.data.busy)
      this.reportMutations?.requestReport('post', post);
  },
  onConfirmReport() {
    void this.reportMutations?.confirm();
  },
  onDismissReport() {
    this.reportMutations?.dismiss();
  },
  onReportReceipt() {
    void this.reportMutations?.recover();
  },
  onReportRetry() {
    void this.reportMutations?.recover(true);
  },
  onReportCancel() {
    this.reportMutations?.cancel();
  },
  onBlockPost(event: { currentTarget: { dataset: { id: string } } }) {
    const post = this.data.posts.find(
      (item) => item.id === event.currentTarget.dataset.id,
    );
    if (post && this.data.loaded && this.data.hasSession && !this.data.busy)
      this.blockMutations?.requestBlock('post', post);
  },
  onConfirmBlock() {
    void this.blockMutations?.confirmBlock();
  },
  onDismissBlock() {
    this.blockMutations?.dismissBlock();
  },
  onBlockReceipt() {
    void this.blockMutations?.recover();
  },
  onBlockRetry() {
    void this.blockMutations?.recover(true);
  },
  onBlockCancel() {
    this.blockMutations?.cancel();
  },
  onAuthor(event: { currentTarget: { dataset: { id: string } } }) {
    if (!this.data.loaded || this.data.busy) return;
    this.authorNavigator?.open(
      this.data.posts.find((item) => item.id === event.currentTarget.dataset.id)
        ?.author,
    );
  },
  onReload() {
    this.reportMutations?.dismiss();
    this.blockMutations?.dismissBlock();
    void this.systemNoticesBadge?.load();
    void this.updatesBadge?.load();
    void this.controller?.load();
  },
  onMore() {
    void this.controller?.more();
  },
  onCancel() {
    this.updatesBadge?.cancel();
    this.controller?.cancel();
  },
  onHide() {
    this.authorNavigator?.dispose();
    this.authorNavigator = undefined;
    this.reportMutations?.dispose();
    this.reportMutations = undefined;
    this.blockMutations?.dispose();
    this.blockMutations = undefined;
    this.blockTargets = '';
    this.systemNoticesBadge?.dispose();
    this.systemNoticesBadge = undefined;
    this.updatesBadge?.dispose();
    this.updatesBadge = undefined;
    this.controller?.dispose();
    this.controller = undefined;
    this.identityOverlay?.dispose();
    this.identityOverlay = undefined;
  },
  onUnload() {
    this.authorNavigator?.dispose();
    this.authorNavigator = undefined;
    this.reportMutations?.dispose();
    this.reportMutations = undefined;
    this.blockMutations?.dispose();
    this.blockMutations = undefined;
    this.blockTargets = '';
    this.systemNoticesBadge?.dispose();
    this.systemNoticesBadge = undefined;
    this.updatesBadge?.dispose();
    this.updatesBadge = undefined;
    this.controller?.dispose();
    this.controller = undefined;
    this.identityOverlay?.dispose();
    this.identityOverlay = undefined;
  },
});
