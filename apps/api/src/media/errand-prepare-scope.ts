import type { PoolClient } from 'pg';
import type { PrepareErrandMediaInput } from './contracts-errand.js';
import { MediaPrepareScopes } from './prepare-scope.js';
import { ApplicationError } from '../http/application-error.js';
export interface AuthorizedErrandMediaEdit {
  readonly actorAccountId: string;
  readonly serverScopeId: string;
  readonly scopeRevision: string;
  readonly expiresAt: number;
  readonly ownerKind: 'errands';
  readonly resourceKind: 'errand_image';
  readonly targetKind: 'edit';
  readonly contentVersion: 1;
  readonly audience: 'errand-public' | 'errand-private';
  readonly purpose: 'errand-public-image' | 'errand-private-image';
  readonly slot: import('./contracts-errand.js').ErrandMediaSlot;
  readonly ordinal: 0;
}
export interface ErrandMediaDraftOwnerPort {
  /** Current errand role/session/Safety, application CAS and mandatory final owner proof. */
  authorizePrepare(
    actor: string,
    input: PrepareErrandMediaInput,
    tx: PoolClient,
  ): Promise<AuthorizedErrandMediaEdit>;
}
export class MediaErrandPrepareScopes extends MediaPrepareScopes {
  constructor(owner: ErrandMediaDraftOwnerPort) {
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
      owner,
    );
  }
}
