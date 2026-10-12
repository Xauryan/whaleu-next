import { ClientError } from '../api/errors';
import type { AuthService } from '../auth/auth-service';
import type { Clock } from '../platform/contracts';
import type { MediaFiles, WxMediaApi } from '../platform/wechat-media';
import type { MediaLocalFiles } from '../media/local-files';
import { OwnerImageDownload } from '../media/owner-image-download';
import { OptionalMediaPrincipalOwner } from '../media/optional-principal';
import {
  decodeMajorDiscussionMediaDescriptor,
  type MajorDiscussionMediaDescriptor,
} from './media-contract';
export class MajorDiscussionMediaPrincipalOwner extends OptionalMediaPrincipalOwner {}
export class MajorDiscussionMediaDownload extends OwnerImageDownload<MajorDiscussionMediaDescriptor> {
  override async download(
    ...args: Parameters<
      OwnerImageDownload<MajorDiscussionMediaDescriptor>['download']
    >
  ) {
    if (args[3].current().kind !== 'session')
      throw new ClientError('auth-required', '请先登录查看专业讨论图片');
    return super.download(...args);
  }
  constructor(
    origin: string,
    wx: WxMediaApi,
    files: MediaFiles,
    registry: MediaLocalFiles,
    principals: MajorDiscussionMediaPrincipalOwner,
    auth: Pick<AuthService, 'refresh'>,
    clock: Clock,
  ) {
    super(origin, wx, files, registry, principals, auth, clock, {
      decode: decodeMajorDiscussionMediaDescriptor,
      shape: (v) => v,
      path: (v, variant) =>
        `/v3/media/major-discussions/majors/${v.majorId}/comments/${v.commentId}/bindings/${v.bindingId}/${variant}`,
      query: (v) => ({ ordinal: v.ordinal }),
    });
  }
}
