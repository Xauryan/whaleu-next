import type { AuthService } from '../auth/auth-service';
import type { SessionStore } from '../auth/session';
import type { Clock } from '../platform/contracts';
import type { WxMediaApi } from '../platform/wechat-media';
import type { UploadFiles, WxUploadApi } from '../platform/wechat-upload';
import type { MediaLocalFiles } from '../media/local-files';
import { RatingCoverDownload } from './target-cover-download';
import { RatingCoverUpload } from './target-cover-upload';
/** Explicit synthetic/device DI only. The caller passes the SAME page registry
 * as Community and Profile; no private account, queue, or multiplied byte budget. */
export function createRatingCoverNativeTestAdapters(options: {
  origin: string;
  wxDownload: WxMediaApi;
  wxUpload: WxUploadApi;
  files: UploadFiles;
  registry: MediaLocalFiles;
  sessions: SessionStore;
  auth: Pick<AuthService, 'refresh'>;
  clock: Clock;
}) {
  return {
    registry: options.registry,
    upload: new RatingCoverUpload(
      options.origin,
      options.wxUpload,
      options.files,
      options.registry,
      options.sessions,
      options.clock,
      options.auth,
    ),
    download: new RatingCoverDownload(
      options.origin,
      options.wxDownload,
      options.files,
      options.registry,
      options.sessions,
      options.auth,
      options.clock,
    ),
  };
}
