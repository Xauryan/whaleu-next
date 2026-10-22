import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
  type RequiredTransactionProof,
} from '../../database/transaction-deadlines.js';
import { retainPreparationSchema } from './qualification.js';
import {
  REAL_DELETION_PROTOCOL,
  type PreparationIntent,
  type RealDeletionReceipt,
} from './contracts.js';

export interface PreparationRow {
  intent_id: string;
  account_id: string;
  session_id: string;
  app_id: string;
  base_generation: string;
  next_generation: string;
  intent_hash: string;
  recovery_hash: string;
  consent: PreparationIntent['consent'];
  created_at: Date;
  expires_at: Date;
  expires_at_exact: string;
  current: boolean;
}
export async function preparationRow(
  tx: PoolClient,
  id: string,
): Promise<PreparationRow | null> {
  return (
    (
      await tx.query<PreparationRow>(
        `SELECT p.*, p.expires_at::text expires_at_exact,
    (p.expires_at>clock_timestamp() AND a.status='active' AND a.lifecycle='active' AND a.lifecycle_generation=p.base_generation) current
    FROM whaleu_real_deletion.preparations p JOIN whaleu_identity.accounts a ON a.id=p.account_id WHERE p.intent_id=$1`,
        [id],
      )
    ).rows[0] ?? null
  );
}
export function preparationReceipt(row: PreparationRow): RealDeletionReceipt {
  return Object.freeze({
    protocol: REAL_DELETION_PROTOCOL,
    intentId: row.intent_id,
    phase: 'prepared',
    revision: '0',
    preparedAt: row.created_at.toISOString(),
    preparationExpiresAt: row.expires_at.toISOString(),
    acceptedAt: null,
    cancelBefore: null,
    completedAt: null,
  });
}
interface PreparationFact {
  id: string;
  account: string;
  intent: string;
  recovery: string;
}
const preparationProof: RequiredTransactionProof<PreparationFact> = {
  maximumFacts: 4,
  failureCode: 'REAL_DELETION_SCOPE_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'REAL_DELETION_SCOPE_UNAVAILABLE', async (read) => {
      for (const fact of facts) {
        // A single fixed intent is the capability. No account-wide history query.
        const row = await preparationRow(read, fact.id);
        if (
          !row ||
          !row.current ||
          row.account_id !== fact.account ||
          row.intent_hash !== fact.intent ||
          row.recovery_hash !== fact.recovery
        )
          throw new ApplicationError('REAL_DELETION_SCOPE_UNAVAILABLE');
      }
    }),
};
export async function retainPreparation(
  tx: PoolClient,
  row: PreparationRow,
): Promise<void> {
  await retainPreparationSchema(tx);
  if (!row.current)
    throw new ApplicationError('REAL_DELETION_SCOPE_UNAVAILABLE');
  // PostgreSQL text preserves microseconds until the instant sampled AFTER every
  // owner proof and timeout restoration. Dates below are display-only.
  registerTransactionExactDeadline(
    tx,
    row.expires_at_exact,
    'REAL_DELETION_SCOPE_UNAVAILABLE',
  );
  enableRequiredTransactionProof(tx, preparationProof);
  registerRequiredTransactionFact(
    tx,
    preparationProof,
    row.intent_id,
    Object.freeze({
      id: row.intent_id,
      account: row.account_id,
      intent: row.intent_hash,
      recovery: row.recovery_hash,
    }),
  );
}
