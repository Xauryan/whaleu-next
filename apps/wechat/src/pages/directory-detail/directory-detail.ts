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
Page({
  data: {
    ...initialDirectoryView(),
    directoryKinds,
    directoryKindLabels,
    directoryPlatformLabels,
  },
  route: null as DirectoryRoute | null,
  resume: null as DirectoryResume | null,
  controller: undefined as DirectoryDetailController | undefined,
  navigator: undefined as DirectoryNavigator | undefined,
  unsubscribeSession: undefined as (() => void) | undefined,
  unsubscribeHide: undefined as (() => void) | undefined,
  onLoad(query: unknown = {}) {
    try {
      this.route = decodeDirectoryRoute(query, 'detail');
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
  onShow() {
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
      this.setData({ ...view }),
    );
    void this.controller.load(resume?.route ?? this.route, resume ?? undefined);
  },
  onRefresh() {
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
  onHide() {
    this.resume = this.controller?.snapshot() ?? this.resume;
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
    this.unsubscribeSession?.();
    this.unsubscribeSession = undefined;
    this.unsubscribeHide?.();
    this.unsubscribeHide = undefined;
    this.resume = null;
    this.route = null;
  },
});
