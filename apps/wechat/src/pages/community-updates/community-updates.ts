import {
  IdentityOverlayController,
  initialOverlayView,
  type DisplayTarget,
} from '../../identity-privacy/overlay';
import { systemClock } from '../../platform/clock';
import { ClientError } from '../../api/errors';
import type { WhaleuApp } from '../../app';
import { UpdatesController, initialUpdatesView } from './controller';
Page({
  data: { ...initialUpdatesView(), identityOverlay: initialOverlayView() },
  identityOverlay: undefined as IdentityOverlayController | undefined,
  overlayTargets: '',
  controller: undefined as UpdatesController | undefined,
  onShow() {
    this.identityOverlay?.dispose();
    this.identityOverlay = undefined;
    this.overlayTargets = '';
    this.controller?.dispose();
    const runtime = getApp<WhaleuApp>().community;
    if (!runtime) {
      this.setData({
        ...initialUpdatesView(),
        error: '环境未初始化，请重新打开小程序',
      });
      return;
    }
    this.identityOverlay = new IdentityOverlayController(
      runtime.sessions,
      runtime.identityPrivacy,
      systemClock,
      (view) => this.setData({ identityOverlay: view }),
      runtime.privateViews,
    );
    this.controller = new UpdatesController(
      runtime,
      (view) => {
        this.setData({ ...view });
        const targets: DisplayTarget[] = [
          ...new Map(
            view.items
              .flatMap((item) =>
                item.status === 'available'
                  ? [
                      {
                        kind:
                          item.kind === 'reply'
                            ? ('reply' as const)
                            : ('comment' as const),
                        id: item.target.replyId ?? item.target.commentId,
                        authorMode: item.preview.author.kind,
                      },
                    ]
                  : [],
              )
              .map((target) => [target.kind + ':' + target.id, target]),
          ).values(),
        ];
        const key = targets
          .map(
            (target) => target.kind + ':' + target.id + ':' + target.authorMode,
          )
          .join(',');
        if (view.busy || !view.loaded) {
          this.identityOverlay?.clear();
          this.overlayTargets = '';
        } else if (key !== this.overlayTargets) {
          this.overlayTargets = key;
          void this.identityOverlay?.show(targets);
        }
      },
      (url) =>
        new Promise<void>((resolve, reject) => {
          if (!wx.navigateTo) {
            reject(new ClientError('configuration', 'Navigation unavailable'));
            return;
          }
          wx.navigateTo({
            url,
            success: resolve,
            fail: () => reject(new ClientError('network', 'Navigation failed')),
          });
        }),
    );
    void this.controller.load();
  },
  onReload() {
    void this.controller?.load();
  },
  onMore() {
    void this.controller?.more();
  },
  onOpen(event: { currentTarget: { dataset: { id: string } } }) {
    void this.controller?.open(event.currentTarget.dataset.id);
  },
  onRead(event: { currentTarget: { dataset: { id: string } } }) {
    void this.controller?.acknowledge(event.currentTarget.dataset.id);
  },
  onCancel() {
    this.controller?.cancel();
  },
  onHide() {
    this.identityOverlay?.dispose();
    this.identityOverlay = undefined;
    this.overlayTargets = '';
    this.controller?.dispose();
    this.controller = undefined;
  },
  onUnload() {
    this.onHide();
  },
});
