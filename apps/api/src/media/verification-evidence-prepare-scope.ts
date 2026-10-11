import type { PoolClient } from 'pg';
import type { PrepareVerificationEvidenceMediaInput } from './contracts-verification-evidence.js';
import { MediaPrepareScopes } from './prepare-scope.js';
import { ApplicationError } from '../http/application-error.js';
export interface AuthorizedVerificationEvidenceMediaEdit {
  readonly actorAccountId: string;
  readonly serverScopeId: string;
  readonly scopeRevision: string;
  readonly expiresAt: number;
  readonly ownerKind: 'verification';
  readonly resourceKind: 'student_evidence';
  readonly targetKind: 'edit';
  readonly contentVersion: 1;
  readonly audience: 'verification-private';
  readonly purpose: 'verification-evidence-image';
  readonly slot: 'evidence';
  readonly ordinal: 0;
}
export interface VerificationEvidenceMediaDraftOwnerPort {
  /** Current verificationEvidence role/session/Safety, application CAS and mandatory final owner proof. */
  authorizePrepare(
    actor: string,
    input: PrepareVerificationEvidenceMediaInput,
    tx: PoolClient,
  ): Promise<AuthorizedVerificationEvidenceMediaEdit>;
}
export class MediaVerificationEvidencePrepareScopes extends MediaPrepareScopes {
  constructor(owner: VerificationEvidenceMediaDraftOwnerPort) {
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
      owner,
    );
  }
}
