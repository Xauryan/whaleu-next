import type { SessionStore } from '../auth/session';
import type { Clock } from '../platform/contracts';
import type { UploadFiles, WxUploadApi } from '../platform/wechat-upload';
import { MediaLocalFiles } from './local-files';
import { OwnerImageUpload } from './owner-image-upload';
import {
  decodeAnnouncementMediaGrant,
  decodeAnnouncementMediaObserved,
  type AnnouncementMediaGrant,
  type AnnouncementMediaObserved,
} from './announcement-contract';
/** Own protocol and endpoint. Only native picker/byte-transfer mechanics are shared. */
export class AnnouncementMediaUpload extends OwnerImageUpload<
  AnnouncementMediaGrant,
  AnnouncementMediaObserved
> {
  constructor(
    origin: string,
    wx: WxUploadApi,
    files: UploadFiles,
    registry: MediaLocalFiles,
    sessions: SessionStore,
    clock: Clock,
  ) {
    super(origin, wx, files, registry, sessions, clock, {
      decodeGrant: decodeAnnouncementMediaGrant,
      decodeObserved: decodeAnnouncementMediaObserved,
      path: (grant) =>
        `/v3/media/announcements/upload-intents/${grant.intentId}/uploads/${grant.grantId}`,
      matches: () => true,
    });
  }
}
