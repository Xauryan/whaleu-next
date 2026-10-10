import type { AuthService } from '../auth/auth-service';
import type { SessionStore } from '../auth/session';
import type { MediaLocalFiles } from '../media/local-files';
import type { Clock } from '../platform/contracts';
import type { WxMediaApi } from '../platform/wechat-media';
import type { UploadFiles, WxUploadApi } from '../platform/wechat-upload';
import { RatingDiscussionUpload } from './discussion-media-upload';
import { RatingDiscussionDownload } from './discussion-media-download';
/** Explicit synthetic/device injection. The caller must pass the SAME registry
 * used by Community, Profile and target cover; no fresh owner budget exists. */
export function createRatingDiscussionNativeTestAdapters(options: {
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
    upload: new RatingDiscussionUpload(
      options.origin,
      options.wxUpload,
      options.files,
      options.registry,
      options.sessions,
      options.clock,
    ),
    download: new RatingDiscussionDownload(
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
