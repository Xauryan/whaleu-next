import type { IdentityRuntime } from '../auth/runtime';
import type { CommunityRuntime } from '../community/runtime';
import type { MediaLocalFiles } from '../media/local-files';
import type { Clock } from '../platform/contracts';
import type { WxMediaApi } from '../platform/wechat-media';
import type { UploadFiles, WxUploadApi } from '../platform/wechat-upload';
import { RatingDiscussionUpload } from './discussion-media-upload';
import { RatingDiscussionDownload } from './discussion-media-download';
/** Ordinary native app assembly, not an activation fact. Server context4,
 * capability, whole-set Review and default-null Media runtime still gate every
 * operation. All owners receive the same application-level file registry. */
export function connectRatingDiscussionNative(
  runtime: CommunityRuntime,
  identity: IdentityRuntime,
  wx: WxMediaApi & WxUploadApi,
  origin: string,
  files: UploadFiles,
  registry: MediaLocalFiles,
  clock: Clock,
): CommunityRuntime {
  if (
    !identity.api ||
    !identity.auth ||
    !wx.chooseMedia ||
    !wx.uploadFile ||
    !wx.downloadFile ||
    !wx.getImageInfo ||
    !wx.getFileSystemManager
  )
    return runtime;
  return {
    ...runtime,
    ratingDiscussionUpload: new RatingDiscussionUpload(
      origin,
      wx,
      files,
      registry,
      identity.sessions,
      clock,
    ),
    ratingDiscussionDownload: new RatingDiscussionDownload(
      origin,
      wx,
      files,
      registry,
      identity.sessions,
      identity.auth,
      clock,
    ),
  };
}
