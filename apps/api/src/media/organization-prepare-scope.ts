import type { PoolClient } from 'pg';
import type { PrepareOrganizationMediaInput } from './contracts-organization.js';
import { MediaPrepareScopes } from './prepare-scope.js';
import { ApplicationError } from '../http/application-error.js';
export interface AuthorizedOrganizationMediaEdit {
  readonly actorAccountId: string;
  readonly serverScopeId: string;
  readonly scopeRevision: string;
  readonly expiresAt: number;
  readonly ownerKind: 'organizations';
  readonly resourceKind: 'organization_image';
  readonly targetKind: 'edit';
  readonly contentVersion: 1;
  readonly audience: 'organization-gated';
  readonly purpose: 'organization-image';
  readonly slot: import('./contracts-organization.js').OrganizationMediaSlot;
  readonly ordinal: 0;
}
export interface OrganizationMediaDraftOwnerPort {
  /** Current organization role/session/Safety, application CAS and mandatory final owner proof. */
  authorizePrepare(
    actor: string,
    input: PrepareOrganizationMediaInput,
    tx: PoolClient,
  ): Promise<AuthorizedOrganizationMediaEdit>;
}
export class MediaOrganizationPrepareScopes extends MediaPrepareScopes {
  constructor(owner: OrganizationMediaDraftOwnerPort) {
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
      owner,
    );
  }
}
