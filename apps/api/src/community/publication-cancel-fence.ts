import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';

/** Original owner request-key serialization, shared by publish and explicit
 * cancellation. This is one key lock, never a global reader gate. */
export async function lockPublicationCommand(
  actor: string,
  requestId: string,
  tx: PoolClient,
): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `whaleu:community-publication:v1:${actor}:${requestId}`,
  ]);
}
export async function requirePublicationNotCancelled(
  actor: string,
  requestId: string,
  operation: string,
  intentHash: string,
  tx: PoolClient,
): Promise<void> {
  const fence = (
    await tx.query<{ operation: string; intent_hash: string }>(
      'SELECT operation,intent_hash FROM whaleu_community.publication_cancel_fences WHERE account_id=$1 AND client_request_id=$2',
      [actor, requestId],
    )
  ).rows[0];
  if (!fence) return;
  if (fence.operation !== operation || fence.intent_hash !== intentHash)
    throw new ApplicationError('REQUEST_CONFLICT');
  throw new ApplicationError('MEDIA_REQUEST_CANCELLED');
}
