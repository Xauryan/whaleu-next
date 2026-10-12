import { ClientError } from '../api/errors';
import type { AuthService } from '../auth/auth-service';
import type { Clock } from '../platform/contracts';
import type { MediaFiles, WxMediaApi } from '../platform/wechat-media';
import type { MediaLocalFiles } from '../media/local-files';
import { OwnerImageDownload } from '../media/owner-image-download';
import { OptionalMediaPrincipalOwner } from '../media/optional-principal';
import {
  decodeWindowDiscussionMediaDescriptor,
  type WindowDiscussionMediaDescriptor,
} from './media-contract';
export class WindowDiscussionMediaPrincipalOwner extends OptionalMediaPrincipalOwner {}
export class WindowDiscussionMediaDownload extends OwnerImageDownload<WindowDiscussionMediaDescriptor> {
  override async download(
    ...args: Parameters<
      OwnerImageDownload<WindowDiscussionMediaDescriptor>['download']
    >
  ) {
    if (args[3].current().kind !== 'session')
      throw new ClientError('auth-required', '请先登录查看窗口讨论图片');
    return super.download(...args);
  }
  constructor(
    origin: string,
    wx: WxMediaApi,
    files: MediaFiles,
    registry: MediaLocalFiles,
    principals: WindowDiscussionMediaPrincipalOwner,
    auth: Pick<AuthService, 'refresh'>,
    clock: Clock,
  ) {
    super(origin, wx, files, registry, principals, auth, clock, {
      decode: decodeWindowDiscussionMediaDescriptor,
      shape: (v) => v,
      path: (v, variant) =>
        `/v3/media/window-discussions/windows/${v.windowId}/comments/${v.commentId}/bindings/${v.bindingId}/${variant}`,
      query: (v) => ({ ordinal: v.ordinal }),
    });
  }
}
