import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
export interface CreationFact {
  actor: string;
  requestId: string;
  intentHash: string;
  policyId: string;
  originId: string | null;
  catalogId: string;
  beforeCatalogId: string;
  targetId: string | null;
  revision: string | null;
  epoch: string;
}
const proof: RequiredTransactionProof<CreationFact> = {
  maximumFacts: 1,
  failureCode: 'RATING_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'RATING_UNAVAILABLE', async (read) => {
      for (const f of facts) {
        const row = (
          await read.query(
            `SELECT 1 FROM whaleu_ratings.native_create_policies p
    JOIN whaleu_ratings.native_create_policy_heads h ON h.policy_id=p.id
    LEFT JOIN whaleu_ratings.native_origin_evidence o ON o.policy_id=p.id AND o.account_id=$8 AND o.request_id=$9 AND o.intent_hash=$10 AND o.region_id IS NOT DISTINCT FROM p.region_id AND o.effective_at<=clock_timestamp() AND o.valid_until>clock_timestamp()
    JOIN whaleu_ratings.catalogs c ON c.id=$3 AND c.region_id IS NOT DISTINCT FROM p.region_id
    JOIN whaleu_ratings.catalog_heads ch ON ch.catalog_id=c.id
    JOIN whaleu_ratings.catalogs prior ON prior.id=$4
    JOIN whaleu_ratings.navigation_epoch e ON e.singleton AND e.version=1 AND e.epoch=$7::bigint
    WHERE o.id IS NOT DISTINCT FROM $2::uuid AND p.id=$1 AND p.enabled AND p.coverage='complete' AND p.provenance='accepted'
    AND p.effective_at<=clock_timestamp() AND p.valid_until>clock_timestamp()
    AND (($2::uuid IS NULL AND NOT p.require_known_origin) OR (o.effective_at<=clock_timestamp() AND o.valid_until>clock_timestamp() AND (NOT p.require_known_origin OR o.origin_state='known_school')))
    AND c.sealed AND c.coverage='complete' AND c.provenance='accepted' AND c.effective_at<=clock_timestamp() AND (c.valid_until IS NULL OR c.valid_until>clock_timestamp())
    AND prior.sealed AND prior.effective_at<=clock_timestamp() AND (prior.valid_until IS NULL OR prior.valid_until>clock_timestamp())
    AND ($5::uuid IS NULL OR EXISTS(SELECT 1 FROM whaleu_ratings.targets t JOIN whaleu_ratings.target_create_transitions tr ON tr.target_id=t.id WHERE t.id=$5 AND t.revision=$6 AND t.active AND tr.before_catalog_id=prior.id AND tr.after_catalog_id=c.id))`,
            [
              f.policyId,
              f.originId,
              f.catalogId,
              f.beforeCatalogId,
              f.targetId,
              f.revision,
              f.epoch,
              f.actor,
              f.requestId,
              f.intentHash,
            ],
          )
        ).rows[0];
        if (!row) throw new ApplicationError('RATING_UNAVAILABLE');
      }
    }),
};
export async function retainCreation(
  fact: Omit<CreationFact, 'epoch'>,
  tx: PoolClient,
) {
  enableRequiredTransactionProof(tx, proof);
  const epoch = (
    await tx.query<{ epoch: string }>(
      'SELECT epoch::text FROM whaleu_ratings.navigation_epoch WHERE singleton AND version=1',
    )
  ).rows[0]?.epoch;
  if (!epoch) throw new ApplicationError('RATING_UNAVAILABLE');
  registerRequiredTransactionFact(
    tx,
    proof,
    'creation',
    Object.freeze({ ...fact, epoch }),
  );
}
