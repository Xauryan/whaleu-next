import type { WhaleuApp } from '../../app';
import {
  ErrandAdminCommandController,
  initialErrandAdminCommandView,
} from '../../errands/admin-command-controller';
import { errandAdminCommandHandlers } from '../../errands/admin-command-page';
import {
  errandRestrictionActionLabels,
  errandRestrictionDurations,
} from '../../errands/admin-command-contract';
import {
  ErrandRestrictionController,
  initialErrandRestrictionView,
} from '../../errands/restriction-controller';
import {
  errandRestrictionStates,
  errandRestrictionStateLabels,
} from '../../errands/restriction-contract';
Page({
  data: {
    ...initialErrandRestrictionView(),
    adminCommand: initialErrandAdminCommandView(),
    actionLabels: errandRestrictionActionLabels,
    actionOptions: (['publish', 'accept', 'all'] as const).map((value) => ({
      value,
      label: errandRestrictionActionLabels[value],
    })),
    durationLabels: errandRestrictionDurations.map((item) => item.label),
    stateOptions: errandRestrictionStates.map((value) => ({
      value,
      label: errandRestrictionStateLabels[value],
    })),
    stateLabels: errandRestrictionStateLabels,
    eventLabels: {
      issued: '签发',
      manually_released: '手动解除',
      superseded: '被同类限制替代',
      observed_baseline: '登记已知基线（原签发历史未知）',
    },
  },
  ...errandAdminCommandHandlers,
  query: {} as unknown,
  controller: undefined as ErrandRestrictionController | undefined,
  commands: undefined as ErrandAdminCommandController | undefined,
  onLoad(query: unknown = {}) {
    this.query = query;
  },
  onShow() {
    this.onHide();
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({
        ...initialErrandRestrictionView(),
        error: '环境未初始化，请重新打开小程序',
      });
      return;
    }
    this.controller = new ErrandRestrictionController(runtime, (view) =>
      this.setData({ ...view }),
    );
    this.commands = new ErrandAdminCommandController(
      runtime,
      (view) => this.setData({ adminCommand: view }),
      () => {
        void this.controller?.reload();
      },
      () => this.controller?.cancel(),
    );
    this.commands.load();
    void this.controller.load(this.query);
  },
  onRefresh() {
    this.commands?.invalidateContext();
    void this.controller?.reload();
  },
  onCancel() {
    this.commands?.invalidateContext();
    this.controller?.cancel();
  },
  onNext() {
    this.commands?.invalidateContext();
    void this.controller?.next();
  },
  onPrevious() {
    this.commands?.invalidateContext();
    void this.controller?.previous();
  },
  onProfile(event: { detail: { value: string } }) {
    this.commands?.invalidateContext();
    this.controller?.setProfile(event.detail.value);
  },
  onSearch() {
    this.commands?.invalidateContext();
    void this.controller?.search();
  },
  onState(event: { currentTarget: { dataset: { value?: string } } }) {
    this.commands?.invalidateContext();
    void this.controller?.chooseState(event.currentTarget.dataset.value ?? '');
  },
  onActionFilter(event: { currentTarget: { dataset: { value?: string } } }) {
    this.commands?.invalidateContext();
    void this.controller?.chooseAction(event.currentTarget.dataset.value ?? '');
  },
  onHistory(event: { currentTarget: { dataset: { id?: string } } }) {
    this.commands?.invalidateContext();
    void this.controller?.history(event.currentTarget.dataset.id ?? '');
  },
  onBackToList() {
    this.commands?.invalidateContext();
    void this.controller?.backToList();
  },
  onIssue() {
    const authority = this.controller?.commandAuthority();
    if (authority) this.commands?.openIssue(authority);
  },
  onRelease(event: { currentTarget: { dataset: { id?: string } } }) {
    const authority = this.controller?.commandAuthority(),
      restriction = this.controller?.commandRestriction(
        event.currentTarget.dataset.id ?? '',
      );
    if (authority && restriction)
      this.commands?.openRelease(restriction, authority);
  },
  onHide() {
    this.commands?.dispose();
    this.commands = undefined;
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.onHide();
    this.query = {};
  },
});
