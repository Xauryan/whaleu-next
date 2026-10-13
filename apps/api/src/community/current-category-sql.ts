import type { CommunityDistributionScope } from './related-sync/contracts.js';
import type { CommunityDistributionService } from './related-sync/service.js';

/** Current classification candidates only. Publication category stays immutable.
 * The disjoint UNION lets PostgreSQL push category/scope/seek predicates into
 * each indexed branch. Head absence is an exact indexed lookup, not a global
 * anti-join. This relation is structural metadata only: every consumer must run
 * canonical original Review and batched current-category proofs before emitting
 * a row or counting it. Invalid heads remain candidates for those proofs and
 * never fall back to the original-category branch.
 */
export const CURRENT_CATEGORY_POSTS_SQL = `(
  SELECT original.*,original.category AS current_category
  FROM whaleu_community.posts original
  WHERE NOT EXISTS (
    SELECT 1 FROM whaleu_community.post_category_heads head
    WHERE head.post_id=original.id
    OFFSET 0
  )
  UNION ALL
  SELECT original.*,head.current_category
  FROM whaleu_community.post_category_heads head
  JOIN whaleu_community.posts original ON original.id=head.post_id
    AND original.space_id=head.original_space_id
    AND original.published_at=head.original_published_at
)`;

/** Preserve the indexed local classification arm when a related audience exists.
 * The owner alone defines native candidate eligibility, including malformed v4
 * or binding-bearing roots. Do not put its correlated binding subquery above the
 * classification UNION: that prevents PostgreSQL from pushing local space/category
 * predicates into moved heads. Classify remote candidates only after native
 * source filtering, by canonical ID. No topology query or proof is performed here.
 */
export function scopedCurrentCategoryPostsSql(
  scope: CommunityDistributionScope,
  owner: Pick<CommunityDistributionService, 'sqlPredicate'>,
  parameters: unknown[],
): string {
  if (!scope.remoteSpaceIds.length) {
    const eligibility = owner.sqlPredicate(
      scope,
      'scoped_post',
      'current_category',
      parameters,
    );
    return `(SELECT scoped_post.* FROM ${CURRENT_CATEGORY_POSTS_SQL} scoped_post
      WHERE ${eligibility})`;
  }
  const nativeEligibility = owner.sqlPredicate(
    scope,
    'distribution_post',
    'category',
    parameters,
  );
  // sqlPredicate validated the branded, current owner scope before its coordinates
  // are used. This extra bind partitions local/remote arms; it grants no audience.
  parameters.push(scope.viewSpaceId);
  const local = parameters.length;
  return `(
    SELECT local_classified.*
    FROM ${CURRENT_CATEGORY_POSTS_SQL} local_classified
    WHERE local_classified.space_id=$${local}::uuid
    UNION ALL
    SELECT distribution_post.*,remote_category.current_category
    FROM whaleu_community.posts distribution_post
    JOIN LATERAL (
      SELECT exact_category.current_category
      FROM ${CURRENT_CATEGORY_POSTS_SQL} exact_category
      WHERE exact_category.id=distribution_post.id OFFSET 0
    ) remote_category ON true
    WHERE distribution_post.space_id<>$${local}::uuid AND ${nativeEligibility}
  )`;
}
