import type { PoolClient } from 'pg';
import { requiredOwnerEpoch } from '../database/required-owner-proof.js';
import { MediaRequiredProof, mediaCountProofOwner } from './required-proof.js';
/** New owner tables participate in the existing Media epoch, only typed12 paths
 * fence them. Historical schemas never acquire a new table dependency. */
export class AnnouncementMediaRequiredProof extends MediaRequiredProof {
  private readonly enrollAnnouncement = requiredOwnerEpoch(
    {
      ...mediaCountProofOwner,
      fence: async (tx) => {
        if (!(await mediaCountProofOwner.fence(tx))) return false;
        await tx.query(
          'LOCK TABLE whaleu_announcements.media_upload_scopes,whaleu_announcements.media_appearances,whaleu_announcements.media_retirements IN SHARE MODE NOWAIT',
        );
        return true;
      },
    },
    'MEDIA_UNAVAILABLE',
  );
  override capture(tx: PoolClient) {
    return this.enrollAnnouncement(tx);
  }
}
