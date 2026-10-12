import type { WhaleuApp } from '../app';
import { isRecord } from '../api/errors';
import { DirectoryNavigator } from '../directory/navigation';
import { majorId } from './contract';
import {
  MajorDirectoryController,
  initialMajorDirectoryView,
  type MajorMode,
} from './controller';
type Tap = { currentTarget: { dataset: { id?: string } } };
export function registerMajorDirectoryPage(mode: MajorMode): void {
  Page({
    data: { ...initialMajorDirectoryView(), mode },
    majorId: null as string | null,
    validRoute: false,
    controller: undefined as MajorDirectoryController | undefined,
    navigator: undefined as DirectoryNavigator | undefined,
    unsubscribe: undefined as (() => void) | undefined,
    onLoad(query: unknown = {}) {
      this.validRoute =
        isRecord(query) &&
        (mode === 'directory'
          ? Object.keys(query).length === 0
          : Object.keys(query).length === 1 && majorId(query.majorId));
      this.majorId =
        this.validRoute && isRecord(query) && majorId(query.majorId)
          ? query.majorId
          : null;
    },
    onShow() {
      this.onHide();
      const runtime = getApp<WhaleuApp>().community;
      if (!runtime || !this.validRoute) {
        this.setData({
          ...initialMajorDirectoryView(),
          mode,
          error: runtime
            ? '专业目录入口无效，请重新进入'
            : '环境尚未初始化，请重新打开小程序',
        });
        return;
      }
      this.navigator = new DirectoryNavigator(wx, () =>
        this.setData({ error: '暂不能打开专业页面，请重试' }),
      );
      let owner = runtime.sessions.snapshot();
      const stops = [
        runtime.sessions.subscribe(() => {
          const current = runtime.sessions.snapshot();
          if (
            current.epoch !== owner.epoch ||
            current.credentials?.accountId !== owner.credentials?.accountId
          ) {
            owner = current;
            this.navigator?.dispose();
          }
        }),
        runtime.privateViews?.subscribe((account) => {
          if (account === undefined) this.navigator?.dispose();
        }),
        runtime.safetyChanges?.subscribe(() => this.navigator?.dispose()),
      ];
      this.unsubscribe = () => stops.forEach((stop) => stop?.());
      this.controller = new MajorDirectoryController(runtime, mode, (view) =>
        this.setData({ ...view }),
      );
      void this.controller.load(this.majorId);
    },
    onRefresh() {
      this.navigator?.dispose();
      this.navigator = new DirectoryNavigator(wx, () =>
        this.setData({ error: '暂不能打开专业页面，请重试' }),
      );
      void this.controller?.reload();
    },
    onSearchInput(event: { detail: { value: string } }) {
      this.controller?.setSearch(event.detail.value);
    },
    onDepartment(event: { detail: { value: string } }) {
      this.controller?.setDepartment(Number(event.detail.value));
    },
    onSearch() {
      void this.controller?.search();
    },
    onNext() {
      void this.controller?.next();
    },
    onRelatedRefresh() {
      void this.controller?.reloadRelated();
    },
    onDetail(event: Tap) {
      this.navigator?.open(
        this.controller?.detailPath(event.currentTarget.dataset.id ?? '') ??
          null,
      );
    },
    onOpenDiscussion() {
      this.navigator?.open(this.controller?.discussionPath() ?? null);
    },
    onCancelWait() {
      this.controller?.cancel();
    },
    onHide() {
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.navigator?.dispose();
      this.controller?.dispose();
      this.navigator = undefined;
      this.controller = undefined;
    },
    onUnload() {
      this.onHide();
    },
  });
}
