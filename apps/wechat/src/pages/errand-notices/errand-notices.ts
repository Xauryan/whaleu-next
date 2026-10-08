import type { WhaleuApp } from '../../app';
import { DirectoryNavigator } from '../../directory/navigation';
import {
  ErrandNoticesController,
  initialErrandNoticesView,
} from '../../errands/notices';
Page({
  data: initialErrandNoticesView(),
  controller: undefined as ErrandNoticesController | undefined,
  navigator: undefined as DirectoryNavigator | undefined,
  unsubscribe: undefined as (() => void) | undefined,
  unsubscribeHide: undefined as (() => void) | undefined,
  onShow() {
    this.onHide();
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({
        ...initialErrandNoticesView(),
        error: '环境未初始化，请重新打开小程序',
      });
      return;
    }
    this.navigator = new DirectoryNavigator(wx, () =>
      this.setData({ error: '暂不能打开订单，请重试' }),
    );
    let owner = runtime.sessions.snapshot();
    this.unsubscribe = runtime.sessions.subscribe(() => {
      const now = runtime.sessions.snapshot();
      if (
        now.epoch !== owner.epoch ||
        now.credentials?.accountId !== owner.credentials?.accountId
      ) {
        owner = now;
        this.navigator?.dispose();
      }
    });
    this.unsubscribeHide = runtime.privateViews?.subscribe((accountId) => {
      if (accountId === undefined) this.navigator?.dispose();
    });
    this.controller = new ErrandNoticesController(runtime, (view) =>
      this.setData({ ...view }),
    );
    void this.controller.load();
  },
  onRefresh() {
    void this.controller?.load();
  },
  onMore() {
    void this.controller?.more();
  },
  onRead(event: { currentTarget: { dataset: { id: string } } }) {
    void this.controller?.read(event.currentTarget.dataset.id);
  },
  onOrder(event: { currentTarget: { dataset: { id: string } } }) {
    this.navigator?.open(
      this.controller?.orderPath(event.currentTarget.dataset.id) ?? null,
    );
  },
  onCancel() {
    this.controller?.cancel();
  },
  onHide() {
    this.controller?.dispose();
    this.controller = undefined;
    this.navigator?.dispose();
    this.navigator = undefined;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.unsubscribeHide?.();
    this.unsubscribeHide = undefined;
  },
  onUnload() {
    this.onHide();
  },
});
