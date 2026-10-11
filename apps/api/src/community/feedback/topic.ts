import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import type { CommunitySpace } from '../contracts.js';

/** Immutable explicit topic binding, never a guessed label or any global space. */
export async function requireFeedbackSpace(
  space: CommunitySpace,
  tx: PoolClient,
): Promise<void> {
  if (
    space.kind !== 'global' ||
    space.operatingRegionId !== null ||
    !space.isActive ||
    !(
      await tx.query(
        `SELECT t.space_id FROM whaleu_community.feedback_topic t JOIN whaleu_community.spaces s ON s.id=t.space_id WHERE t.topic='feedback' AND t.space_id=$1 AND t.provenance='accepted' AND length(btrim(t.source_reference))>0 AND s.kind='global' AND s.operating_region_id IS NULL AND s.is_active FOR SHARE OF t,s`,
        [space.id],
      )
    ).rows[0]
  )
    throw new ApplicationError('COMMUNITY_SCOPE_UNAVAILABLE');
}
