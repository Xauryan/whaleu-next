import type { PoolClient } from 'pg';
import { hasRetainedHomeReadingSchema } from '../reading-formatting/readiness.js';
import { z } from 'zod';
import { homeReviewEvidenceSchema } from './review-evidence.js';
import type { HomeReviewEvidence } from './review-evidence.js';

const parentSchema = z.strictObject({
  postId: z.uuid(),
  decisionId: z.uuid(),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
});
export type HomeParentReference = z.infer<typeof parentSchema>;

/** Immutable publication-owner evidence, not a copy of a caller's approval.
 * SQL publication closure binds these rows to the fresh original request and
 * actual decision. The definition owner separately compares the reconstructed
 * content to current approval; this loader never grants visibility. */
export async function readHomeDefinitionEvidence(
  kind: 'post' | 'comment' | 'reply',
  id: string,
  postId: string,
  tx: PoolClient,
): Promise<{
  home?: HomeReviewEvidence;
  homeParent?: HomeParentReference;
} | null> {
  // Only the managed reading owner may rely on its retained exact schema seal.
  // Ordinary canonical callers keep their original row-lock contract.
  const lock = hasRetainedHomeReadingSchema(tx) ? '' : ' FOR SHARE';
  if (kind === 'post') {
    const row = (
      await tx.query<{ evidence: unknown }>(
        `SELECT evidence FROM whaleu_community.home_post_dispositions WHERE post_id=$1${lock}`,
        [id],
      )
    ).rows[0];
    if (!row) return null;
    const parsed = homeReviewEvidenceSchema.safeParse(row.evidence);
    return parsed.success ? { home: parsed.data } : null;
  }
  const row = (
    await tx.query<{ postId: string; decisionId: string; digest: string }>(
      `SELECT post_id AS "postId",parent_decision_id AS "decisionId",parent_digest AS digest FROM whaleu_community.home_discussion_parent_bindings WHERE content_kind=$1 AND content_id=$2 AND post_id=$3${lock}`,
      [kind, id, postId],
    )
  ).rows[0];
  if (!row) return null;
  const parsed = parentSchema.safeParse(row);
  return parsed.success && parsed.data.postId === postId
    ? { homeParent: parsed.data }
    : null;
}
