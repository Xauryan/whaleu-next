import type { WhaleuApp } from '../../app';
import { DirectoryNavigator } from '../../directory/navigation';
import {
  errandAdminStatusLabels,
  errandAdminStatuses,
} from '../../errands/admin-contract';
import {
  decodeErrandAdminRoute,
  ErrandAdminController,
  initialErrandAdminView,
  type ErrandAdminRoute,
} from '../../errands/admin-controller';
import {
  ErrandAdminCommandController,
  initialErrandAdminCommandView,
} from '../../errands/admin-command-controller';
import { errandAdminCommandHandlers } from '../../errands/admin-command-page';
import {
  errandRestrictionActionLabels,
  errandRestrictionDurations,
} from '../../errands/admin-command-contract';
type Tap = { currentTarget: { dataset: { id?: string } } };
Page({
  data: {
    ...initialErrandAdminView(),
    adminCommand: initialErrandAdminCommandView(),
    statusOptions: errandAdminStatuses.map((value) => ({
      value,
      label: errandAdminStatusLabels[value],
    })),
    statusLabels: errandAdminStatusLabels,
    actionLabels: errandRestrictionActionLabels,
    actionOptions: (['publish', 'accept', 'all'] as const).map((value) => ({
      value,
      label: errandRestrictionActionLabels[value],
    })),
    durationLabels: errandRestrictionDurations.map((item) => item.label),
  },
  ...errandAdminCommandHandlers,
  route: null as ErrandAdminRoute | null,
  controller: undefined as ErrandAdminController | undefined,
  commands: undefined as ErrandAdminCommandController | undefined,
  navigator: undefined as DirectoryNavigator | undefined,
  unsubscribeSession: undefined as (() => void) | undefined,
  unsubscribeHide: undefined as (() => void) | undefined,
  onLoad(query: unknown = {}) {
    try {
      this.route = decodeErrandAdminRoute(query);
    } catch {
      this.route = null;
    }
  },
  onShow() {
    this.onHide();
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({
        ...initialErrandAdminView(),
        error: '环境未初始化，请重新打开小程序',
      });
      return;
    }
    this.navigator = new DirectoryNavigator(wx, () =>
      this.setData({ error: '暂不能打开订单，请重试' }),
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
      }
    });
    this.unsubscribeHide = runtime.privateViews?.subscribe((accountId) => {
      if (accountId === undefined) this.navigator?.dispose();
    });
    this.controller = new ErrandAdminController(runtime, (view) =>
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
    void this.controller.load(this.route);
  },
  onRefresh() {
    this.commands?.invalidateContext();
    void this.controller?.reload();
  },
  onNext() {
    this.commands?.invalidateContext();
    void this.controller?.next();
  },
  onPrevious() {
    this.commands?.invalidateContext();
    void this.controller?.previous();
  },
  onCancel() {
    this.commands?.invalidateContext();
    this.controller?.cancel();
  },
  onKeyword(event: { detail: { value: string } }) {
    this.commands?.invalidateContext();
    this.controller?.setKeyword(event.detail.value);
  },
  onSearch() {
    this.commands?.invalidateContext();
    void this.controller?.search();
  },
  onStatus(event: { currentTarget: { dataset: { value?: string } } }) {
    this.commands?.invalidateContext();
    void this.controller?.chooseStatus(event.currentTarget.dataset.value ?? '');
  },
  onRegion(event: { detail: { value: string } }) {
    this.commands?.invalidateContext();
    this.controller?.setRegion(event.detail.value);
  },
  onSelectRegion() {
    this.commands?.invalidateContext();
    void this.controller?.selectRegion();
  },
  onAdminDelete(event: Tap) {
    const context = this.controller?.commandContext(
      event.currentTarget.dataset.id ?? '',
    );
    if (context)
      this.commands?.openOrder(
        context.order,
        context.authority,
        'admin_delete',
      );
  },
  onAdminRestrictAccepter(event: Tap) {
    const context = this.controller?.commandContext(
      event.currentTarget.dataset.id ?? '',
    );
    if (context)
      this.commands?.openOrder(
        context.order,
        context.authority,
        'restrict_accepter',
      );
  },
  onOwnerOrder(event: Tap) {
    this.navigator?.open(
      this.controller?.ownerOrderPath(event.currentTarget.dataset.id ?? '') ??
        null,
    );
  },
  onHide() {
    this.commands?.dispose();
    this.commands = undefined;
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
