import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import {
  boundedOwnerProof,
  ownerFingerprint,
} from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';

export type ContentDistributionAction =
  'remove' | 'pin' | 'profile_unavailable';
interface Fact {
  actor: string;
  grantId: string;
  postId: string;
  viewSpaceId: string;
  action: ContentDistributionAction;
  facts: unknown;
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 4,
  failureCode: 'AUTHORIZATION_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'AUTHORIZATION_UNAVAILABLE', async (read) => {
      await read.query('SELECT whaleu_community.related_content_grant_fence()');
      for (const fact of facts) {
        const row = (
          await read.query<{ current: unknown; allowed: boolean }>(
            'SELECT whaleu_community.related_content_grant_facts($1,$2,$3,$4,$5) current, whaleu_community.related_content_grant_allowed($1,$2,$3,$4,$5) allowed',
            [
              fact.actor,
              fact.grantId,
              fact.postId,
              fact.viewSpaceId,
              fact.action,
            ],
          )
        ).rows[0];
        if (
          !row?.allowed ||
          ownerFingerprint(row.current) !== ownerFingerprint(fact.facts)
        )
          throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
      }
    }),
};
/** Action-specific selected grant. This never changes Profile's direct-region
 * grant predicate or grants a related account-punishment authority. */
export async function requireContentDistributionGrant(
  actor: string,
  postId: string,
  viewSpaceId: string | null,
  tx: PoolClient,
  action: ContentDistributionAction = 'remove',
): Promise<{ grantId: string; viewSpaceId: string }> {
  // Capture tuple + source generation BEFORE the selected grant lock waits.
  const row = (
    await tx.query<{
      id: string;
      view_space_id: string;
      until: string | null;
      facts: {
        distribution?: {
          validUntil?: string | null;
          status?: 'allowed' | 'denied' | 'unavailable';
        };
      };
    }>(
      `WITH candidates AS MATERIALIZED (
     SELECT g.id,s.id view_space_id,g.role,g.expires_at::text until,
     whaleu_community.related_content_grant_facts($1,g.id,$2,s.id,$4) facts
     FROM whaleu_authorization.role_grants g JOIN whaleu_community.posts p ON p.id=$2
     JOIN whaleu_community.spaces s ON s.id=coalesce($3::uuid,CASE WHEN g.operating_region_id IS NULL THEN p.space_id ELSE (SELECT id FROM whaleu_community.spaces WHERE kind='regional' AND operating_region_id=g.operating_region_id AND is_active) END)
     WHERE g.account_id=$1 AND whaleu_community.related_content_destination_grant_allowed($1,g.id,$2,s.id,$4)
     ) SELECT * FROM candidates
     WHERE facts->'distribution'->>'status' IN ('allowed','unavailable')
     ORDER BY CASE facts->'distribution'->>'status' WHEN 'allowed' THEN 0 ELSE 1 END,
       CASE role WHEN 'super_admin' THEN 0 ELSE 1 END,id LIMIT 1`,
      [actor, postId, viewSpaceId, action],
    )
  ).rows[0];
  if (!row) throw new ApplicationError('AUTHORIZATION_REQUIRED');
  if (row.facts.distribution?.status !== 'allowed')
    throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
  await tx.query(
    'SELECT id FROM whaleu_authorization.role_grants WHERE id=$1 FOR SHARE',
    [row.id],
  );
  registerTransactionExactDeadline(tx, row.until, 'AUTHORIZATION_REQUIRED');
  registerTransactionExactDeadline(
    tx,
    row.facts.distribution?.validUntil ?? null,
    'AUTHORIZATION_UNAVAILABLE',
  );
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    `${action}:${row.id}:${postId}:${row.view_space_id}`,
    Object.freeze({
      actor,
      grantId: row.id,
      postId,
      viewSpaceId: row.view_space_id,
      action,
      facts: row.facts,
    }),
  );
  return { grantId: row.id, viewSpaceId: row.view_space_id };
}
