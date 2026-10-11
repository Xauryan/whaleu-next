import type { PoolClient } from 'pg';
import { requiredOwnerEpoch } from '../database/required-owner-proof.js';
import { MediaRequiredProof, mediaCountProofOwner } from './required-proof.js';
/** New owner tables participate in the existing Media epoch, only typed13 paths
 * fence them. Historical schemas never acquire a new table dependency. */
export class VerificationEvidenceMediaRequiredProof extends MediaRequiredProof {
  private readonly enrollVerificationEvidence = requiredOwnerEpoch(
    {
      ...mediaCountProofOwner,
      fence: async (tx) => {
        if (!(await mediaCountProofOwner.fence(tx))) return false;
        await tx.query(
          'LOCK TABLE whaleu_media.verification_evidence_scopes,whaleu_media.verification_evidence_bindings,whaleu_media.verification_evidence_retirements IN SHARE MODE NOWAIT',
        );
        return true;
      },
    },
    'MEDIA_UNAVAILABLE',
  );
  override capture(tx: PoolClient) {
    return this.enrollVerificationEvidence(tx);
  }
}
