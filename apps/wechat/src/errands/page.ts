import type { WhaleuApp } from '../app';
import { DirectoryNavigator } from '../directory/navigation';
import { errandStateLabels } from './contract';
import {
  decodeErrandRoute,
  ErrandController,
  initialErrandView,
  type ErrandMode,
  type ErrandRoute,
} from './controller';
type Tap = {
  currentTarget: {
    dataset: { id?: string; field?: string; value?: string; action?: string };
  };
};
type Input = {
  currentTarget: { dataset: { field: string } };
  detail: { value: string };
};
/** Native controls only; route intent may survive hide, never private content or form values. */
export function registerErrandPage(mode: ErrandMode): void {
  Page({
    data: { ...initialErrandView(), errandStateLabels },
    route: null as ErrandRoute | null,
    controller: undefined as ErrandController | undefined,
    navigator: undefined as DirectoryNavigator | undefined,
    unsubscribeSession: undefined as (() => void) | undefined,
    unsubscribeHide: undefined as (() => void) | undefined,
    onLoad(query: unknown = {}) {
      try {
        this.route = decodeErrandRoute(query, mode);
      } catch {
        this.route = null;
      }
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
        }
      });
      this.unsubscribeHide = runtime.privateViews?.subscribe((accountId) => {
        if (accountId === undefined) this.navigator?.dispose();
      });
    },
    onShow() {
      this.controller?.dispose();
      this.controller = undefined;
      this.navigator?.dispose();
      this.navigator = undefined;
      const runtime = getApp<WhaleuApp>().community;
      if (!runtime) {
        this.setData({
          ...initialErrandView(),
          error: '环境未初始化，请重新打开小程序',
        });
        return;
      }
      this.navigator = new DirectoryNavigator(wx, () =>
        this.setData({ error: '暂不能打开跑腿页面，请重试' }),
      );
      this.controller = new ErrandController(runtime, mode, (view) =>
        this.setData({ ...view }),
      );
      void this.controller.load(this.route);
    },
    onRefresh() {
      void this.controller?.reload();
    },
    onMore() {
      void this.controller?.more();
    },
    onCancel() {
      this.controller?.cancel();
    },
    onRecover() {
      void this.controller?.recover();
    },
    onRetry() {
      void this.controller?.recover(true);
    },
    onChoice(event: Tap) {
      void this.controller?.choose(
        event.currentTarget.dataset.field ?? '',
        event.currentTarget.dataset.value ?? '',
      );
    },
    onCampusQuery(event: { detail: { value: string } }) {
      this.controller?.setCampusQuery(event.detail.value);
    },
    onCampusSearch() {
      void this.controller?.searchCampuses();
    },
    onCampus(event: Tap) {
      void this.controller?.selectCampus(event.currentTarget.dataset.id ?? '');
    },
    onOrder(event: Tap) {
      this.navigator?.open(
        this.controller?.detailPath(event.currentTarget.dataset.id ?? '') ??
          null,
      );
    },
    onCompose() {
      this.navigator?.open(this.controller?.composePath() ?? null);
    },
    onForm(event: Input) {
      this.controller?.setForm(
        event.currentTarget.dataset.field,
        event.detail.value,
      );
    },
    onPublisherContacts() {
      this.controller?.usePublisherContacts();
    },
    onPublish() {
      void this.controller?.publish();
    },
    onAccept() {
      void this.controller?.openAccept();
    },
    onCloseAccept() {
      this.controller?.closeAccept();
    },
    onToggleLast() {
      void this.controller?.toggleLast();
    },
    onContact(event: Input) {
      this.controller?.setContact(
        event.currentTarget.dataset.field,
        event.detail.value,
      );
    },
    onConfirmAccept() {
      void this.controller?.accept();
    },
    onConfirm(event: Tap) {
      this.controller?.confirm(event.currentTarget.dataset.action ?? '');
    },
    onDismiss() {
      this.controller?.dismissConfirmation();
    },
    onConfirmCommand() {
      void this.controller?.confirmCommand();
    },
    onHide() {
      this.controller?.dispose();
      this.controller = undefined;
      this.navigator?.dispose();
      this.navigator = undefined;
    },
    onUnload() {
      this.onHide();
      this.unsubscribeSession?.();
      this.unsubscribeSession = undefined;
      this.unsubscribeHide?.();
      this.unsubscribeHide = undefined;
      this.route = null;
    },
  });
}
