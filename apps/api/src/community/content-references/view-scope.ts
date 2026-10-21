import { ApplicationError } from '../../http/application-error.js';
import type { PoolClient } from 'pg';
import type {
  CommunityRepository,
  StoredPost,
} from '../community.repository.js';
import type { CommunitySpace } from '../contracts.js';
import type { CommunityDistributionService } from '../related-sync/service.js';
import { resolvePostCategory } from '../category-reclassification/read-proof.js';

/** Same current related-campus authorization as FeedService.detail. This does
 * not echo a caller's requested campus or infer one from an author profile.
 * Keep changes here and the direct detail owner in parity until centralized. */
export async function requireReferenceViewScope(
  post: StoredPost,
  space: CommunitySpace,
  viewSpaceId: string | undefined,
  repository: CommunityRepository,
  distribution: CommunityDistributionService,
  tx: PoolClient,
): Promise<void> {
  if (!viewSpaceId || viewSpaceId === space.id) return;
  const view = await repository.space(viewSpaceId, tx);
  const scope = await distribution.resolveView(view, tx);
  if (scope.relatedCampusDistribution === 'unavailable')
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  const category = await resolvePostCategory(post.id, tx);
  if (category === null) throw new ApplicationError('POST_NOT_FOUND');
  const decision = await distribution.allows(
    scope,
    post.id,
    space.id,
    category,
    tx,
  );
  if (decision.kind === 'unavailable')
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  if (decision.kind === 'deny') throw new ApplicationError('POST_NOT_FOUND');
}
