import type { SessionStore } from '../auth/session';
import type { Clock } from '../platform/contracts';
import type { UploadFiles, WxUploadApi } from '../platform/wechat-upload';
import { MediaLocalFiles } from '../media/local-files';
import { OwnerImageUpload } from '../media/owner-image-upload';
import {
  decodeSchoolQrGrant,
  decodeSchoolQrObserved,
  type SchoolQrGrant,
  type SchoolQrObserved,
} from './qr-contract';
/** Own protocol and endpoint. Only native picker/byte-transfer mechanics are shared. */
export class SchoolQrUpload extends OwnerImageUpload<
  SchoolQrGrant,
  SchoolQrObserved
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
      decodeGrant: decodeSchoolQrGrant,
      decodeObserved: decodeSchoolQrObserved,
      path: (grant) =>
        `/v3/media/school-configuration/upload-intents/${grant.intentId}/uploads/${grant.grantId}`,
      matches: () => true,
    });
  }
}
