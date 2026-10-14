import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
export interface PromotionFact {
  programId: string;
  revision: string;
  sourceHash: string;
  grantEpoch: string;
  audienceEpoch?: string;
  grantId?: string;
  grantRevision?: string;
  destinationId?: string;
  registryRevision?: string;
  enrollmentRevision?: string;
}
const proof: RequiredTransactionProof<PromotionFact> = {
  maximumFacts: 20,
  failureCode: 'PROMOTION_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'PROMOTION_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_ratings.promotion_programs,whaleu_ratings.promotion_grants,whaleu_ratings.promotion_policy_revisions,whaleu_ratings.promotion_source_bindings,whaleu_ratings.promotion_receivers,whaleu_ratings.promotion_receiver_lineages,whaleu_ratings.promotion_program_members_current IN SHARE MODE NOWAIT',
      );
      for (const f of facts) {
        const row = (
          await read.query(
            `SELECT 1 FROM whaleu_ratings.promotion_programs p WHERE p.id=$1 AND p.revision=$2 AND p.source_hash=$3 AND p.grant_epoch=$4::bigint AND p.enabled AND p.coverage='complete' AND p.provenance='accepted' AND p.effective_at<=clock_timestamp() AND p.valid_until>clock_timestamp()
        AND ($5::bigint IS NULL OR p.audience_epoch=$5)
        AND ($6::uuid IS NULL OR EXISTS(SELECT 1 FROM whaleu_ratings.promotion_grants g WHERE g.id=$6 AND g.program_id=p.id AND g.revision=$7 AND g.active AND g.valid_until>clock_timestamp()))
        AND ($8::uuid IS NULL OR EXISTS(SELECT 1 FROM whaleu_ratings.promotion_program_members_current m JOIN whaleu_ratings.promotion_receivers r ON r.id=m.stable_destination_id JOIN whaleu_ratings.promotion_receiver_lineages l ON l.id=r.id WHERE m.program_id=p.id AND m.stable_destination_id=$8 AND m.registry_revision=$9 AND m.enrollment_revision=$10 AND r.revision=$9 AND r.active AND NOT l.retired AND r.active_from<=clock_timestamp() AND r.valid_until>clock_timestamp()))`,
            [
              f.programId,
              f.revision,
              f.sourceHash,
              f.grantEpoch,
              f.audienceEpoch ?? null,
              f.grantId ?? null,
              f.grantRevision ?? null,
              f.destinationId ?? null,
              f.registryRevision ?? null,
              f.enrollmentRevision ?? null,
            ],
          )
        ).rows[0];
        if (!row) throw new ApplicationError('PROMOTION_UNAVAILABLE');
      }
    }),
};
export function retainPromotion(fact: PromotionFact, tx: PoolClient) {
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    JSON.stringify(fact),
    Object.freeze(fact),
  );
}
export async function promotionTransactionBudget(tx: PoolClient, ms = 3000) {
  await tx.query(
    `SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout','50ms',true)`,
    [`${Math.min(ms, 2000)}ms`],
  );
  const row = (
    await tx.query<{ until: string }>(
      `SELECT (clock_timestamp()+$1::int*interval '1 millisecond')::text until`,
      [ms],
    )
  ).rows[0]!;
  registerTransactionExactDeadline(tx, row.until, 'PROMOTION_UNAVAILABLE');
}
export function promotionDatabaseError(error: unknown): never {
  if (error instanceof ApplicationError) throw error;
  const e = error as { code?: string; constraint?: string };
  if (['40001', '40P01', '55P03', '57014'].includes(e.code ?? ''))
    throw new ApplicationError('PROMOTION_UNAVAILABLE');
  if (e.code === '23514' && e.constraint === 'promotion_program_capacity')
    throw new ApplicationError('PROMOTION_QUOTA_EXCEEDED');
  if (
    e.code === '23505' &&
    ['promotion_intents_pkey', 'promotion_campaigns_request_id_key'].includes(
      e.constraint ?? '',
    )
  )
    throw new ApplicationError('PROMOTION_REQUEST_CONFLICT');
  if (
    e.code === '23514' &&
    ['promotion_membership_causal', 'rating_group_payload_adopted'].includes(
      e.constraint ?? '',
    )
  )
    throw new ApplicationError('PROMOTION_SOURCE_CHANGED');
  throw error;
}
