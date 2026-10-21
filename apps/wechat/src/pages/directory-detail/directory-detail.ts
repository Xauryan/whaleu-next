import { HttpOrganizationGateway } from '../../organizations/gateway';
import {
  OrganizationEditorController,
  initialOrganizationEditorView,
} from '../../organizations/controller';
import { OrganizationCommandJournal } from '../../organizations/pending';
import { HttpDirectoryGateway } from '../../directory/gateway';
import { WechatStorage } from '../../platform/wechat';
import { clientConfiguration } from '../../config';
import { organizationMediaSlot } from '../../organizations/media-validation';
import type {
  OrganizationMediaReader,
  OrganizationMediaReadView,
} from '../../organizations/media-runtime';
import type { WhaleuApp } from '../../app';
import { ClientError } from '../../api/errors';
import {
  directoryKinds,
  directoryKindLabels,
  directoryPlatformLabels,
} from '../../directory/contract';
import { DirectoryNavigator } from '../../directory/navigation';
import {
  DirectoryDetailController,
  decodeDirectoryRoute,
  initialDirectoryView,
  type DirectoryResume,
  type DirectoryRoute,
} from '../../directory/controller';
/** View-only date label. Original timestamps stay on the DTO for all actions. */
function displayDate(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}

Page({
  data: {
    showInfo: false,
    ...initialDirectoryView(),
    managed: false,
    nativeDetail: initialOrganizationEditorView(),
    nativeImage: {
      status: 'idle',
      src: '',
      message: '',
    } as OrganizationMediaReadView,
    directoryKinds,
    directoryKindLabels,
    directoryPlatformLabels,
  },
  managedController: undefined as OrganizationEditorController | undefined,
  managedReader: undefined as OrganizationMediaReader | undefined,
  route: null as DirectoryRoute | null,
  resume: null as DirectoryResume | null,
  controller: undefined as DirectoryDetailController | undefined,
  navigator: undefined as DirectoryNavigator | undefined,
  unsubscribeSession: undefined as (() => void) | undefined,
  unsubscribeScope: undefined as (() => void) | undefined,
  unsubscribeHide: undefined as (() => void) | undefined,
  onLoad(query: unknown = {}) {
    try {
      if (
        query &&
        typeof query === 'object' &&
        'source' in query &&
        query.source === 'managed'
      ) {
        const { source: _source, ...route } = query;
        void _source;
        this.route = decodeDirectoryRoute(route, 'detail');
        this.setData({ managed: true });
      } else this.route = decodeDirectoryRoute(query, 'detail');
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
        this.managedController?.dispose();
        this.managedController = undefined;
        this.managedReader?.dispose();
        this.managedReader = undefined;
        this.setData({
          ...initialDirectoryView(),
          hasSession: !!current.credentials,
        });
      }
    });
    this.unsubscribeScope = runtime.directoryScopeChanges?.subscribe(() =>
      this.clearManaged(),
    );
    this.unsubscribeHide = runtime.privateViews?.subscribe((accountId) => {
      this.clearManaged();
      if (accountId === undefined) {
        this.resume = this.controller?.snapshot() ?? this.resume;
        this.navigator?.dispose();
        this.managedController?.dispose();
        this.managedController = undefined;
        this.managedReader?.dispose();
        this.managedReader = undefined;
      }
    });
  },
  onToggleInfo() {
    this.setData({ showInfo: !this.data.showInfo });
  },
  onShow() {
    if (this.data.managed) {
      this.showManaged();
      return;
    }
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
    this.navigator = new DirectoryNavigator(wx, () =>
      this.setData({ error: '暂不能打开目录页面，请重试' }),
    );
    this.controller = new DirectoryDetailController(runtime, (view) =>
      this.setData({
        ...view,
        detail: view.detail
          ? {
              ...view.detail,
              createdAtLabel: displayDate(view.detail.createdAt),
              updatedAtLabel: displayDate(view.detail.updatedAt),
            }
          : null,
      }),
    );
    void this.controller.load(resume?.route ?? this.route, resume ?? undefined);
  },
  onRefresh() {
    if (this.data.managed) {
      this.showManaged();
      return;
    }
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
  onCopyQq() {
    void this.controller?.copyQq(
      (value) =>
        new Promise<void>((resolve, reject) => {
          if (!wx.setClipboardData) {
            reject(new ClientError('configuration', 'Clipboard unavailable'));
            return;
          }
          wx.setClipboardData({ data: value, success: resolve, fail: reject });
        }),
    );
  },
  clearManaged() {
    this.managedController?.dispose();
    this.managedController = undefined;
    this.managedReader?.dispose();
    this.managedReader = undefined;
    this.setData({
      nativeDetail: initialOrganizationEditorView(),
      nativeImage: { status: 'idle', src: '', message: '' },
    });
  },
  showManaged() {
    this.managedController?.dispose();
    this.managedReader?.dispose();
    const app = getApp<WhaleuApp>(),
      identity = app.identity,
      route = this.route;
    if (!identity?.api || !app.community || !route || !('entryId' in route)) {
      this.setData({ error: '组织详情入口不可用' });
      return;
    }
    this.managedReader = app.organizationMedia?.createReader((nativeImage) =>
      this.setData({ nativeImage }),
    );
    this.managedController = new OrganizationEditorController(
      identity.sessions,
      new HttpOrganizationGateway(identity.api),
      new HttpDirectoryGateway(identity.api),
      new OrganizationCommandJournal(
        new WechatStorage(wx),
        clientConfiguration.apiOrigin,
      ),
      app.community.newRequestId,
      (nativeDetail) => {
        this.managedReader?.clear();
        this.setData({ nativeDetail });
      },
    );
    void this.managedController.load(route.entryId, true, route.regionId);
  },
  onNativePreview(event: { currentTarget: { dataset: { slot: string } } }) {
    const target = this.managedController?.previewTarget(
      organizationMediaSlot(event.currentTarget.dataset.slot),
    );
    if (target) void this.managedReader?.load(target);
  },
  onNativeClose() {
    this.managedReader?.clear();
  },
  onHide() {
    this.managedController?.dispose();
    this.managedController = undefined;
    this.managedReader?.dispose();
    this.managedReader = undefined;
    this.resume = this.controller?.snapshot() ?? this.resume;
    this.controller?.dispose();
    this.controller = undefined;
    this.navigator?.dispose();
    this.navigator = undefined;
  },
  onUnload() {
    this.managedController?.dispose();
    this.managedController = undefined;
    this.managedReader?.dispose();
    this.managedReader = undefined;
    this.controller?.dispose();
    this.controller = undefined;
    this.navigator?.dispose();
    this.navigator = undefined;
    this.unsubscribeSession?.();
    this.unsubscribeSession = undefined;
    this.unsubscribeScope?.();
    this.unsubscribeScope = undefined;
    this.unsubscribeHide?.();
    this.unsubscribeHide = undefined;
    this.resume = null;
    this.route = null;
  },
});
