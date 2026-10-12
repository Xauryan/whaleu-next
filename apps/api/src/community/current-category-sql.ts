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
