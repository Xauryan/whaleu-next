import type { PoolClient } from 'pg';
import { ApplicationError } from '../../../http/application-error.js';
import { boundedOwnerProof } from '../../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../../database/transaction-deadlines.js';
export interface TargetOwnerMetadata {
  id: string;
  creator_id: string;
  revision: string;
  active: boolean;
  delete_audit_id: string | null;
}
interface Fact extends TargetOwnerMetadata {
  requestId: string | null;
  auditId: string | null;
}
const proof: RequiredTransactionProof<Fact> = {
  maximumFacts: 4,
  failureCode: 'RATING_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'RATING_UNAVAILABLE', async (read) => {
      const row = (
        await read.query<{ n: number }>(
          `SELECT count(*)::integer n
           FROM unnest($1::uuid[],$2::uuid[],$3::uuid[],$4::boolean[],$5::uuid[],$6::uuid[],$7::uuid[])
             f(id,creator_id,revision,active,delete_audit_id,request_id,audit_id)
           JOIN whaleu_ratings.targets t ON t.id=f.id AND t.creator_id=f.creator_id
             AND t.revision=f.revision AND t.active=f.active
           LEFT JOIN whaleu_ratings.target_owner_tombstones d ON d.target_id=t.id
           WHERE d.delete_audit_id IS NOT DISTINCT FROM f.delete_audit_id
             AND (d.target_id IS NULL OR (NOT t.active AND d.after_revision=t.revision))
             AND (f.audit_id IS NULL OR EXISTS(
               SELECT 1 FROM whaleu_ratings.target_owner_delete_audits a
               JOIN whaleu_ratings.requests q ON q.account_id=a.actor_account_id AND q.request_id=a.request_id
               WHERE a.id=f.audit_id AND a.actor_account_id=f.creator_id AND a.request_id=f.request_id
                 AND a.target_id=f.id AND a.after_revision=f.revision
                 AND a.mutation_transaction=pg_current_xact_id()
                 AND q.operation='delete_target' AND q.intent_hash=a.intent_hash
                 AND q.receipt->>'outcome'=a.outcome AND q.receipt->>'revision'=f.revision::text))`,
          [
            facts.map((f) => f.id),
            facts.map((f) => f.creator_id),
            facts.map((f) => f.revision),
            facts.map((f) => f.active),
            facts.map((f) => f.delete_audit_id),
            facts.map((f) => f.requestId),
            facts.map((f) => f.auditId),
          ],
        )
      ).rows[0];
      if (row?.n !== facts.length)
        throw new ApplicationError('RATING_UNAVAILABLE');
    }),
};
/** Public cleanup facts contain no text, scope, source or Review information.
 * A mutation retains only its AFTER state; historical before state is SQL audit. */
export function retainTargetOwnerMetadata(
  row: TargetOwnerMetadata,
  tx: PoolClient,
  mutation?: { requestId: string; auditId: string },
) {
  enableRequiredTransactionProof(tx, proof);
  registerRequiredTransactionFact(
    tx,
    proof,
    `target-owner:${row.id}:${row.revision}:${mutation?.auditId ?? 'context'}`,
    Object.freeze({
      ...row,
      requestId: mutation?.requestId ?? null,
      auditId: mutation?.auditId ?? null,
    }),
  );
}
