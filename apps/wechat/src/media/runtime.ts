import { MediaGalleryController, type GalleryView } from './gallery-controller';
import type { IdentityRuntime } from '../auth/runtime';
import type { PrivateViewLifecycle } from '../identity-privacy/overlay';
import type { Clock } from '../platform/contracts';
import { WechatMediaFiles, type WxMediaApi } from '../platform/wechat-media';
import {
  AuthenticatedMediaDownload,
  type MediaReadTransfer,
} from './authenticated-download';
import { MediaLocalFiles } from './local-files';
import { MediaReadController, type MediaReadView } from './read-controller';

export interface MediaReadRuntime {
  create(render: (view: MediaReadView) => void): MediaReadController;
  createGallery?(render: (view: GalleryView) => void): MediaGalleryController;
}
/** The gate requires real target-device headers/redirect/legitimate-domain acceptance.
 * Synthetic native bridges can test the implementation without enabling production. */
export function createMediaReadRuntime(
  identity: IdentityRuntime,
  wx: WxMediaApi,
  origin: string,
  clock: Clock,
  privateViews: PrivateViewLifecycle | undefined,
  verifiedNativeDownload = false,
  shared?: {
    readonly files: import('../platform/wechat-media').MediaFiles;
    readonly registry: MediaLocalFiles;
  },
): MediaReadRuntime {
  let transfer: MediaReadTransfer | undefined;
  if (
    verifiedNativeDownload &&
    identity.auth &&
    wx.downloadFile &&
    wx.getFileSystemManager &&
    wx.getImageInfo
  ) {
    try {
      const files = shared?.files ?? new WechatMediaFiles(wx, clock);
      const registry = shared?.registry ?? new MediaLocalFiles(files);
      transfer = new AuthenticatedMediaDownload(
        origin,
        wx,
        files,
        registry,
        identity.sessions,
        identity.auth,
        clock,
      );
    } catch {
      /* Invalid configuration remains explicitly unavailable. */
    }
  }
  return {
    createGallery: (render) =>
      new MediaGalleryController(
        identity.sessions,
        transfer,
        render,
        privateViews,
      ),
    create: (render) =>
      new MediaReadController(
        identity.sessions,
        transfer,
        render,
        privateViews,
      ),
  };
}
