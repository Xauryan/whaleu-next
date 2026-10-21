import { ClientError } from '../api/errors';
import type { AuthService } from '../auth/auth-service';
import { CoverPrincipalOwner } from './cover-principal';
import type { CoverReadTransfer } from './cover-read-controller';
import { decodeCurrentCover, type CurrentCover } from './cover-contract';
import type { Clock } from '../platform/contracts';
import type { MediaFiles, WxMediaApi } from '../platform/wechat-media';
import { MediaLocalFiles } from '../media/local-files';
import { OwnerImageDownload } from '../media/owner-image-download';
/** Profile authority remains its exact current-cover decoder and original route. */
export class ProfileCoverDownload
  extends OwnerImageDownload<CurrentCover>
  implements CoverReadTransfer
{
  constructor(
    origin: string,
    wx: WxMediaApi,
    files: MediaFiles,
    registry: MediaLocalFiles,
    principals: CoverPrincipalOwner,
    auth: Pick<AuthService, 'refresh'>,
    clock: Clock,
  ) {
    super(origin, wx, files, registry, principals, auth, clock, {
      decode: decodeCurrentCover,
      shape: (value) => {
        if (value.cover.state !== 'available' || value.profileId === null)
          throw new ClientError('protocol', 'Current cover is not available');
        return value.cover;
      },
      path: (value, variant) => {
        if (value.cover.state !== 'available' || value.profileId === null)
          throw new ClientError('protocol', 'Current cover is not available');
        return `/v1/profiles/${value.profileId}/cover/${value.cover.appearanceId}/${variant}`;
      },
    });
  }
}
