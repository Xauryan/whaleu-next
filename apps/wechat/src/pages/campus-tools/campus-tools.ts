import type { WhaleuApp } from '../../app';
import {
  initialToolHubView,
  type ToolHubController,
} from '../../campus-tools/controller';
import { toolUuid } from '../../campus-tools/contract';
import { ToolNavigator } from '../../campus-tools/navigation';
Page({
  data: { ...initialToolHubView(), query: '', authRecovery: false },
  controller: undefined as ToolHubController | undefined,
  navigator: undefined as ToolNavigator | undefined,
  campusId: null as string | null,
  invalid: false,
  onLoad(query: Record<string, unknown> = {}) {
    try {
      if (Object.keys(query).some((key) => key !== 'campusId'))
        throw new Error('Invalid route');
      this.campusId =
        query.campusId === undefined ? null : toolUuid(query.campusId);
    } catch {
      this.invalid = true;
    }
  },
  onShow() {
    this.controller?.dispose();
    this.navigator?.dispose();
    this.setData({ ...initialToolHubView(), query: '', authRecovery: false });
    if (this.invalid) {
      this.setData({ error: '校园入口无效，请从个人资料重新打开' });
      return;
    }
    const runtime = getApp<WhaleuApp>().campusTools;
    if (!runtime) {
      this.setData({ error: '当前环境尚未配置校园工具' });
      return;
    }
    if (runtime.needsRecovery()) {
      this.setData({
        authRecovery: true,
        error: '登录状态未能恢复。请重新登录，或明确选择以访客继续。',
      });
      return;
    }
    this.navigator = new ToolNavigator(wx, () =>
      this.setData({ error: '工具页面暂时无法打开，请重试' }),
    );
    this.controller = runtime.createHub((view) => {
      this.navigator?.dispose();
      this.navigator = new ToolNavigator(wx, () =>
        this.setData({ error: '工具页面暂时无法打开，请重试' }),
      );
      this.setData({ ...view, authRecovery: runtime.needsRecovery() });
    });
    void this.controller.load(this.campusId);
  },
  onContinueGuest() {
    const runtime = getApp<WhaleuApp>().campusTools;
    if (runtime?.continueGuest()) this.onShow();
    else this.setData({ error: '暂时无法确认访客状态，请重新登录' });
  },
  onRefresh() {
    void this.controller?.refresh();
  },
  onChooseCampus() {
    void this.controller?.search('');
  },
  onQuery(event: { detail: { value: string } }) {
    this.setData({ query: event.detail.value });
  },
  onSearch() {
    void this.controller?.search(this.data.query);
  },
  onPrevious() {
    if (this.data.hasPrevious && !this.data.busy)
      void this.controller?.search(
        this.data.searchQuery,
        this.data.campusPage - 1,
      );
  },
  onNext() {
    if (this.data.hasNext && !this.data.busy)
      void this.controller?.search(
        this.data.searchQuery,
        this.data.campusPage + 1,
      );
  },
  onSelectCampus(event: { currentTarget: { dataset: { id: string } } }) {
    this.campusId = null;
    void this.controller?.choose(event.currentTarget.dataset.id);
  },
  onOpen(event: { currentTarget: { dataset: { id: string } } }) {
    this.navigator?.open(
      this.controller?.route(event.currentTarget.dataset.id) ?? null,
    );
  },
  onHide() {
    this.controller?.dispose();
    this.controller = undefined;
    this.navigator?.dispose();
    this.navigator = undefined;
  },
  onUnload() {
    this.controller?.dispose();
    this.controller = undefined;
    this.navigator?.dispose();
    this.navigator = undefined;
  },
});
