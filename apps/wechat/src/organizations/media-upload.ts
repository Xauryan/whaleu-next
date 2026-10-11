import type { SessionStore } from '../auth/session';
import type { Clock } from '../platform/contracts';
import type { UploadFiles, WxUploadApi } from '../platform/wechat-upload';
import { MediaLocalFiles } from '../media/local-files';
import { OwnerImageUpload } from '../media/owner-image-upload';
import {
  decodeOrganizationMediaGrant,
  decodeOrganizationMediaObserved,
  type OrganizationMediaGrant,
  type OrganizationMediaObserved,
} from './media-contract';
/** Own protocol and endpoint. Only native picker/byte-transfer mechanics are shared. */
export class OrganizationMediaUpload extends OwnerImageUpload<
  OrganizationMediaGrant,
  OrganizationMediaObserved
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
      decodeGrant: decodeOrganizationMediaGrant,
      decodeObserved: decodeOrganizationMediaObserved,
      path: (grant) =>
        `/v3/media/organizations/upload-intents/${grant.intentId}/uploads/${grant.grantId}`,
      matches: () => true,
    });
  }
}
