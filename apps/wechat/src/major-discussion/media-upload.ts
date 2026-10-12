import type { SessionStore } from '../auth/session';
import type { Clock } from '../platform/contracts';
import type { UploadFiles, WxUploadApi } from '../platform/wechat-upload';
import { MediaLocalFiles } from '../media/local-files';
import { OwnerImageUpload } from '../media/owner-image-upload';
import {
  decodeMajorDiscussionMediaGrant,
  decodeMajorDiscussionMediaObserved,
  type MajorDiscussionMediaGrant,
  type MajorDiscussionMediaObserved,
} from './media-contract';
/** Own protocol and endpoint. Only native picker/byte-transfer mechanics are shared. */
export class MajorDiscussionMediaUpload extends OwnerImageUpload<
  MajorDiscussionMediaGrant,
  MajorDiscussionMediaObserved
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
      decodeGrant: decodeMajorDiscussionMediaGrant,
      decodeObserved: decodeMajorDiscussionMediaObserved,
      path: (grant) =>
        `/v3/media/major-discussions/upload-intents/${grant.intentId}/uploads/${grant.grantId}`,
      matches: () => true,
    });
  }
}
