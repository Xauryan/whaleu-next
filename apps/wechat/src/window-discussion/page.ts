import type { WhaleuApp } from '../app';
import { isRecord } from '../api/errors';
import { DirectoryNavigator } from '../directory/navigation';
import { windowId } from '../window-ratings/contract';
import {
  WindowDiscussionController,
  initialWindowDiscussionView,
  type DiscussionMode,
} from './controller';
import {
  WindowDiscussionNoticesController,
  initialWindowDiscussionNoticesView,
} from './notices-controller';
import type { DiscussionTarget } from './contract';
type Tap = { currentTarget: { dataset: { id?: string; sort?: string } } };
export function registerWindowDiscussionPage(mode: DiscussionMode): void {
  Page({
    data: { ...initialWindowDiscussionView(), mode },
    windowId: null as string | null,
    rootId: null as string | null,
    validRoute: false,
    notice: null as { noticeId: string; target: DiscussionTarget } | null,
    controller: undefined as WindowDiscussionController | undefined,
    navigator: undefined as DirectoryNavigator | undefined,
    unsubscribe: undefined as (() => void) | undefined,
    onLoad(query: unknown = {}) {
      if (!isRecord(query)) return;
      const keys = Object.keys(query),
        notice = keys.includes('noticeId');
      this.validRoute =
        mode === 'recovery'
          ? keys.length === 0
          : mode === 'roots'
            ? keys.length === 1 && windowId(query.windowId)
            : keys.length === (notice ? 4 : 2) &&
              windowId(query.windowId) &&
              windowId(query.rootId) &&
              (!notice ||
                (windowId(query.noticeId) && windowId(query.commentId)));
      if (!this.validRoute) return;
      this.windowId = windowId(query.windowId) ? query.windowId : null;
      this.rootId = windowId(query.rootId) ? query.rootId : null;
      this.notice = notice
        ? {
            noticeId: query.noticeId as string,
            target: {
              windowId: this.windowId!,
              rootId: this.rootId!,
              commentId: query.commentId as string,
            },
          }
        : null;
    },
    onShow() {
      this.onHide();
      const runtime = getApp<WhaleuApp>().community;
      if (!runtime || !this.validRoute) {
        this.setData({
          ...initialWindowDiscussionView(),
          mode,
          error: runtime
            ? '窗口讨论入口无效，请从窗口详情或通知重新进入'
            : '环境尚未初始化，请重新打开小程序',
        });
        return;
      }
      this.navigator = new DirectoryNavigator(wx, () =>
        this.setData({ error: '暂不能打开讨论，请重试' }),
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
      this.controller = new WindowDiscussionController(runtime, mode, (view) =>
        this.setData({ ...view }),
      );
      void this.controller.load(this.windowId, this.rootId, this.notice);
    },
    onRefresh() {
      this.navigator?.dispose();
      this.navigator = new DirectoryNavigator(wx, () =>
        this.setData({ error: '暂不能打开讨论，请重试' }),
      );
      void this.controller?.reload();
    },
    onNext() {
      void this.controller?.next();
    },
    onSort(e: Tap) {
      void this.controller?.setSort(e.currentTarget.dataset.sort);
    },
    onBody(e: { detail: { value: string } }) {
      this.controller?.setBody(e.detail.value);
    },
    onConfirmPublish() {
      this.controller?.confirmPublish();
    },
    onLike(e: Tap) {
      this.controller?.confirmLike(e.currentTarget.dataset.id ?? '');
    },
    onReply(e: Tap) {
      this.controller?.chooseReply(e.currentTarget.dataset.id ?? null);
    },
    onReplyRoot() {
      this.controller?.chooseReply(null);
    },
    onThread(e: Tap) {
      this.navigator?.open(
        this.controller?.threadPath(e.currentTarget.dataset.id ?? '') ?? null,
      );
    },
    onSubmit() {
      void this.controller?.submit();
    },
    onCloseConfirmation() {
      this.controller?.closeConfirmation();
    },
    onRecover() {
      void this.controller?.recover();
    },
    onRetry() {
      void this.controller?.recover(true);
    },
    onRequestCancellation() {
      void this.controller?.recover(false, true);
    },
    onConfirmCancellation() {
      void this.controller?.confirmCancellation();
    },
    onCancelWait() {
      this.controller?.cancel();
    },
    onOwnWindow(e: { detail: { value: string } }) {
      this.controller?.setOwnLocator('window', e.detail.value);
    },
    onOwnComment(e: { detail: { value: string } }) {
      this.controller?.setOwnLocator('comment', e.detail.value);
    },
    onLookupOwn() {
      void this.controller?.lookupOwn();
    },
    onUnlike() {
      this.controller?.confirmUnlike();
    },
    onOwnReference(e: Tap) {
      void this.controller?.chooseOwnReference(
        e.currentTarget.dataset.id ?? '',
      );
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
export function registerWindowDiscussionNoticesPage(): void {
  Page({
    data: initialWindowDiscussionNoticesView(),
    validRoute: false,
    controller: undefined as WindowDiscussionNoticesController | undefined,
    navigator: undefined as DirectoryNavigator | undefined,
    unsubscribe: undefined as (() => void) | undefined,
    onLoad(q: unknown = {}) {
      this.validRoute = isRecord(q) && Object.keys(q).length === 0;
    },
    onShow() {
      this.onHide();
      const runtime = getApp<WhaleuApp>().community;
      if (!runtime || !this.validRoute) {
        this.setData({
          ...initialWindowDiscussionNoticesView(),
          error: '通知入口或环境不可用',
        });
        return;
      }
      this.navigator = new DirectoryNavigator(wx, () =>
        this.setData({ error: '暂不能打开通知，请重试' }),
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
        runtime.privateViews?.subscribe((a) => {
          if (a === undefined) this.navigator?.dispose();
        }),
        runtime.safetyChanges?.subscribe(() => this.navigator?.dispose()),
      ];
      this.unsubscribe = () => stops.forEach((stop) => stop?.());
      this.controller = new WindowDiscussionNoticesController(runtime, (view) =>
        this.setData({ ...view }),
      );
      void this.controller.reload();
    },
    onRefresh() {
      this.navigator?.dispose();
      this.navigator = new DirectoryNavigator(wx, () =>
        this.setData({ error: '暂不能打开通知，请重试' }),
      );
      void this.controller?.reload();
    },
    onNext() {
      void this.controller?.next();
    },
    onOpen(e: Tap) {
      void this.controller?.open(e.currentTarget.dataset.id ?? '', (path) =>
        this.navigator?.open(path),
      );
    },
    onRead(e: Tap) {
      void this.controller?.read(e.currentTarget.dataset.id ?? '');
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
