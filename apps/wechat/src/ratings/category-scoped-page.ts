import type { WhaleuApp } from '../app';
import { DirectoryNavigator } from '../directory/navigation';
import {
  initialRatingCategoryScopedView,
  RatingCategoryScopedController,
} from './category-scoped-controller';
type Event = {
  currentTarget: {
    dataset: {
      id?: string;
      field?: string;
      key?: string;
      value?: string;
      operation?: string;
      action?: string;
      status?: string;
      direction?: string;
    };
  };
  detail: { value: string };
};
/** A native page owns exactly one controller; no context, draft or preview survives hide. */
export function registerRatingCategoryScopedPage(editorPage = false): void {
  Page({
    data: { ...initialRatingCategoryScopedView(), editorPage },
    route: {} as unknown,
    navigationActive: false,
    controller: undefined as RatingCategoryScopedController | undefined,
    navigator: undefined as DirectoryNavigator | undefined,
    unsubscribeSession: undefined as (() => void) | undefined,
    unsubscribeHide: undefined as (() => void) | undefined,
    onLoad(query: unknown = {}) {
      this.route = query;
    },
    onShow() {
      this.onHide();
      const runtime = getApp<WhaleuApp>().community;
      if (!runtime) {
        this.setData({
          ...initialRatingCategoryScopedView(),
          editorPage,
          error: '环境未初始化，请重新打开小程序',
        });
        return;
      }
      this.navigationActive = true;
      this.navigator = new DirectoryNavigator(wx, () =>
        this.setData({ error: '暂不能打开管理页面，请重试' }),
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
          this.navigator = this.navigationActive
            ? new DirectoryNavigator(wx, () =>
                this.setData({ error: '暂不能打开管理页面，请重试' }),
              )
            : undefined;
        }
      });
      this.unsubscribeHide = runtime.privateViews?.subscribe((accountId) => {
        if (accountId === undefined) {
          this.navigationActive = false;
          this.navigator?.dispose();
          this.navigator = undefined;
        }
      });
      this.controller = new RatingCategoryScopedController(
        runtime,
        (view) => this.setData({ ...view }),
        editorPage,
      );
      void this.controller.load(this.route);
    },
    onRefresh() {
      void this.controller?.reload();
    },
    onStop() {
      this.controller?.cancel();
    },
    onLogin() {
      this.navigator?.open('/pages/login/login');
    },
    onOpenCampuses() {
      void this.controller?.openCampusPicker('view');
    },
    onPlacementCampuses() {
      void this.controller?.openCampusPicker('placement');
    },
    onCampusQuery(event: Event) {
      this.controller?.setCampusQuery(event.detail.value);
    },
    onSearchCampuses() {
      void this.controller?.searchCampuses(1);
    },
    onPreviousCampuses() {
      void this.controller?.searchCampuses(this.data.campusPage - 1);
    },
    onNextCampuses() {
      void this.controller?.searchCampuses(this.data.campusPage + 1);
    },
    onCampus(event: Event) {
      void this.controller?.selectCampus(
        event.currentTarget.dataset.id ?? null,
      );
    },
    onGlobal() {
      void this.controller?.selectCampus(null);
    },
    onCloseCampuses() {
      this.controller?.closeCampusPicker();
    },
    onRemovePlacementCampus(event: Event) {
      this.controller?.removePlacementCampus(
        event.currentTarget.dataset.id ?? '',
      );
    },
    onRecover() {
      void this.controller?.recover();
    },
    onPreparePending() {
      void this.controller?.preparePending();
    },
    onRequestCancel() {
      this.controller?.requestCancel();
    },
    onConfirmCancel() {
      void this.controller?.confirmCancel();
    },
    onDismissCancel() {
      this.controller?.dismissCancel();
    },
    onFilter(event: Event) {
      this.controller?.filter(event.currentTarget.dataset.status ?? '');
    },
    onPreviousCategories() {
      this.controller?.previousCategories();
    },
    onMore() {
      this.controller?.more();
    },
    onRoot() {
      this.navigator?.open(this.controller?.navigationPath(null) ?? null);
    },
    onInspect(event: Event) {
      this.navigator?.open(
        this.controller?.navigationPath(
          event.currentTarget.dataset.id ?? null,
        ) ?? null,
      );
    },
    onChildren(event: Event) {
      this.navigator?.open(
        this.controller?.navigationPath(
          event.currentTarget.dataset.id ?? null,
        ) ?? null,
      );
    },
    onOpenEditor(event: Event) {
      const id = event.currentTarget.dataset.id;
      this.navigator?.open(
        id
          ? (this.controller?.navigationPath(id, true) ?? null)
          : (this.controller?.currentEditorPath() ?? null),
      );
    },
    onHistory() {
      void this.controller?.history();
    },
    onMoreHistory() {
      void this.controller?.history(true);
    },
    onOperation(event: Event) {
      this.controller?.selectOperation(
        event.currentTarget.dataset.operation ?? '',
      );
    },
    onText(event: Event) {
      this.controller?.setText(
        event.currentTarget.dataset.field ?? '',
        event.detail.value,
      );
    },
    onChoice(event: Event) {
      this.controller?.choose(
        event.currentTarget.dataset.field ?? '',
        event.currentTarget.dataset.value ?? '',
      );
    },
    onResetOverride() {
      this.controller?.resetOverride();
    },
    onSystemKey(event: Event) {
      this.controller?.selectSystemKey(event.currentTarget.dataset.key ?? '');
    },
    onNodeText(event: Event) {
      this.controller?.setNodeText(
        event.currentTarget.dataset.key ?? '',
        event.currentTarget.dataset.field ?? '',
        event.detail.value,
      );
    },
    onAddChild(event: Event) {
      this.controller?.addNode(event.currentTarget.dataset.key ?? null);
    },
    onAddNode() {
      this.controller?.addNode();
    },
    onRemoveNode(event: Event) {
      this.controller?.removeNode(event.currentTarget.dataset.key ?? '');
    },
    onBatchAction(event: Event) {
      this.controller?.batchAction(
        event.currentTarget.dataset.id ?? '',
        event.currentTarget.dataset.action ?? '',
      );
    },
    onMove(event: Event) {
      this.controller?.move(
        event.currentTarget.dataset.key ?? '',
        event.currentTarget.dataset.direction ?? '',
      );
    },
    onPageOrder(event: Event) {
      this.controller?.pageOrder(Number(event.currentTarget.dataset.direction));
    },
    onPageBatch(event: Event) {
      this.controller?.pageBatch(Number(event.currentTarget.dataset.direction));
    },
    onPagePreview(event: Event) {
      this.controller?.pagePreview(
        Number(event.currentTarget.dataset.direction),
      );
    },
    onPrepare() {
      void this.controller?.prepare();
    },
    onDiscardDraft() {
      this.controller?.discardDraft();
    },
    onCommit() {
      void this.controller?.commit();
    },
    onClosePreview() {
      this.controller?.closePreview();
    },
    onReturnCatalog() {
      this.navigator?.open(this.controller?.catalogPath() ?? null);
    },
    onHide() {
      this.navigationActive = false;
      const route = this.controller?.snapshotRoute();
      if (route) this.route = route;
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
      this.route = {};
    },
  });
}
