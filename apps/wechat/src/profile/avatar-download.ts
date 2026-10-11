import { ClientError } from '../api/errors';
import type { AuthService } from '../auth/auth-service';
import { AvatarPrincipalOwner } from './avatar-principal';
import type { AvatarReadTransfer } from './avatar-read-controller';
import { decodeCurrentAvatar, type CurrentAvatar } from './avatar-contract';
import type { Clock } from '../platform/contracts';
import type { MediaFiles, WxMediaApi } from '../platform/wechat-media';
import { MediaLocalFiles } from '../media/local-files';
import { OwnerImageDownload } from '../media/owner-image-download';
/** Profile authority remains its exact current-avatar decoder and original route. */
export class ProfileAvatarDownload
  extends OwnerImageDownload<CurrentAvatar>
  implements AvatarReadTransfer
{
  constructor(
    origin: string,
    wx: WxMediaApi,
    files: MediaFiles,
    registry: MediaLocalFiles,
    principals: AvatarPrincipalOwner,
    auth: Pick<AuthService, 'refresh'>,
    clock: Clock,
  ) {
    super(origin, wx, files, registry, principals, auth, clock, {
      decode: decodeCurrentAvatar,
      shape: (value) => {
        if (value.avatar.state !== 'available' || value.profileId === null)
          throw new ClientError('protocol', 'Current avatar is not available');
        return value.avatar;
      },
      path: (value, variant) => {
        if (value.avatar.state !== 'available' || value.profileId === null)
          throw new ClientError('protocol', 'Current avatar is not available');
        return `/v1/profiles/${value.profileId}/avatar/${value.avatar.appearanceId}/${variant}`;
      },
    });
  }
}
