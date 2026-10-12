import type { SessionStore } from '../auth/session';
import type { Clock } from '../platform/contracts';
import type { UploadFiles, WxUploadApi } from '../platform/wechat-upload';
import { MediaLocalFiles } from '../media/local-files';
import { OwnerImageUpload } from '../media/owner-image-upload';
import {
  decodeWindowDiscussionMediaGrant,
  decodeWindowDiscussionMediaObserved,
  type WindowDiscussionMediaGrant,
  type WindowDiscussionMediaObserved,
} from './media-contract';
/** Own protocol and endpoint. Only native picker/byte-transfer mechanics are shared. */
export class WindowDiscussionMediaUpload extends OwnerImageUpload<
  WindowDiscussionMediaGrant,
  WindowDiscussionMediaObserved
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
      decodeGrant: decodeWindowDiscussionMediaGrant,
      decodeObserved: decodeWindowDiscussionMediaObserved,
      path: (grant) =>
        `/v3/media/window-discussions/upload-intents/${grant.intentId}/uploads/${grant.grantId}`,
      matches: () => true,
    });
  }
}
