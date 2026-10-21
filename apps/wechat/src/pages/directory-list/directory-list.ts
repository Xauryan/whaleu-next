import { HttpOrganizationGateway } from '../../organizations/gateway';
import {
  OrganizationListController,
  initialOrganizationListView,
} from '../../organizations/controller';
import type { WhaleuApp } from '../../app';
import {
  directoryKinds,
  directoryKindLabels,
  directoryPlatformLabels,
} from '../../directory/contract';
import { DirectoryNavigator } from '../../directory/navigation';
import {
  DirectoryListController,
  decodeDirectoryRoute,
  initialDirectoryView,
  type DirectoryResume,
  type DirectoryRoute,
  type DirectoryListRoute,
} from '../../directory/controller';
Page({
  data: {
    showInfo: false,
    ...initialDirectoryView(),
    nativeDirectory: initialOrganizationListView(),
    directoryKinds,
    directoryKindLabels,
    directoryPlatformLabels,
  },
  nativeController: undefined as OrganizationListController | undefined,
  nativeScope: '',
  route: null as DirectoryRoute | null,
  resume: null as DirectoryResume | null,
  controller: undefined as DirectoryListController | undefined,
  navigator: undefined as DirectoryNavigator | undefined,
  unsubscribeSession: undefined as (() => void) | undefined,
  unsubscribeHide: undefined as (() => void) | undefined,
  onLoad(query: unknown = {}) {
    try {
      this.route = decodeDirectoryRoute(query, 'list');
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
        this.resume = null;
        this.navigator?.dispose();
        this.nativeController?.clear();
        this.setData({
          ...initialDirectoryView(),
          hasSession: !!current.credentials,
        });
      }
    });
    this.unsubscribeHide = runtime.privateViews?.subscribe((accountId) => {
      if (accountId === undefined) {
        this.resume = this.controller?.snapshot() ?? this.resume;
        this.navigator?.dispose();
      }
    });
  },
  onToggleInfo() {
    this.setData({ showInfo: !this.data.showInfo });
  },
  onShow() {
    this.nativeController?.dispose();
    this.nativeController = undefined;
    this.nativeScope = '';
    const resume = this.controller?.snapshot() ?? this.resume;
    this.controller?.dispose();
    this.controller = undefined;
    this.navigator?.dispose();
    this.navigator = undefined;
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({
        ...initialDirectoryView(),
        error: '环境未初始化，请重新打开小程序',
      });
      return;
    }
    this.resume = null;
    const api = getApp<WhaleuApp>().identity?.api;
    if (api)
      this.nativeController = new OrganizationListController(
        runtime.sessions,
        new HttpOrganizationGateway(api),
        (nativeDirectory) => this.setData({ nativeDirectory }),
      );
    const nativeRoute = resume?.route ?? this.route;
    if (nativeRoute && 'regionId' in nativeRoute) {
      const target = nativeRoute as DirectoryListRoute;
      this.loadNative(
        target.regionId,
        target.kind,
        target.categoryId ?? '',
        resume?.submittedQuery ?? '',
      );
    }
    this.navigator = new DirectoryNavigator(wx, () =>
      this.setData({ error: '暂不能打开目录页面，请重试' }),
    );
    this.controller = new DirectoryListController(runtime, (view) => {
      this.setData({ ...view });
      if (view.loaded)
        this.loadNative(
          view.regionId,
          view.kind,
          view.categoryId,
          view.submittedQuery,
        );
    });
    void this.controller.load(resume?.route ?? this.route, resume ?? undefined);
  },
  onRefresh() {
    this.nativeScope = '';
    this.loadNative(
      this.data.regionId,
      this.data.kind,
      this.data.categoryId,
      this.data.submittedQuery,
    );
    void this.controller?.refresh();
  },
  onNext() {
    void this.controller?.next();
  },
  onPrevious() {
    void this.controller?.previous();
  },
  onCancel() {
    this.controller?.cancel();
  },
  onInput(event: { detail: { value: string } }) {
    this.controller?.setInput(event.detail.value);
  },
  onSubmit() {
    this.loadNative(
      this.data.regionId,
      this.data.kind,
      this.data.categoryId,
      this.data.inputDraft.trim(),
    );
    void this.controller?.submit();
  },
  onClear() {
    this.loadNative(
      this.data.regionId,
      this.data.kind,
      this.data.categoryId,
      '',
    );
    void this.controller?.clearSearch();
  },
  onEntry(event: { currentTarget: { dataset: { id: string } } }) {
    this.navigator?.open(
      this.controller?.entryPath(event.currentTarget.dataset.id) ?? null,
    );
  },
  loadNative(
    regionId: string,
    kind: 'school' | 'org' | 'official',
    categoryId: string,
    q: string,
  ) {
    if (!regionId || (!categoryId && !q)) return;
    const scope = JSON.stringify([regionId, kind, categoryId, q]);
    if (scope === this.nativeScope) return;
    this.nativeScope = scope;
    void this.nativeController?.load('public', regionId, {
      kind,
      ...(categoryId ? { categoryId } : {}),
      ...(q ? { q } : {}),
    });
  },
  onNativeMore() {
    void this.nativeController?.next();
  },
  onNativeRefresh() {
    this.nativeScope = '';
    this.loadNative(
      this.data.regionId,
      this.data.kind,
      this.data.categoryId,
      this.data.submittedQuery,
    );
  },
  onNativeEntry(event: { currentTarget: { dataset: { id: string } } }) {
    const row = this.data.nativeDirectory.items.find(
      (item) => item.id === event.currentTarget.dataset.id,
    );
    if (!row) return;
    this.navigator?.open(
      `/pages/directory-detail/directory-detail?source=managed&kind=${row.data.kind}&regionId=${row.regionId}&categoryId=${row.data.categoryId}&entryId=${row.id}`,
    );
  },
  onHide() {
    this.nativeController?.dispose();
    this.nativeController = undefined;
    this.resume = this.controller?.snapshot() ?? this.resume;
    this.controller?.dispose();
    this.controller = undefined;
    this.navigator?.dispose();
    this.navigator = undefined;
  },
  onUnload() {
    this.nativeController?.dispose();
    this.nativeController = undefined;
    this.controller?.dispose();
    this.controller = undefined;
    this.navigator?.dispose();
    this.navigator = undefined;
    this.unsubscribeSession?.();
    this.unsubscribeSession = undefined;
    this.unsubscribeHide?.();
    this.unsubscribeHide = undefined;
    this.resume = null;
    this.route = null;
  },
});
