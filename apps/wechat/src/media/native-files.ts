import type { Clock, Cancellation } from '../platform/contracts';
import { WechatMediaFiles, type WxMediaApi } from '../platform/wechat-media';
import {
  WechatUploadFiles,
  type UploadFiles,
  type WxUploadApi,
} from '../platform/wechat-upload';
/** Shared filesystem capability for upload inspection and authenticated
 * download error handling; all leases still belong to one MediaLocalFiles. */
export class WechatNativeMediaFiles implements UploadFiles {
  private readonly upload: WechatUploadFiles;
  private readonly download: WechatMediaFiles;
  constructor(wx: WxMediaApi & WxUploadApi, clock: Clock) {
    this.upload = new WechatUploadFiles(wx, clock);
    this.download = new WechatMediaFiles(wx, clock);
  }
  stat(path: string) {
    return this.upload.stat(path);
  }
  image(path: string) {
    return this.upload.image(path);
  }
  unlink(path: string) {
    return this.upload.unlink(path);
  }
  readError(path: string, size: number) {
    return this.download.readError(path, size);
  }
  digest(
    path: string,
    bytes: number,
    current: () => void,
    cancel: Cancellation,
  ) {
    return this.upload.digest(path, bytes, current, cancel);
  }
}
