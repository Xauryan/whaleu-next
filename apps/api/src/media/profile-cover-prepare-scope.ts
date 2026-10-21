import type { PoolClient } from 'pg';
import type { PrepareProfileCoverMediaInput } from './contracts-profile-cover.js';
import { MediaPrepareScopes } from './prepare-scope.js';
import { ApplicationError } from '../http/application-error.js';

export interface AuthorizedProfileCoverMediaEdit {
  readonly actorAccountId: string;
  readonly serverScopeId: string;
  readonly scopeRevision: string;
  readonly expiresAt: number;
  readonly ownerKind: 'profile';
  readonly resourceKind: 'cover';
  readonly targetKind: 'edit';
  readonly contentVersion: 1;
  readonly audience: 'profile-public';
  readonly purpose: 'profile-cover-image';
  readonly slot: 'cover';
  readonly ordinal: 0;
}
export interface ProfileCoverMediaDraftOwnerPort {
  authorizePrepare(
    actor: string,
    input: PrepareProfileCoverMediaInput,
    tx: PoolClient,
  ): Promise<AuthorizedProfileCoverMediaEdit>;
}
/** DI-only Profile issuer; legacy Community input is never accepted. */
export class MediaProfileCoverPrepareScopes extends MediaPrepareScopes {
  constructor(owner: ProfileCoverMediaDraftOwnerPort) {
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
