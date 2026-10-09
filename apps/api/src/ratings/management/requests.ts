import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
/** Called after Safety gate: preparation cannot race an older command family. */
export async function assertRatingCommandClaim(
  actor: string,
  requestId: string,
  operation: string,
  hash: string,
  tx: PoolClient,
) {
  const row = (
    await tx.query<{ operation: string; intent_hash: string }>(
      'SELECT operation,intent_hash FROM whaleu_ratings.command_claims WHERE account_id=$1 AND request_id=$2',
      [actor, requestId],
    )
  ).rows[0];
  if (row && (row.operation !== operation || row.intent_hash !== hash))
    throw new ApplicationError('REQUEST_CONFLICT');
}
