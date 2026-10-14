import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
  type RequiredTransactionProof,
} from '../../database/transaction-deadlines.js';
import {
  digest,
  payloadHash,
  type FrozenPayload,
  type Program,
  type QualificationPort,
} from './contracts.js';
interface Fact {
  program: string;
  hash: string;
  revision: string;
  source: string;
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 16,
  failureCode: 'PROMOTION_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'PROMOTION_UNAVAILABLE', async (read) => {
      await read.query(
        'LOCK TABLE whaleu_ratings.promotion_payload_qualifications IN SHARE MODE NOWAIT',
      );
      for (const f of facts)
        if (
          !(
            await read.query(
              `SELECT 1 FROM whaleu_ratings.promotion_payload_qualifications WHERE program_id=$1 AND payload_hash=$2 AND policy_revision=$3 AND source_hash=$4 AND enabled AND valid_until>clock_timestamp()`,
              [f.program, f.hash, f.revision, f.source],
            )
          ).rows[0]
        )
          throw new ApplicationError('PROMOTION_UNAVAILABLE');
    }),
};
@Injectable()
export class RatingPromotionQualification implements QualificationPort {
  async current(p: Program, payload: FrozenPayload, tx: PoolClient) {
    const hash = payloadHash(payload),
      row = (
        await tx.query<{ policy_revision: string; until: string }>(
          `SELECT policy_revision,valid_until::text until FROM whaleu_ratings.promotion_payload_qualifications WHERE program_id=$1 AND payload_hash=$2 AND source_hash=$3 AND enabled AND valid_until>clock_timestamp()`,
          [p.id, hash, p.source_hash],
        )
      ).rows[0];
    if (!row) throw new ApplicationError('PROMOTION_UNAVAILABLE');
    const fact = {
      program: p.id,
      hash,
      revision: row.policy_revision,
      source: p.source_hash,
    };
    enableRequiredTransactionProof(tx, proof);
    registerRequiredTransactionFact(tx, proof, hash, Object.freeze(fact));
    registerTransactionExactDeadline(tx, row.until, 'PROMOTION_UNAVAILABLE');
    return digest(fact);
  }
}
