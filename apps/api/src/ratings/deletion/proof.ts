import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
export interface DeletionTarget {
  id: string;
  revision: string;
  active: boolean;
  region_id: string | null;
}
// Deletion is a metadata operation. This independent owner proof does not relax
// the active-target proof used by publication, reads, likes or subscriptions.
const proof: RequiredTransactionProof<DeletionTarget> = {
  maximumFacts: 4,
  failureCode: 'RATING_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'RATING_UNAVAILABLE', async (read) => {
      if (!facts.length) return;
      const result = await read.query<{ n: number }>(
        `SELECT count(*)::integer n FROM unnest($1::uuid[],$2::uuid[],$3::boolean[],$4::uuid[]) f(id,revision,active,region_id) JOIN whaleu_ratings.targets t ON t.id=f.id AND t.revision=f.revision AND t.active=f.active AND t.region_id IS NOT DISTINCT FROM f.region_id`,
        [
          facts.map((f) => f.id),
          facts.map((f) => f.revision),
          facts.map((f) => f.active),
          facts.map((f) => f.region_id),
        ],
      );
      if (result.rows[0]?.n !== facts.length)
        throw new ApplicationError('RATING_UNAVAILABLE');
    }),
};
export function retainDeletionTarget(row: DeletionTarget, tx: PoolClient) {
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    `target:${row.id}:${row.revision}`,
    row,
  );
}
