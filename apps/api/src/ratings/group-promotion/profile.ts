import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
  type RequiredTransactionProof,
} from '../../database/transaction-deadlines.js';
import type { Program } from './contracts.js';
interface Fact {
  program: string;
  stage: 'generation' | 'shortlink';
  revision: string;
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 16,
  failureCode: 'PROMOTION_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'PROMOTION_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_ratings.promotion_effect_profiles IN SHARE MODE NOWAIT',
      );
      for (const f of facts)
        if (
          !(
            await read.query(
              `SELECT 1 FROM whaleu_ratings.promotion_effect_profiles WHERE program_id=$1 AND stage=$2 AND revision=$3 AND enabled AND valid_until>clock_timestamp()`,
              [f.program, f.stage, f.revision],
            )
          ).rows[0]
        )
          throw new ApplicationError('PROMOTION_UNAVAILABLE');
    }),
};
export async function currentPromotionProfile(
  p: Program,
  stage: 'generation' | 'shortlink',
  tx: PoolClient,
  expected?: string | null,
) {
  const row = (
    await tx.query<{ revision: string; until: string }>(
      `SELECT revision,valid_until::text until FROM whaleu_ratings.promotion_effect_profiles WHERE program_id=$1 AND stage=$2 AND profile_id=$3 AND enabled AND valid_until>clock_timestamp() AND monetary_limit=0 AND max_input_tokens=512 AND max_output_tokens=128 AND input_fields=$4::text[] FOR SHARE`,
      [
        p.id,
        stage,
        p.profile_id,
        stage === 'generation' ? ['label', 'date', 'type'] : ['nativeLocator'],
      ],
    )
  ).rows[0];
  if (!row || (expected !== undefined && row.revision !== expected))
    throw new ApplicationError('PROMOTION_UNAVAILABLE');
  const fact = { program: p.id, stage, revision: row.revision };
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    `${p.id}:${stage}`,
    Object.freeze(fact),
  );
  registerTransactionExactDeadline(tx, row.until, 'PROMOTION_UNAVAILABLE');
  return row.revision;
}
