import type { PoolClient } from 'pg';
export const VERIFICATION_EVIDENCE_ACCESS = Symbol(
  'VERIFICATION_EVIDENCE_ACCESS',
);
export interface VerificationEvidenceReadTarget {
  readonly applicationId: string;
  /** Immutable evidence revision, not the application's later command revision. */
  readonly revision: number;
  /** Required explicit target for reviewer access; null means own evidence. */
  readonly reviewRegionId: string | null;
}
/** Trusted Verification owner. All methods run in a managed transaction. The
 * owner enrolls bounded final session/account/campus/grant/Safety facts and
 * deadlines. Reviewers require current SchoolConfigurationAccess, never a
 * developer grant, and lose access immediately at an application terminal state. */
export interface VerificationEvidenceAccessPort {
  authorizePrepare(
    actorAccountId: string,
    applicationId: string,
    revision: number,
    tx: PoolClient,
  ): Promise<{
    readonly actorAccountId: string;
    readonly applicationId: string;
    readonly revision: number;
    readonly authorityVersion: string;
  }>;
  authorizeRead(
    token: string,
    target: VerificationEvidenceReadTarget,
    tx: PoolClient,
  ): Promise<{
    readonly accountId: string;
    readonly sessionId: string;
    readonly actorAccountId: string;
    readonly authorityVersion: string;
  }>;
  /** Refresh owner facts after Media writes only; never discard older read facts. */
  retainCurrent(applicationId: string, tx: PoolClient): Promise<void>;
}
