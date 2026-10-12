import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';

export interface CategoryInputSelection {
  postId: string;
  grantId: string;
  previousEventId: string | null;
  policyId: string | null;
  reviewId: string | null;
  fromCategory: string;
  targetCategory: string;
}
export interface CategoryInputFact extends CategoryInputSelection {
  readonly fingerprint: string;
  readonly previousUntil: string | null;
}
/** Immutable selection IDs are retained across the command's own head write.
 * Mutable input xmin/head/withdrawal facts are never recaptured after the write. */
async function fingerprint(
  input: CategoryInputSelection,
  tx: PoolClient,
): Promise<string> {
  const row = (
    await tx.query<{ value: unknown }>(
      `SELECT jsonb_build_object(
 'grant',(SELECT jsonb_build_array(to_jsonb(g),g.xmin::text) FROM whaleu_authorization.role_grants g WHERE id=$2),
 'post',(SELECT jsonb_build_array(to_jsonb(p),p.xmin::text) FROM whaleu_community.posts p WHERE id=$1),
 'original',(SELECT jsonb_build_array(to_jsonb(b),to_jsonb(d),d.xmin::text,to_jsonb(h),h.xmin::text,to_jsonb(e),e.xmin::text,to_jsonb(p),p.xmin::text)
 FROM whaleu_community.content_approval_bindings b JOIN whaleu_community.content_approval_decisions d ON d.id=b.decision_id
 LEFT JOIN whaleu_community.content_approval_heads h ON h.decision_id=d.id
 LEFT JOIN whaleu_community.content_approval_events e ON e.id=h.event_id
 JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id WHERE b.content_kind='post' AND b.content_id=$1),
 'previous',(SELECT to_jsonb(e) FROM whaleu_community.post_category_events e WHERE id=$3),
 'sources',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(p),to_jsonb(h),h.xmin::text,to_jsonb(i),to_jsonb(pw),to_jsonb(iw)) ORDER BY p.id)
 FROM whaleu_community.post_category_policies p
 LEFT JOIN whaleu_community.post_category_policy_heads h ON h.source_key=p.source_key
 JOIN whaleu_community.post_category_issuers i ON i.id=p.issuer_id
 LEFT JOIN whaleu_community.post_category_policy_withdrawals pw ON pw.policy_id=p.id
 LEFT JOIN whaleu_community.post_category_issuer_withdrawals iw ON iw.issuer_id=i.id
 WHERE p.id=$4 OR p.id=(SELECT policy_id FROM whaleu_community.post_category_events WHERE id=$3)),
 'reviews',(SELECT jsonb_agg(jsonb_build_array(to_jsonb(r),to_jsonb(w),
 (SELECT jsonb_agg(jsonb_build_array(latest.id,latest.result,latest.accepted_at) ORDER BY latest.accepted_at DESC,latest.id DESC) FROM (SELECT newer.* FROM whaleu_community.post_category_reviews newer WHERE newer.purpose=r.purpose AND newer.digest=r.digest ORDER BY newer.accepted_at DESC,newer.id DESC LIMIT 1) latest)) ORDER BY r.id)
 FROM whaleu_community.post_category_reviews r LEFT JOIN whaleu_community.post_category_review_withdrawals w ON w.review_id=r.id
 WHERE r.id=$5 OR r.id=(SELECT review_id FROM whaleu_community.post_category_events WHERE id=$3)),
 'selection',CASE WHEN $4::uuid IS NULL THEN NULL ELSE
 (SELECT jsonb_agg(jsonb_build_array(candidate.id,candidate.digest) ORDER BY candidate.id) FROM
 (SELECT s.id,s.digest FROM whaleu_community.post_category_policy_live s JOIN whaleu_community.content_approval_bindings b ON b.content_kind='post' AND b.content_id=$1
 WHERE s.original_region_id=(b.scope->>'originalRegionId')::uuid AND whaleu_community.post_category_policy_allows(s.definition,b.envelope->>'category',$6,$7) ORDER BY s.id LIMIT 2) candidate) END
 ) AS value`,
      [
        input.postId,
        input.grantId,
        input.previousEventId,
        input.policyId,
        input.reviewId,
        input.fromCategory,
        input.targetCategory,
      ],
    )
  ).rows[0];
  if (!row) throw new ApplicationError('POST_CATEGORY_UNAVAILABLE');
  return ownerFingerprint(row.value);
}
const proof: RequiredTransactionProof<CategoryInputFact> = {
  maximumFacts: 2,
  failureCode: 'POST_CATEGORY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'POST_CATEGORY_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_authorization.role_grants,whaleu_community.post_category_policies,whaleu_community.post_category_policy_heads,whaleu_community.post_category_policy_withdrawals,whaleu_community.post_category_issuers,whaleu_community.post_category_issuer_withdrawals,whaleu_community.post_category_reviews,whaleu_community.post_category_review_withdrawals IN SHARE MODE NOWAIT',
      );
      for (const fact of facts) {
        await read.query(
          'SELECT id FROM whaleu_authorization.role_grants WHERE id=$1 FOR SHARE NOWAIT',
          [fact.grantId],
        );
        await read.query(
          'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR SHARE NOWAIT',
          [fact.postId],
        );
        await read.query(
          `SELECT d.id FROM whaleu_community.content_approval_bindings b JOIN whaleu_community.content_approval_decisions d ON d.id=b.decision_id JOIN whaleu_community.content_approval_heads h ON h.decision_id=d.id JOIN whaleu_community.content_approval_policies p ON p.id=d.policy_revision_id WHERE b.content_kind='post' AND b.content_id=$1 FOR SHARE OF d,h,p NOWAIT`,
          [fact.postId],
        );
        if ((await fingerprint(fact, read)) !== fact.fingerprint)
          throw new ApplicationError('POST_CATEGORY_UNAVAILABLE');
      }
    }),
};
export async function observeCategoryInputs(
  input: CategoryInputSelection,
  tx: PoolClient,
): Promise<CategoryInputFact> {
  let previousUntil: string | null = null;
  if (input.previousEventId) {
    const previous = (
      await tx.query<{ until: string }>(
        `SELECT r.effective_until::text AS until FROM whaleu_community.post_category_events e JOIN whaleu_community.post_category_review_live r ON r.id=e.review_id AND r.policy_id=e.policy_id WHERE e.id=$1 AND e.post_id=$2`,
        [input.previousEventId, input.postId],
      )
    ).rows[0];
    if (!previous) throw new ApplicationError('POST_CATEGORY_UNAVAILABLE');
    previousUntil = previous.until;
  }
  const fact = Object.freeze({
    ...input,
    previousUntil,
    fingerprint: await fingerprint(input, tx),
  });
  retainCategoryInputs(fact, tx);
  return fact;
}
/** Re-register this SAME observed fact after restoring projection checkpoints. */
export function retainCategoryInputs(
  fact: CategoryInputFact,
  tx: PoolClient,
): void {
  registerTransactionExactDeadline(
    tx,
    fact.previousUntil,
    'POST_CATEGORY_UNAVAILABLE',
  );
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(tx, proof, fact.fingerprint, fact);
}
