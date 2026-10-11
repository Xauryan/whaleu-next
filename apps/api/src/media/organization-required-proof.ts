import type { PoolClient } from 'pg';
import { requiredOwnerEpoch } from '../database/required-owner-proof.js';
import { MediaRequiredProof, mediaCountProofOwner } from './required-proof.js';
/** New owner tables participate in the existing Media epoch, only typed10 paths
 * fence them. Historical schemas never acquire a new table dependency. */
export class OrganizationMediaRequiredProof extends MediaRequiredProof {
  private readonly enrollOrganization = requiredOwnerEpoch(
    {
      ...mediaCountProofOwner,
      fence: async (tx) => {
        if (!(await mediaCountProofOwner.fence(tx))) return false;
        await tx.query(
          'LOCK TABLE whaleu_organizations.media_upload_scopes,whaleu_organizations.media_appearances,whaleu_organizations.media_retirements IN SHARE MODE NOWAIT',
        );
        return true;
      },
    },
    'MEDIA_UNAVAILABLE',
  );
  override capture(tx: PoolClient) {
    return this.enrollOrganization(tx);
  }
}
