import type { WhaleuApp } from '../app';
import { isRecord } from '../api/errors';
import { DirectoryNavigator } from '../directory/navigation';
import { windowId, windowScoreChoices } from './contract';
import {
  WindowRatingController,
  initialWindowRatingView,
  type WindowMode,
} from './controller';
type Tap = {
  currentTarget: { dataset: { id?: string; score?: string | number } };
};
export function registerWindowRatingPage(mode: WindowMode): void {
  Page({
    data: {
      ...initialWindowRatingView(),
      scores: windowScoreChoices.map((value) => ({
        value,
        label: value > 0 ? `+${value}` : String(value),
      })),
      floorLabels: ['全部楼层'],
      floorIndex: 0,
    },
    windowId: null as string | null,
    validRoute: mode === 'catalog',
    controller: undefined as WindowRatingController | undefined,
    navigator: undefined as DirectoryNavigator | undefined,
    unsubscribeSession: undefined as (() => void) | undefined,
    unsubscribeHide: undefined as (() => void) | undefined,
    onLoad(query: unknown = {}) {
      this.validRoute =
        isRecord(query) &&
        (mode === 'catalog'
          ? Object.keys(query).length === 0
          : Object.keys(query).length === 1 && windowId(query.windowId));
      this.windowId =
        this.validRoute && isRecord(query) && windowId(query.windowId)
          ? query.windowId
          : null;
      const runtime = getApp<WhaleuApp>().community;
      if (!runtime) return;
      let owner = runtime.sessions.snapshot();
      this.unsubscribeSession = runtime.sessions.subscribe(() => {
        const current = runtime.sessions.snapshot();
        if (
          current.epoch !== owner.epoch ||
          current.credentials?.accountId !== owner.credentials?.accountId
        ) {
          owner = current;
          this.navigator?.dispose();
          if (this.controller)
            this.navigator = new DirectoryNavigator(wx, () =>
              this.setData({ error: '暂不能打开窗口，请重试' }),
            );
        }
      });
      this.unsubscribeHide = runtime.privateViews?.subscribe((accountId) => {
        if (accountId === undefined) this.navigator?.dispose();
      });
    },
    onShow() {
      this.controller?.dispose();
      this.navigator?.dispose();
      this.controller = undefined;
      this.navigator = undefined;
      const runtime = getApp<WhaleuApp>().community;
      if (!runtime || !this.validRoute) {
        this.setData({
          ...initialWindowRatingView(),
          error: runtime
            ? '窗口入口无效，请从目录重新进入'
            : '环境尚未初始化，请重新打开小程序',
        });
        return;
      }
      this.navigator = new DirectoryNavigator(wx, () =>
        this.setData({ error: '暂不能打开窗口，请重试' }),
      );
      this.controller = new WindowRatingController(runtime, mode, (view) =>
        this.setData({
          ...view,
          floorLabels: [
            '全部楼层',
            ...view.floorOptions.map((item) => item.label),
          ],
          floorIndex: view.floorDraft
            ? view.floorOptions.findIndex(
                (item) => item.id === view.floorDraft,
              ) + 1
            : 0,
        }),
      );
      void this.controller.load(this.windowId);
    },
    onRefresh() {
      void this.controller?.reload();
    },
    onCancelWait() {
      this.controller?.cancel();
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
    onCanteen(event: Tap) {
      this.controller?.toggleCanteen(event.currentTarget.dataset.id ?? '');
    },
    onFloor(event: { detail: { value: string } }) {
      const index = Number(event.detail.value);
      if (
        Number.isInteger(index) &&
        index >= 0 &&
        index <= this.data.floorOptions.length
      )
        this.controller?.setFloor(
          index === 0 ? '' : this.data.floorOptions[index - 1]!.id,
        );
    },
    onMinimum(event: { detail: { value: string } }) {
      this.controller?.setMinimum(event.detail.value);
    },
    onSearch() {
      void this.controller?.search();
    },
    onNext() {
      void this.controller?.next();
    },
    onWindow(event: Tap) {
      this.navigator?.open(
        this.controller?.detailPath(event.currentTarget.dataset.id ?? '') ??
          null,
      );
    },
    onOpenDiscussion() {
      if (mode === 'detail' && this.windowId && this.validRoute)
        this.navigator?.open(
          `/pages/window-discussion/window-discussion?windowId=${this.windowId}`,
        );
    },
    onOpenRecommendations() {
      if (mode === 'detail' && this.windowId && this.validRoute)
        this.navigator?.open(
          `/pages/window-dishes/window-dishes?windowId=${this.windowId}`,
        );
    },
    onScore(event: Tap) {
      const score = event.currentTarget.dataset.score;
      if (
        typeof score === 'number' ||
        (typeof score === 'string' && /^-?(?:\d|10)$/.test(score))
      )
        this.controller?.chooseScore(Number(score));
    },
    onConfirm() {
      this.controller?.confirm();
    },
    onCloseConfirmation() {
      this.controller?.closeConfirmation();
    },
    onSubmit() {
      void this.controller?.submit();
    },
    onHide() {
      this.navigator?.dispose();
      this.controller?.dispose();
      this.navigator = undefined;
      this.controller = undefined;
    },
    onUnload() {
      this.onHide();
      this.unsubscribeSession?.();
      this.unsubscribeHide?.();
    },
  });
}
