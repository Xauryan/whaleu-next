import type { PoolClient } from 'pg';
import { CountProofCollector } from '../database/count-proof.js';
import { campusCountProofOwner } from '../campus/count-epochs.js';
import { safetyCountProofOwner } from '../safety/count-epochs.js';
import { communityCountProofOwner } from './count-epochs.js';

/** Owner-coordinated, bounded proof for nonlocking discovery count batches.
 * The caller still owns mandatory session/profile/privacy/common-policy locks. */
export function captureCountProof(
  tx: PoolClient,
  read: PoolClient = tx,
): Promise<CountProofCollector | null> {
  return CountProofCollector.capture(
    tx,
    [communityCountProofOwner, safetyCountProofOwner, campusCountProofOwner],
    read,
  );
}
