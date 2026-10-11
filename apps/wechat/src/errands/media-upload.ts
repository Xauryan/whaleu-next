import type { SessionStore } from '../auth/session';
import type { Clock } from '../platform/contracts';
import type { UploadFiles, WxUploadApi } from '../platform/wechat-upload';
import { MediaLocalFiles } from '../media/local-files';
import { OwnerImageUpload } from '../media/owner-image-upload';
import {
  decodeErrandMediaGrant,
  decodeErrandMediaObserved,
  type ErrandMediaGrant,
  type ErrandMediaObserved,
} from './media-contract';
/** Own protocol and endpoint. Only native picker/byte-transfer mechanics are shared. */
export class ErrandMediaUpload extends OwnerImageUpload<
  ErrandMediaGrant,
  ErrandMediaObserved
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
      decodeGrant: decodeErrandMediaGrant,
      decodeObserved: decodeErrandMediaObserved,
      path: (grant) =>
        `/v3/media/errands/upload-intents/${grant.intentId}/uploads/${grant.grantId}`,
      matches: () => true,
    });
  }
}
