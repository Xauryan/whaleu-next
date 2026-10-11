import type { IdentityRuntime } from '../auth/runtime';
import type { CommunityRuntime } from '../community/runtime';
import type { MediaLocalFiles } from '../media/local-files';
import type { Clock } from '../platform/contracts';
import type { WxMediaApi } from '../platform/wechat-media';
import type { UploadFiles, WxUploadApi } from '../platform/wechat-upload';
import { CategoryIconUpload } from './category-icon-upload';
import { CategoryIconDownload } from './category-icon-download';
/** Ordinary native app assembly, not an activation fact. Server context5,
 * capability, composite Category Review and default-null Media runtime still gate every
 * operation. All owners receive the same application-level file registry. */
export function connectCategoryIconNative(
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
    ratingCategoryIconUpload: new CategoryIconUpload(
      origin,
      wx,
      files,
      registry,
      identity.sessions,
      clock,
    ),
    ratingCategoryIconDownload: new CategoryIconDownload(
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
