import type { PoolClient } from 'pg';
import type {
  CountEpochRow,
  CountProofOwner,
} from '../database/count-proof.js';
import { requiredOwnerEpoch } from '../database/required-owner-proof.js';

/** Owner-native epoch operations shared by mandatory Media proofs and the
 * explicit optional image-aware count profile. Sharing this object does not
 * enroll conditional count facts in mandatory transaction proof/deadlines. */
export const mediaCountProofOwner: CountProofOwner = {
  order: 40,
  capture: async (tx) =>
    (
      await tx.query<CountEpochRow>(
        'SELECT slot,version,epoch::text FROM whaleu_media.media_owner_states ORDER BY slot',
      )
    ).rows,
  fence: async (tx) => {
    // Match Safety/Campus: final readers share the epoch relation fence.
    // Every admitted BEFORE STATEMENT writer must UPDATE this table, including
    // zero-row source writes. Keep writer slot/overflow admission unchanged;
    // shared advisory slots here would obstruct the original overflow retry.
    await tx.query(
      `LOCK TABLE whaleu_media.media_owner_states,
          whaleu_media.upload_intents,whaleu_media.quota_reservations,whaleu_media.object_attempts,
          whaleu_media.assets,whaleu_media.variants,whaleu_media.asset_safety_events,whaleu_media.asset_safety_heads,
          whaleu_media.scope_consumptions,whaleu_media.bindings,whaleu_media.jobs,whaleu_media.cleanup_obligations,
          whaleu_media.derived_object_attempts,whaleu_media.upload_request_fences,
          whaleu_media.upload_ingress,whaleu_media.upload_ingress_writers,
          whaleu_media.publication_batches,whaleu_media.publication_batch_members,whaleu_media.publication_batch_commands IN SHARE MODE NOWAIT`,
    );
    return true;
  },
};

/** SQL statement triggers cover raw writers too. The mandatory bounded final
 * fence is installed after deferred waits by the transaction finalizer. */
export class MediaRequiredProof {
  private readonly enroll = requiredOwnerEpoch(
    mediaCountProofOwner,
    'MEDIA_UNAVAILABLE',
  );
  capture(tx: PoolClient): Promise<string> {
    return this.enroll(tx);
  }
}
