import type { PoolClient } from 'pg';
import type { PrepareSchoolQrMediaInput } from './contracts-school-qr.js';
import { MediaPrepareScopes } from './prepare-scope.js';
import { ApplicationError } from '../http/application-error.js';
export interface AuthorizedSchoolQrMediaEdit {
  readonly actorAccountId: string;
  readonly serverScopeId: string;
  readonly scopeRevision: string;
  readonly expiresAt: number;
  readonly ownerKind: 'school_configuration';
  readonly resourceKind: 'entry_qr';
  readonly targetKind: 'edit';
  readonly contentVersion: 1;
  readonly audience: 'school-config-gated';
  readonly purpose: 'school-configuration-qr-image';
  readonly slot: 'qr';
  readonly ordinal: 0;
}
export interface SchoolQrMediaDraftOwnerPort {
  /** Current school management/session/Safety, entry CAS and mandatory final owner proof. */
  authorizePrepare(
    actor: string,
    input: PrepareSchoolQrMediaInput,
    tx: PoolClient,
  ): Promise<AuthorizedSchoolQrMediaEdit>;
}
export class MediaSchoolQrPrepareScopes extends MediaPrepareScopes {
  constructor(owner: SchoolQrMediaDraftOwnerPort) {
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
      owner,
    );
  }
}
