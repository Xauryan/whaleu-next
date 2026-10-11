import type { PoolClient } from 'pg';
import { requiredOwnerEpoch } from '../database/required-owner-proof.js';
import { MediaRequiredProof, mediaCountProofOwner } from './required-proof.js';
/** New owner tables participate in the existing Media epoch, only typed9 paths
 * fence them. Historical schemas never acquire a new table dependency. */
export class SchoolQrMediaRequiredProof extends MediaRequiredProof {
  private readonly enrollSchool = requiredOwnerEpoch(
    {
      ...mediaCountProofOwner,
      fence: async (tx) => {
        if (!(await mediaCountProofOwner.fence(tx))) return false;
        await tx.query(
          'LOCK TABLE whaleu_school_configuration.qr_upload_scopes,whaleu_school_configuration.qr_appearances,whaleu_school_configuration.qr_retirements IN SHARE MODE NOWAIT',
        );
        return true;
      },
    },
    'MEDIA_UNAVAILABLE',
  );
  override capture(tx: PoolClient) {
    return this.enrollSchool(tx);
  }
}
