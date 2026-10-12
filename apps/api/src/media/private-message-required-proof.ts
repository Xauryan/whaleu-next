import type { PoolClient } from 'pg';
import { requiredOwnerEpoch } from '../database/required-owner-proof.js';
import { MediaRequiredProof, mediaCountProofOwner } from './required-proof.js';
/** New owner tables participate in the existing Media epoch, only typed15 paths
 * fence them. Historical schemas never acquire a new table dependency. */
export class PrivateMessageMediaRequiredProof extends MediaRequiredProof {
  private readonly enrollPrivateMessage = requiredOwnerEpoch(
    {
      ...mediaCountProofOwner,
      fence: async (tx) => {
        if (!(await mediaCountProofOwner.fence(tx))) return false;
        await tx.query(
          'LOCK TABLE whaleu_media.private_message_cancel_scopes,whaleu_media.private_message_scopes,whaleu_media.private_message_appearances,whaleu_media.private_message_retirements IN SHARE MODE NOWAIT',
        );
        return true;
      },
    },
    'MEDIA_UNAVAILABLE',
  );
  override capture(tx: PoolClient) {
    return this.enrollPrivateMessage(tx);
  }
}
