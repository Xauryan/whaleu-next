import type { PoolClient } from 'pg';
import { requiredOwnerEpoch } from '../database/required-owner-proof.js';
import { MediaRequiredProof, mediaCountProofOwner } from './required-proof.js';
/** New owner tables participate in the existing Media epoch, only typed17 paths
 * fence them. Historical schemas never acquire a new table dependency. */
export class MajorDiscussionMediaRequiredProof extends MediaRequiredProof {
  private readonly enrollMajorDiscussion = requiredOwnerEpoch(
    {
      ...mediaCountProofOwner,
      fence: async (tx) => {
        if (!(await mediaCountProofOwner.fence(tx))) return false;
        await tx.query(
          'LOCK TABLE whaleu_media.major_discussion_cancel_scopes,whaleu_media.major_discussion_scopes,whaleu_media.major_discussion_appearances IN SHARE MODE NOWAIT',
        );
        return true;
      },
    },
    'MEDIA_UNAVAILABLE',
  );
  override capture(tx: PoolClient) {
    return this.enrollMajorDiscussion(tx);
  }
}
