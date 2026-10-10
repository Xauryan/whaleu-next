import type { AuthService } from '../auth/auth-service';
import type { SessionStore } from '../auth/session';
import type { PrivateViewLifecycle } from '../identity-privacy/overlay';
import type { Clock } from '../platform/contracts';
import type { WxMediaApi } from '../platform/wechat-media';
import type { UploadFiles, WxUploadApi } from '../platform/wechat-upload';
import { AuthenticatedMediaDownload } from './authenticated-download';
import { AuthenticatedMediaUpload } from './authenticated-upload';
import { MediaLocalFiles } from './local-files';
import { MediaReadController } from './read-controller';
import { MediaGalleryController } from './gallery-controller';
import type { MediaReadRuntime } from './runtime';
/** Explicit local-test DI composition, never imported by AppModule or App.
 * Both native directions share exactly one file/reservation/transfer registry.
 * This proves no real-device redirect/header/domain or provider acceptance. */
export function createBatchNativeTestAdapters(options: {
  origin: string;
  wxDownload: WxMediaApi;
  wxUpload: WxUploadApi;
  files: UploadFiles;
  sessions: SessionStore;
  auth: Pick<AuthService, 'refresh'>;
  clock: Clock;
  privateViews?: PrivateViewLifecycle;
}) {
  const { origin, sessions, auth, clock, files, privateViews } = options;
  const registry = new MediaLocalFiles(files);
  const upload = new AuthenticatedMediaUpload(
    origin,
    options.wxUpload,
    files,
    registry,
    sessions,
    clock,
    auth,
    3,
  );
  const discussionUpload = new AuthenticatedMediaUpload(
    origin,
    options.wxUpload,
    files,
    registry,
    sessions,
    clock,
    auth,
    4,
  );
  const download = new AuthenticatedMediaDownload(
    origin,
    options.wxDownload,
    files,
    registry,
    sessions,
    auth,
    clock,
  );
  const read: MediaReadRuntime = {
    create: (render) =>
      new MediaReadController(sessions, download, render, privateViews),
    createGallery: (render) =>
      new MediaGalleryController(sessions, download, render, privateViews),
  };
  return { registry, upload, discussionUpload, download, read };
}
