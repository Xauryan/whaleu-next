import type { WhaleuApp } from '../app';
import { isRecord } from '../api/errors';
import { windowId } from '../window-ratings/contract';
import {
  DishRecommendationController,
  initialDishRecommendationView,
} from './controller';
export function registerDishRecommendationPage(): void {
  Page({
    data: { ...initialDishRecommendationView(), uiPanel: '' },
    unsubscribePresentation: undefined as (() => void) | undefined,
    windowId: null as string | null,
    validRoute: false,
    controller: undefined as DishRecommendationController | undefined,
    onLoad(query: unknown = {}) {
      this.validRoute =
        isRecord(query) &&
        (Object.keys(query).length === 0 ||
          (Object.keys(query).length === 1 && windowId(query.windowId)));
      this.windowId =
        this.validRoute && isRecord(query) && windowId(query.windowId)
          ? query.windowId
          : null;
    },
    onShow() {
      this.setData({ uiPanel: '' });
      this.unsubscribePresentation?.();
      this.unsubscribePresentation = undefined;
      this.controller?.dispose();
      this.controller = undefined;
      const runtime = getApp<WhaleuApp>().community;
      if (!runtime || !this.validRoute) {
        this.setData({
          ...initialDishRecommendationView(),
          error: runtime
            ? '窗口入口无效，请从窗口详情重新进入'
            : '环境尚未初始化，请重新打开小程序',
        });
        return;
      }
      const close = () => this.setData({ uiPanel: '' });
      const stops = [
        runtime.sessions.subscribe(close),
        runtime.privateViews?.subscribe(close),
        runtime.safetyChanges?.subscribe(close),
      ];
      this.unsubscribePresentation = () => stops.forEach((stop) => stop?.());
      this.controller = new DishRecommendationController(runtime, (view) =>
        this.setData({ ...view, ...(!view.hasSession ? { uiPanel: '' } : {}) }),
      );
      void this.controller.load(this.windowId);
    },
    onTogglePanel(event: { currentTarget: { dataset: { panel?: string } } }) {
      const panel = event.currentTarget.dataset.panel;
      if (typeof panel === 'string' && /^[a-zA-Z0-9:_-]{1,100}$/.test(panel))
        this.setData({ uiPanel: this.data.uiPanel === panel ? '' : panel });
    },
    onClosePanel() {
      this.setData({ uiPanel: '' });
    },
    onName(event: { detail: { value: string } }) {
      this.controller?.setName(event.detail.value);
    },
    onDish(event: { currentTarget: { dataset: { identity?: string } } }) {
      this.setData({ uiPanel: 'dish' });
      void this.controller?.choose(event.currentTarget.dataset.identity ?? '');
    },
    onLookup() {
      void this.controller?.lookup();
    },
    onRefresh() {
      void this.controller?.reload();
    },
    onNext() {
      void this.controller?.next();
    },
    onRecommend() {
      this.controller?.confirm('recommend');
    },
    onRetract() {
      this.controller?.confirm('retract');
    },
    onSubmit() {
      void this.controller?.submit();
    },
    onCloseConfirmation() {
      this.controller?.closeConfirmation();
    },
    onRecover() {
      void this.controller?.recover();
    },
    onRetry() {
      void this.controller?.recover(true);
    },
    onRequestCancellation() {
      void this.controller?.recover(false, true);
    },
    onConfirmCancellation() {
      void this.controller?.confirmCancellation();
    },
    onCancelWait() {
      this.controller?.cancel();
    },
    onHide() {
      this.setData({ uiPanel: '' });
      this.unsubscribePresentation?.();
      this.unsubscribePresentation = undefined;
      this.controller?.dispose();
      this.controller = undefined;
    },
    onUnload() {
      this.onHide();
    },
  });
}
