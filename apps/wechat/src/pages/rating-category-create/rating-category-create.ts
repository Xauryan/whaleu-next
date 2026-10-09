import type { WhaleuApp } from '../../app';
import { DirectoryNavigator } from '../../directory/navigation';
import {
  initialRatingCategoryManagementView,
  RatingCategoryManagementController,
} from '../../ratings/category-management-controller';
import {
  decodeRatingCategoryManagementRoute,
  type RatingCategoryManagementRoute,
} from '../../ratings/category-management-contract';
type NodeEvent = {
  currentTarget: { dataset: { key?: string; id?: string } };
  detail: { value: string };
};
Page({
  data: initialRatingCategoryManagementView(),
  route: null as RatingCategoryManagementRoute | null,
  controller: undefined as RatingCategoryManagementController | undefined,
  navigator: undefined as DirectoryNavigator | undefined,
  unsubscribeSession: undefined as (() => void) | undefined,
  unsubscribeHide: undefined as (() => void) | undefined,
  onLoad(query: unknown = {}) {
    try {
      this.route = decodeRatingCategoryManagementRoute(query);
    } catch {
      this.route = null;
    }
  },
  onShow() {
    this.onHide();
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({
        ...initialRatingCategoryManagementView(),
        error: '环境未初始化，请重新打开小程序',
      });
      return;
    }
    this.navigator = new DirectoryNavigator(wx, () =>
      this.setData({ error: '暂不能打开目录，请重试' }),
    );
    let owner = runtime.sessions.snapshot();
    this.unsubscribeSession = runtime.sessions.subscribe(() => {
      const current = runtime.sessions.snapshot();
      if (
        current.epoch !== owner.epoch ||
        current.credentials?.accountId !== owner.credentials?.accountId
      ) {
        owner = current;
        this.navigator?.dispose();
        this.navigator = undefined;
      }
    });
    this.unsubscribeHide = runtime.privateViews?.subscribe((accountId) => {
      if (accountId === undefined) {
        this.navigator?.dispose();
        this.navigator = undefined;
      }
    });
    this.controller = new RatingCategoryManagementController(runtime, (view) =>
      this.setData({ ...view }),
    );
    void this.controller.load(this.route);
  },
  onRefresh() {
    if (this.data.busy) return;
    if (this.data.frozen) void this.controller?.recover();
    else void this.controller?.load(this.route);
  },
  onParent(event: NodeEvent) {
    this.controller?.selectParent(event.currentTarget.dataset.id || null);
  },
  onName(event: NodeEvent) {
    this.controller?.setNodeText(
      event.currentTarget.dataset.key ?? '',
      'name',
      event.detail.value,
    );
  },
  onDescription(event: NodeEvent) {
    this.controller?.setNodeText(
      event.currentTarget.dataset.key ?? '',
      'description',
      event.detail.value,
    );
  },
  onAddChild(event: NodeEvent) {
    this.controller?.addChild(event.currentTarget.dataset.key ?? '');
  },
  onRemoveNode(event: NodeEvent) {
    this.controller?.removeNode(event.currentTarget.dataset.key ?? '');
  },
  onCreate() {
    this.controller?.requestCreate();
  },
  onDismissCreate() {
    this.controller?.dismissCreate();
  },
  onConfirmCreate() {
    void this.controller?.confirmCreate();
  },
  onRecover() {
    void this.controller?.recover();
  },
  onRetry() {
    void this.controller?.recover(true);
  },
  onCancelCategoryCreation() {
    this.controller?.requestCancelCategoryCreation();
  },
  onDismissCancelCategoryCreation() {
    this.controller?.dismissCancelCategoryCreation();
  },
  onConfirmCancelCategoryCreation() {
    void this.controller?.confirmCancelCategoryCreation();
  },
  onCancel() {
    this.controller?.cancel();
  },
  onReturnCatalog() {
    this.navigator?.open('/pages/rating-catalog/rating-catalog');
  },
  onHide() {
    this.controller?.dispose();
    this.controller = undefined;
    this.navigator?.dispose();
    this.navigator = undefined;
    this.unsubscribeSession?.();
    this.unsubscribeSession = undefined;
    this.unsubscribeHide?.();
    this.unsubscribeHide = undefined;
  },
  onUnload() {
    this.onHide();
    this.route = null;
  },
});
