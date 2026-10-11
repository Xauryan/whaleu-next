import type { PoolClient } from 'pg';
import type { PrepareActivityMediaInput } from './contracts-activity.js';
import { MediaPrepareScopes } from './prepare-scope.js';
import { ApplicationError } from '../http/application-error.js';
export interface AuthorizedActivityMediaEdit {
  readonly actorAccountId: string;
  readonly serverScopeId: string;
  readonly scopeRevision: string;
  readonly expiresAt: number;
  readonly ownerKind: 'activities';
  readonly resourceKind: 'activity_image';
  readonly targetKind: 'edit';
  readonly contentVersion: 1;
  readonly audience: 'activity-gated';
  readonly purpose: 'activity-image';
  readonly slot: import('./contracts-activity.js').ActivityMediaSlot;
  readonly ordinal: 0;
}
export interface ActivityMediaDraftOwnerPort {
  /** Current activity role/session/Safety, application CAS and mandatory final owner proof. */
  authorizePrepare(
    actor: string,
    input: PrepareActivityMediaInput,
    tx: PoolClient,
  ): Promise<AuthorizedActivityMediaEdit>;
}
export class MediaActivityPrepareScopes extends MediaPrepareScopes {
  constructor(owner: ActivityMediaDraftOwnerPort) {
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
      owner,
    );
  }
}
