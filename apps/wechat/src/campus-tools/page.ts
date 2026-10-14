import type { WhaleuApp } from '../app';
import type { ToolKind } from './contract';
import { initialToolEntryView, type ToolEntryController } from './controller';
import { initialToolImageView, type ToolImageReader } from './media';
import { toolHubPath, toolRoute, type ToolRoute } from './navigation';
/** Registered pages all enter through the same strict identity-only lifecycle. */
export function registerToolPage(kind: ToolKind) {
  Page({
    data: {
      ...initialToolEntryView(),
      image: initialToolImageView(),
      authRecovery: false,
    },
    route: null as ToolRoute | null,
    controller: undefined as ToolEntryController | undefined,
    reader: undefined as ToolImageReader | undefined,
    backPending: false,
    backGeneration: 0,
    onLoad(query: Record<string, unknown> = {}) {
      try {
        this.route = toolRoute(query);
        getApp<WhaleuApp>().campusTools?.scope.select(this.route.campusId);
      } catch {
        this.route = null;
        this.setData({ error: '工具入口无效，请返回校园工具重新选择' });
      }
    },
    onShow() {
      this.controller?.dispose();
      this.reader?.dispose();
      this.backPending = false;
      this.backGeneration++;
      this.setData({
        ...initialToolEntryView(),
        image: initialToolImageView(),
        authRecovery: false,
      });
      const runtime = getApp<WhaleuApp>().campusTools;
      if (!this.route) {
        this.setData({ error: '工具入口无效，请返回校园工具重新选择' });
        return;
      }
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
      this.reader = runtime.createReader(
        (image) => this.setData({ image }),
        () => this.controller?.sourceUnavailable(),
      );
      this.controller = runtime.createEntry(
        this.route,
        kind,
        (view) =>
          this.setData({ ...view, authRecovery: runtime.needsRecovery() }),
        () => this.reader?.clear(),
      );
      void this.controller.load();
    },
    onContinueGuest() {
      const runtime = getApp<WhaleuApp>().campusTools;
      if (runtime?.continueGuest()) this.onShow();
      else this.setData({ error: '暂时无法确认访客状态，请重新登录' });
    },
    onRefresh() {
      this.reader?.clear();
      void this.controller?.load();
    },
    onMarker(event: {
      currentTarget?: { dataset: { id: number | string } };
      detail?: { markerId: number };
    }) {
      const id =
        event.detail?.markerId ?? Number(event.currentTarget?.dataset.id);
      if (Number.isInteger(id)) this.controller?.marker(id);
    },
    onCloseMarker() {
      this.controller?.closeMarker();
    },
    onLocate() {
      void this.controller?.locate();
    },
    onReset() {
      this.controller?.reset();
    },
    onToggleGroup(event: { currentTarget: { dataset: { id: string } } }) {
      this.controller?.toggleGroup(event.currentTarget.dataset.id);
    },
    onPreview(event: { currentTarget: { dataset: { binding: string } } }) {
      const context = this.controller?.mediaContext();
      if (!context || !this.reader) return;
      const entry = context.entry,
        slots =
          entry.kind === 'shuttle'
            ? entry.groups.flatMap((g) => g.slots)
            : entry.kind === 'research' && entry.image
              ? [entry.image]
              : [];
      const index = slots.findIndex(
        (slot) => slot.bindingId === event.currentTarget.dataset.binding,
      );
      if (index >= 0) void this.reader.open(context, index);
    },
    onCloseImage() {
      this.reader?.clear();
    },
    onImagePrevious() {
      void this.reader?.select(this.data.image.selected - 1);
    },
    onImageNext() {
      void this.reader?.select(this.data.image.selected + 1);
    },
    onImageRetry() {
      void this.reader?.retry();
    },
    onImageError(event: {
      currentTarget: { dataset: { source: string; viewId: string } };
    }) {
      this.reader?.imageFailed(
        event.currentTarget.dataset.source,
        event.currentTarget.dataset.viewId,
      );
    },
    onCopy() {
      void this.controller?.copy();
    },
    onWebviewLoad(event: {
      currentTarget: { dataset: { source: string; viewId: string } };
    }) {
      this.controller?.webviewLoaded(
        event.currentTarget.dataset.source,
        event.currentTarget.dataset.viewId,
      );
    },
    onWebviewError(event: {
      currentTarget: { dataset: { source: string; viewId: string } };
    }) {
      this.controller?.webviewFailed(
        event.currentTarget.dataset.source,
        event.currentTarget.dataset.viewId,
      );
    },
    onWebviewMessage() {
      /* Untrusted messages deliberately have no command bridge. */
    },
    onBack() {
      if (this.backPending) return;
      this.backPending = true;
      const generation = ++this.backGeneration;
      this.controller?.dispose();
      this.reader?.clear();
      const current = () => generation === this.backGeneration;
      const failed = () => {
        if (!current()) return;
        this.backPending = false;
        this.setData({ error: '暂时无法返回，请使用下方校园工具入口' });
      };
      const fallback = () => {
        if (!current()) return;
        try {
          if (!wx.reLaunch) {
            failed();
            return;
          }
          wx.reLaunch({
            url: toolHubPath,
            success: () => {
              if (current()) this.backPending = false;
            },
            fail: failed,
          });
        } catch {
          failed();
        }
      };
      try {
        if (!wx.navigateBack) {
          fallback();
          return;
        }
        wx.navigateBack({
          delta: 1,
          success: () => {
            if (current()) this.backPending = false;
          },
          fail: fallback,
        });
      } catch {
        fallback();
      }
    },
    onHide() {
      this.backGeneration++;
      this.controller?.dispose();
      this.controller = undefined;
      this.reader?.dispose();
      this.reader = undefined;
    },
    onUnload() {
      this.backGeneration++;
      this.controller?.dispose();
      this.controller = undefined;
      this.reader?.dispose();
      this.reader = undefined;
    },
  });
}
