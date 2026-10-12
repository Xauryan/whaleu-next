import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import { canonicalJson } from '../content-review/contracts.js';
import { ApplicationError } from '../../http/application-error.js';
import { registerTransactionExactDeadline } from '../../database/transaction-deadlines.js';
import type { ReclassificationCommand } from './contracts.js';

export const categoryIntentHash = (
  actor: string,
  command: ReclassificationCommand,
): string =>
  createHash('sha256')
    .update(
      'whaleu:post-category-command:v1\n' + canonicalJson({ actor, command }),
    )
    .digest('hex');
export const categoryReviewDigest = (envelope: unknown): string =>
  createHash('sha256')
    .update('whaleu:post-category-review:v1\n' + canonicalJson(envelope))
    .digest('hex');
export const categoryPolicyDigest = (definition: unknown): string =>
  createHash('sha256')
    .update('whaleu:post-category-policy:v1\n' + canonicalJson(definition))
    .digest('hex');

export interface CategoryPolicy {
  id: string;
  definition: {
    continueDescendants: boolean;
    descendantMedia: 'text_only' | 'retain_current_media_proof';
  };
  effective_until: string;
}
export async function exactCategoryReview(
  envelope: unknown,
  policyId: string,
  tx: PoolClient,
): Promise<string> {
  const digest = categoryReviewDigest(envelope);
  const rows = (
    await tx.query<{ id: string; envelope: unknown; until: string }>(
      `SELECT r.id,r.envelope,r.effective_until::text AS until FROM whaleu_community.post_category_review_live r
     WHERE r.digest=$1 AND r.policy_id=$2`,
      [digest, policyId],
    )
  ).rows;
  if (
    rows.length !== 1 ||
    canonicalJson(rows[0]!.envelope) !== canonicalJson(envelope)
  )
    throw new ApplicationError('POST_CATEGORY_UNAVAILABLE');
  await tx.query(
    'SELECT id FROM whaleu_community.post_category_reviews WHERE id=$1 FOR SHARE',
    [rows[0]!.id],
  );
  registerTransactionExactDeadline(
    tx,
    rows[0]!.until,
    'POST_CATEGORY_UNAVAILABLE',
  );
  return rows[0]!.id;
}
export async function categoryCommandEnvelope(
  actor: string,
  command: ReclassificationCommand,
  grantId: string,
  policyId: string,
  tx: PoolClient,
): Promise<unknown> {
  const row = (
    await tx.query<{ envelope: unknown }>(
      'SELECT whaleu_community.post_category_command_envelope($1,$2,$3,$4) AS envelope',
      [actor, command, grantId, policyId],
    )
  ).rows[0];
  if (!row?.envelope) throw new ApplicationError('POST_CATEGORY_UNAVAILABLE');
  return row.envelope;
}
