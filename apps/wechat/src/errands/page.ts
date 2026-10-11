import { initialErrandPublicationView } from './publication-runtime';
import type { ErrandImageComposer } from './publication-runtime';
import type { ErrandMediaReader, ErrandMediaReadView } from './media-runtime';
import type { ErrandView } from './controller';
import { errandMediaSlot } from './media-validation';
import { HttpProfileGateway } from '../profile/gateway';
import {
  ErrandTargetServicesController,
  HttpErrandTargetServicesGateway,
  initialErrandTargetServicesView,
} from './target-services';
import type {
  SchoolQrReader,
  SchoolQrReadView,
} from '../school-configuration/qr-runtime';
import { ErrandAdminEntryController } from './admin-entry';
import type { WhaleuApp } from '../app';
import { DirectoryNavigator } from '../directory/navigation';
import { errandStateLabels } from './contract';
import {
  decodeErrandRoute,
  ErrandController,
  initialErrandView,
  type ErrandMode,
  type ErrandRoute,
} from './controller';
type Tap = {
  currentTarget: {
    dataset: { id?: string; field?: string; value?: string; action?: string };
  };
};
type Input = {
  currentTarget: { dataset: { field: string } };
  detail: { value: string };
};
/** Native controls only; route intent may survive hide, never private content or form values. */
export function registerErrandPage(mode: ErrandMode): void {
  Page({
    data: {
      imagePublication: initialErrandPublicationView(),
      orderImage: {
        status: 'idle',
        src: '',
        message: '',
      } as ErrandMediaReadView,
      ...initialErrandView(),
      errandStateLabels,
      adminAvailable: false,
      targetServices: initialErrandTargetServicesView(),
      targetQr: { status: 'idle', src: '', message: '' } as SchoolQrReadView,
    },
    imageComposer: undefined as ErrandImageComposer | undefined,
    imageReader: undefined as ErrandMediaReader | undefined,
    currentView: null as ErrandView | null,
    imageIdentity: '',
    targetServices: undefined as ErrandTargetServicesController | undefined,
    targetReader: undefined as SchoolQrReader | undefined,
    adminEntry: undefined as ErrandAdminEntryController | undefined,
    route: null as ErrandRoute | null,
    controller: undefined as ErrandController | undefined,
    navigator: undefined as DirectoryNavigator | undefined,
    unsubscribeSession: undefined as (() => void) | undefined,
    unsubscribeHide: undefined as (() => void) | undefined,
    onLoad(query: unknown = {}) {
      try {
        this.route = decodeErrandRoute(query, mode);
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
          this.navigator?.dispose();
          this.imageComposer?.clear();
          this.imageReader?.clear();
          this.currentView = null;
        }
      });
      this.unsubscribeHide = runtime.privateViews?.subscribe((accountId) => {
        if (accountId === undefined) {
          this.navigator?.dispose();
          this.imageComposer?.clear();
          this.imageReader?.clear();
          this.currentView = null;
          this.targetServices?.dispose();
          this.targetServices = undefined;
          this.targetReader?.dispose();
          this.targetReader = undefined;
        }
      });
    },
    onShow() {
      this.imageComposer?.dispose();
      this.imageComposer = undefined;
      this.imageReader?.dispose();
      this.imageReader = undefined;
      this.currentView = null;
      this.imageIdentity = '';
      this.targetServices?.dispose();
      this.targetServices = undefined;
      this.targetReader?.dispose();
      this.targetReader = undefined;
      this.adminEntry?.dispose();
      this.adminEntry = undefined;
      this.controller?.dispose();
      this.controller = undefined;
      this.navigator?.dispose();
      this.navigator = undefined;
      const runtime = getApp<WhaleuApp>().community;
      if (!runtime) {
        this.setData({
          ...initialErrandView(),
          error: '环境未初始化，请重新打开小程序',
        });
        return;
      }
      this.navigator = new DirectoryNavigator(wx, () =>
        this.setData({ error: '暂不能打开跑腿页面，请重试' }),
      );
      const app = getApp<WhaleuApp>();
      if (mode === 'compose')
        this.imageComposer = app.errandPublication?.createComposer(
          (imagePublication) => this.setData({ imagePublication }),
        );
      if (mode === 'detail')
        this.imageReader = app.errandMedia?.createReader((orderImage) =>
          this.setData({ orderImage }),
        );
      if (mode === 'detail' && app.identity?.api) {
        this.targetReader = app.schoolQr?.createReader((targetQr) =>
          this.setData({ targetQr }),
        );
        this.targetServices = new ErrandTargetServicesController(
          runtime.sessions,
          new HttpErrandTargetServicesGateway(app.identity.api),
          new HttpProfileGateway(app.identity.api),
          () => this.targetReader?.clear(),
          (targetServices) => this.setData({ targetServices }),
        );
      }
      this.controller = new ErrandController(runtime, mode, (view) => {
        this.currentView = view;
        const imageIdentity =
          view.loaded && view.detail
            ? JSON.stringify([
                view.detail.id,
                view.detail.revision,
                view.detail.mediaRevision,
                view.detail.relation,
              ])
            : '';
        if (imageIdentity !== this.imageIdentity) {
          this.imageReader?.clear();
          this.imageIdentity = imageIdentity;
        }
        this.setData({ ...view });
        this.targetServices?.sync(view.loaded ? view.detail : null);
      });
      void this.controller.load(this.route);
      if (mode === 'list') {
        this.adminEntry = new ErrandAdminEntryController(runtime, (view) =>
          this.setData({ adminAvailable: view.allowed }),
        );
        void this.adminEntry.load();
      }
    },
    onRefresh() {
      void this.controller?.reload();
    },
    onPreviewTargetQr() {
      const target = this.targetServices?.previewContext();
      if (target && this.targetReader) void this.targetReader.load(target);
    },
    onCloseTargetQr() {
      this.targetReader?.clear();
    },
    onDismissTargetNotice() {
      void this.targetServices?.dismiss();
    },
    onMore() {
      void this.controller?.more();
    },
    onCancel() {
      this.controller?.cancel();
    },
    onRecover() {
      void this.controller?.recover();
    },
    onRetry() {
      void this.controller?.recover(true);
    },
    onChoice(event: Tap) {
      void this.controller?.choose(
        event.currentTarget.dataset.field ?? '',
        event.currentTarget.dataset.value ?? '',
      );
    },
    onCampusQuery(event: { detail: { value: string } }) {
      this.controller?.setCampusQuery(event.detail.value);
    },
    onCampusSearch() {
      void this.controller?.searchCampuses();
    },
    onCampus(event: Tap) {
      void this.controller?.selectCampus(event.currentTarget.dataset.id ?? '');
    },
    onOrder(event: Tap) {
      this.navigator?.open(
        this.controller?.detailPath(event.currentTarget.dataset.id ?? '') ??
          null,
      );
    },
    onCompose() {
      this.navigator?.open(this.controller?.composePath() ?? null);
    },
    onForm(event: Input) {
      this.controller?.setForm(
        event.currentTarget.dataset.field,
        event.detail.value,
      );
    },
    onPublisherContacts() {
      this.controller?.usePublisherContacts();
    },
    onPublish() {
      if (!this.currentView) return;
      if (this.imageComposer?.hasDraft)
        void this.imageComposer.publish(
          this.currentView.form,
          this.currentView.regionId,
        );
      else void this.controller?.publish();
    },
    onChooseOrderImage(event: Tap) {
      if (this.currentView && !this.currentView.frozen)
        void this.imageComposer?.choose(
          event.currentTarget.dataset.value ?? '',
          this.currentView.regionId,
        );
    },
    onRecoverOrderImage(event: Tap) {
      if (this.currentView)
        void this.imageComposer?.choose(
          event.currentTarget.dataset.value ?? '',
          this.currentView.regionId,
          true,
        );
    },
    onRemoveOrderImage(event: Tap) {
      void this.imageComposer?.remove(event.currentTarget.dataset.value ?? '');
    },
    onRecoverImagePublication() {
      void this.imageComposer?.recover();
    },
    onRetryImagePublication() {
      void this.imageComposer?.recover(true);
    },
    onCancelImageDraft() {
      void this.imageComposer?.cancelDraft();
    },
    onPreviewOrderImage(event: Tap) {
      try {
        const slot = errandMediaSlot(event.currentTarget.dataset.value),
          detail = this.currentView?.detail;
        if (!this.currentView?.loaded || !detail?.mediaRevision) return;
        if (
          ![...(detail.publicMedia ?? []), ...(detail.privateMedia ?? [])].some(
            (x) => x.slot === slot,
          )
        )
          return;
        void this.imageReader?.load({
          orderId: detail.id,
          revision: detail.mediaRevision,
          slot,
        });
      } catch {
        /* Invalid or stale native taps cannot authorize an image. */
      }
    },
    onCloseOrderImage() {
      this.imageReader?.clear();
    },
    onAccept() {
      void this.controller?.openAccept();
    },
    onCloseAccept() {
      this.controller?.closeAccept();
    },
    onToggleLast() {
      void this.controller?.toggleLast();
    },
    onContact(event: Input) {
      this.controller?.setContact(
        event.currentTarget.dataset.field,
        event.detail.value,
      );
    },
    onConfirmAccept() {
      void this.controller?.accept();
    },
    onConfirm(event: Tap) {
      this.controller?.confirm(event.currentTarget.dataset.action ?? '');
    },
    onDismiss() {
      this.controller?.dismissConfirmation();
    },
    onConfirmCommand() {
      void this.controller?.confirmCommand();
    },
    onHide() {
      this.imageComposer?.dispose();
      this.imageComposer = undefined;
      this.imageReader?.dispose();
      this.imageReader = undefined;
      this.currentView = null;
      this.imageIdentity = '';
      this.targetServices?.dispose();
      this.targetServices = undefined;
      this.targetReader?.dispose();
      this.targetReader = undefined;
      this.adminEntry?.dispose();
      this.adminEntry = undefined;
      this.controller?.dispose();
      this.controller = undefined;
      this.navigator?.dispose();
      this.navigator = undefined;
    },
    onUnload() {
      this.onHide();
      this.unsubscribeSession?.();
      this.unsubscribeSession = undefined;
      this.unsubscribeHide?.();
      this.unsubscribeHide = undefined;
      this.route = null;
    },
  });
}
