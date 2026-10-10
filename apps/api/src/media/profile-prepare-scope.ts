import type { PoolClient } from 'pg';
import type { PrepareProfileMediaInput } from './contracts-profile.js';
import { MediaPrepareScopes } from './prepare-scope.js';
import { ApplicationError } from '../http/application-error.js';

export interface AuthorizedProfileMediaEdit {
  readonly actorAccountId: string;
  readonly serverScopeId: string;
  readonly scopeRevision: string;
  readonly expiresAt: number;
  readonly ownerKind: 'profile';
  readonly resourceKind: 'avatar';
  readonly targetKind: 'edit';
  readonly contentVersion: 1;
  readonly audience: 'profile-public';
  readonly purpose: 'profile-avatar-image';
  readonly slot: 'avatar';
  readonly ordinal: 0;
}
export interface ProfileMediaDraftOwnerPort {
  authorizePrepare(
    actor: string,
    input: PrepareProfileMediaInput,
    tx: PoolClient,
  ): Promise<AuthorizedProfileMediaEdit>;
}
/** DI-only Profile issuer; legacy Community input is never accepted. */
export class MediaProfilePrepareScopes extends MediaPrepareScopes {
  constructor(owner: ProfileMediaDraftOwnerPort) {
    super(
      {
        authorizePrepare: async () => {
          throw new ApplicationError('MEDIA_UNAVAILABLE');
        },
      },
      owner,
    );
  }
}
