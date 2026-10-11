import type { PoolClient } from 'pg';
import type { PrepareAnnouncementMediaInput } from './contracts-announcement.js';
import { MediaPrepareScopes } from './prepare-scope.js';
import { ApplicationError } from '../http/application-error.js';
export interface AuthorizedAnnouncementMediaEdit {
  readonly actorAccountId: string;
  readonly serverScopeId: string;
  readonly scopeRevision: string;
  readonly expiresAt: number;
  readonly ownerKind: 'announcements';
  readonly resourceKind: 'announcement_image';
  readonly targetKind: 'edit';
  readonly contentVersion: 1;
  readonly audience: 'announcement-gated';
  readonly purpose: 'announcement-image';
  readonly slot: import('./contracts-announcement.js').AnnouncementMediaSlot;
  readonly ordinal: 0;
}
export interface AnnouncementMediaDraftOwnerPort {
  /** Current announcement role/session/Safety, application CAS and mandatory final owner proof. */
  authorizePrepare(
    actor: string,
    input: PrepareAnnouncementMediaInput,
    tx: PoolClient,
  ): Promise<AuthorizedAnnouncementMediaEdit>;
}
export class MediaAnnouncementPrepareScopes extends MediaPrepareScopes {
  constructor(owner: AnnouncementMediaDraftOwnerPort) {
    super(
      {
        authorizePrepare: async () => {
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      owner,
    );
  }
}
