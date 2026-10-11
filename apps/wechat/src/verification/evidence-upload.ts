import type { SessionStore } from '../auth/session';
import type { Clock } from '../platform/contracts';
import type { UploadFiles, WxUploadApi } from '../platform/wechat-upload';
import { MediaLocalFiles } from '../media/local-files';
import { OwnerImageUpload } from '../media/owner-image-upload';
import {
  decodeVerificationEvidenceGrant,
  decodeVerificationEvidenceObserved,
  type VerificationEvidenceGrant,
  type VerificationEvidenceObserved,
} from './evidence-contract';
/** Own protocol and endpoint. Only native picker/byte-transfer mechanics are shared. */
export class VerificationEvidenceUpload extends OwnerImageUpload<
  VerificationEvidenceGrant,
  VerificationEvidenceObserved
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
      decodeGrant: decodeVerificationEvidenceGrant,
      decodeObserved: decodeVerificationEvidenceObserved,
      path: (grant) =>
        `/v3/media/verification-evidence/upload-intents/${grant.intentId}/uploads/${grant.grantId}`,
      matches: () => true,
    });
  }
}
