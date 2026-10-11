import type { SessionStore, SessionTicket } from '../auth/session';
import type { LocalMediaFile, MediaSession } from '../media/contracts';
import { MediaLocalFiles } from '../media/local-files';
import { OwnerImageUpload } from '../media/owner-image-upload';
import type { Cancellation, Clock } from '../platform/contracts';
import type { UploadFiles, WxUploadApi } from '../platform/wechat-upload';
import type { CategoryIconWindowTransfer } from './category-icon-window';
import {
  decodeCategoryIconGrant,
  decodeCategoryIconUploadObserved,
  type CategoryIconGrant,
  type CategoryIconUploadObserved,
} from './category-icon-media-contract';
export interface CategoryIconNativeEffect {
  readonly result: Promise<CategoryIconUploadObserved>;
  readonly complete: Promise<void>;
}
export interface CategoryIconUploadTransfer extends CategoryIconWindowTransfer {
  upload(
    grant: CategoryIconGrant,
    file: LocalMediaFile,
    session: MediaSession,
    cancel: Cancellation,
    progress: (percent: number) => void,
  ): Promise<CategoryIconNativeEffect>;
  settled(accountId: string): boolean;
  clearSession(ticket: SessionTicket): void;
}
/** Existing Category protocol retains its exact decoder, scope tuple and route. */
export class CategoryIconUpload
  extends OwnerImageUpload<CategoryIconGrant, CategoryIconUploadObserved>
  implements CategoryIconUploadTransfer
{
  constructor(
    origin: string,
    wx: WxUploadApi,
    files: UploadFiles,
    localFiles: MediaLocalFiles,
    sessions: SessionStore,
    clock: Clock,
  ) {
    super(origin, wx, files, localFiles, sessions, clock, {
      decodeGrant: decodeCategoryIconGrant,
      decodeObserved: decodeCategoryIconUploadObserved,
      path: (grant) =>
        `/v3/media/ratings-category-icon/upload-scopes/${grant.editScopeId}/uploads/${grant.grantId}`,
      matches: (grant, receipt) => receipt.editScopeId === grant.editScopeId,
    });
  }
}
