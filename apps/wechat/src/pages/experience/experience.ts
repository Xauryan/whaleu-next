import type { WhaleuApp } from '../../app';
import {
  ExperienceController,
  initialExperienceView,
} from '../../experience/controller';
import type { ExperienceOperation } from '../../experience/contract';
Page({
  data: { ...initialExperienceView() },
  controller: undefined as ExperienceController | undefined,
  onShow() {
    this.controller?.dispose();
    this.controller = undefined;
    const runtime = getApp<WhaleuApp>().experience;
    if (!runtime) {
      this.setData({
        ...initialExperienceView(),
        error: '环境未初始化，请重新打开小程序',
      });
      return;
    }
    this.controller = new ExperienceController(runtime, (view) =>
      this.setData({ ...view }),
    );
    void this.controller.load();
  },
  onReload() {
    void this.controller?.load();
  },
  onSignIn() {
    void this.controller?.signIn();
  },
  onMore() {
    void this.controller?.moreRecords();
  },
  onTitle(event: { currentTarget: { dataset: { key: string } } }) {
    this.controller?.chooseTitle(event.currentTarget.dataset.key || null);
  },
  onColor(event: { currentTarget: { dataset: { id: number | string } } }) {
    const id = event.currentTarget.dataset.id;
    this.controller?.chooseColor(id === '' ? null : Number(id));
  },
  onSave() {
    void this.controller?.saveAppearance();
  },
  onCancelSelection() {
    this.controller?.cancelSelection();
  },
  onRecover(event: {
    currentTarget: {
      dataset: { operation: ExperienceOperation; retry?: boolean };
    };
  }) {
    void this.controller?.recover(
      event.currentTarget.dataset.operation,
      event.currentTarget.dataset.retry === true,
    );
  },
  onCloseUnlock(event: { currentTarget: { dataset: { id: string } } }) {
    void this.controller?.closeUnlock(event.currentTarget.dataset.id);
  },
  onCancel() {
    this.controller?.cancel();
  },
  onHide() {
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.controller?.dispose();
    this.controller = undefined;
  },
});
