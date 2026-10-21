import type { PoolClient } from 'pg';
import { DeletionError } from '../contracts.js';

export const FOLLOW_SOCIAL_POLICY = 'synthetic-follow-social-v1' as const;
export const FOLLOW_SOCIAL_PAGE_SIZE = 100;
/** Pseudonymous/linkable evidence, explicitly NOT an anonymity claim. */
export const followSocialRetention = Object.freeze([
  'internal actor and public target identifiers',
  'event and command identities and original timestamps',
  'lifetime dedupe and immutable row fingerprints',
  "other recipients' original notice identity and first read time",
]);
/** SQL owns the finite partitions, exact causal page, locking, FK order and
 * deferred mutation/progress checks. Never synthesize a success from counts. */
export async function eraseFollowSocial(
  tx: PoolClient,
  requestId: string,
): Promise<string | null> {
  const page = (
    await tx.query<{ complete: boolean }>(
      'SELECT whaleu_account_deletion.follow_social_page($1) complete',
      [requestId],
    )
  ).rows[0];
  if (!page) throw new DeletionError('FOLLOW_SOCIAL_PAGE_UNAVAILABLE');
  if (!page.complete) return null;
  const proof = (
    await tx.query<{ proof: string | null }>(
      'SELECT whaleu_account_deletion.follow_social_proof($1) proof',
      [requestId],
    )
  ).rows[0]?.proof;
  if (!proof || !/^[a-f0-9]{64}$/.test(proof))
    throw new DeletionError('FOLLOW_SOCIAL_PROOF_UNAVAILABLE');
  return proof;
}
