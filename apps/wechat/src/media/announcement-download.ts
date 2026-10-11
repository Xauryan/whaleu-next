import { ClientError } from '../api/errors';
import type { AuthService } from '../auth/auth-service';
import type { Clock } from '../platform/contracts';
import type { MediaFiles, WxMediaApi } from '../platform/wechat-media';
import { MediaLocalFiles } from './local-files';
import { OwnerImageDownload } from './owner-image-download';
import { OptionalMediaPrincipalOwner } from './optional-principal';
import { exact } from '../community/contract';
import {
  invalidAnnouncementMedia,
  announcementMediaUuid,
} from './announcement-validation';
import {
  decodeAnnouncementMediaDescriptor,
  type AnnouncementMediaDescriptor,
} from './announcement-contract';
export interface AnnouncementMediaReadTarget {
  readonly announcementId: string;
  readonly audience: 'public' | 'management';
  readonly campusId: string | null;
}
export interface AnnouncementMediaDownloadInput {
  readonly descriptor: AnnouncementMediaDescriptor;
  readonly target: AnnouncementMediaReadTarget;
}
export class AnnouncementMediaPrincipalOwner extends OptionalMediaPrincipalOwner {}
export class AnnouncementMediaDownload extends OwnerImageDownload<AnnouncementMediaDownloadInput> {
  override async download(
    ...args: Parameters<
      OwnerImageDownload<AnnouncementMediaDownloadInput>['download']
    >
  ) {
    if (
      args[0].target.audience === 'management' &&
      args[3].current().kind !== 'session'
    )
      throw new ClientError('auth-required', '请先登录管理公告图片');
    return super.download(...args);
  }
  constructor(
    origin: string,
    wx: WxMediaApi,
    files: MediaFiles,
    registry: MediaLocalFiles,
    principals: AnnouncementMediaPrincipalOwner,
    auth: Pick<AuthService, 'refresh'>,
    clock: Clock,
  ) {
    super(origin, wx, files, registry, principals, auth, clock, {
      decode: (raw) => {
        exact(raw, ['descriptor', 'target']);
        const descriptor = decodeAnnouncementMediaDescriptor(raw.descriptor);
        exact(raw.target, ['announcementId', 'audience', 'campusId']);
        const campusId =
          raw.target.campusId === null
            ? null
            : announcementMediaUuid(raw.target.campusId);
        if (
          announcementMediaUuid(raw.target.announcementId) !==
            descriptor.announcementId ||
          (raw.target.audience === 'management' && campusId !== null) ||
          (raw.target.audience !== 'public' &&
            raw.target.audience !== 'management')
        )
          invalidAnnouncementMedia();
        return {
          descriptor,
          target: {
            announcementId: descriptor.announcementId,
            audience: raw.target.audience,
            campusId,
          },
        };
      },
      shape: (value) => value.descriptor,
      path: ({ descriptor: d, target }, variant) =>
        `/v3/media/announcements/${target.audience}/announcements/${d.announcementId}/slots/${d.slot}/bindings/${d.bindingId}/${variant}`,
      query: ({ descriptor: d, target }) => ({
        revision: d.revision,
        ...(target.campusId === null ? {} : { campusId: target.campusId }),
      }),
    });
  }
}
