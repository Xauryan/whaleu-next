import type { WhaleuApp } from '../app';
import { isRecord } from '../api/errors';
import { DirectoryNavigator } from '../directory/navigation';
import { majorId } from '../majors/contract';
import {
  MajorDiscussionController,
  initialMajorDiscussionView,
  type DiscussionMode,
} from './controller';
import {
  MajorDiscussionNoticesController,
  initialMajorDiscussionNoticesView,
} from './notices-controller';
import type { DiscussionTarget } from './contract';
type Tap = { currentTarget: { dataset: { id?: string; sort?: string } } };
export function registerMajorDiscussionPage(mode: DiscussionMode): void {
  Page({
    data: { ...initialMajorDiscussionView(), mode },
    majorId: null as string | null,
    rootId: null as string | null,
    validRoute: false,
    notice: null as { noticeId: string; target: DiscussionTarget } | null,
    controller: undefined as MajorDiscussionController | undefined,
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
            ? keys.length === 1 && majorId(query.majorId)
            : keys.length === (notice ? 4 : 2) &&
              majorId(query.majorId) &&
              majorId(query.rootId) &&
              (!notice ||
                (majorId(query.noticeId) && majorId(query.commentId)));
      if (!this.validRoute) return;
      this.majorId = majorId(query.majorId) ? query.majorId : null;
      this.rootId = majorId(query.rootId) ? query.rootId : null;
      this.notice = notice
        ? {
            noticeId: query.noticeId as string,
            target: {
              majorId: this.majorId!,
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
          ...initialMajorDiscussionView(),
          mode,
          error: runtime
            ? '专业讨论入口无效，请从专业详情或通知重新进入'
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
      this.controller = new MajorDiscussionController(runtime, mode, (view) =>
        this.setData({ ...view }),
      );
      void this.controller.load(this.majorId, this.rootId, this.notice);
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
    onOwnDelete(e: Tap) {
      void this.controller?.inspectDeletion(
        e.currentTarget.dataset.id ?? '',
        true,
      );
    },
    onDeleteMenu(e: Tap) {
      void this.controller?.inspectDeletion(e.currentTarget.dataset.id ?? '');
    },
    onDelete(e: Tap) {
      this.controller?.confirmDelete(e.currentTarget.dataset.id ?? '');
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
    onOwnMajor(e: { detail: { value: string } }) {
      this.controller?.setOwnLocator('major', e.detail.value);
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
export function registerMajorDiscussionNoticesPage(): void {
  Page({
    data: initialMajorDiscussionNoticesView(),
    validRoute: false,
    controller: undefined as MajorDiscussionNoticesController | undefined,
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
          ...initialMajorDiscussionNoticesView(),
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
      this.controller = new MajorDiscussionNoticesController(runtime, (view) =>
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
