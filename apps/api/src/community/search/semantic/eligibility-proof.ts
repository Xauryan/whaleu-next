import type { PoolClient } from 'pg';
import { requiredOwnerEpoch } from '../../../database/required-owner-proof.js';
import { communityCountProofOwner } from '../../count-epochs.js';
import { safetyCountProofOwner } from '../../../safety/count-epochs.js';
import { campusCountProofOwner } from '../../../campus/count-epochs.js';

// Register in the canonical community -> Safety -> Campus order. These are
// mandatory proofs, not optional display counts. Each final fence is try-only;
// no source locks/network/deferred writes may follow finalization.
const owners = [
  communityCountProofOwner,
  safetyCountProofOwner,
  campusCountProofOwner,
].map((owner) => requiredOwnerEpoch(owner, 'COMMUNITY_UNAVAILABLE'));
export async function captureSemanticEligibilityProof(
  tx: PoolClient,
): Promise<void> {
  for (const capture of owners) await capture(tx);
}
