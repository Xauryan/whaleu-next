import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { transactionReadEpoch } from '../database/transaction-deadlines.js';
/** Explicit protocol routing for absent-intent cancellation. The shared quota
 * fence remains authoritative; this immutable marker never grants bytes. */
export async function ratingsDiscussionRequestMarker(
  actor: string,
  requestId: string,
  tx: PoolClient,
): Promise<string | null> {
  if (!transactionReadEpoch(tx))
    throw new ApplicationError('MEDIA_UNAVAILABLE');
  return (
    (
      await tx.query<{ request_hash: string }>(
        'SELECT request_hash FROM whaleu_media.ratings_discussion_request_markers WHERE actor_id=$1 AND client_request_id=$2',
        [actor, requestId],
      )
    ).rows[0]?.request_hash ?? null
  );
}
/** Caller already holds the common Media actor reservation lock. */
export async function reserveRatingsDiscussionRequestMarker(
  actor: string,
  requestId: string,
  hash: string,
  tx: PoolClient,
): Promise<void> {
  await rejectRatingsDiscussionBatchRequest(actor, requestId, tx);
  const existing = await ratingsDiscussionRequestMarker(actor, requestId, tx);
  if (existing !== null) {
    if (existing !== hash) throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
    return;
  }
  const occupied = await tx.query(
    `SELECT 1 FROM whaleu_media.upload_request_fences WHERE actor_id=$1 AND client_request_id=$2 UNION ALL SELECT 1 FROM whaleu_media.upload_intents WHERE actor_id=$1 AND client_request_id=$2 LIMIT 1`,
    [actor, requestId],
  );
  if (occupied.rowCount) throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
  await tx.query(
    'INSERT INTO whaleu_media.ratings_discussion_request_markers(actor_id,client_request_id,request_hash) VALUES($1,$2,$3)',
    [actor, requestId, hash],
  );
}
export async function rejectRatingsDiscussionRequestMarker(
  actor: string,
  requestId: string,
  tx: PoolClient,
): Promise<void> {
  const installed = (
    await tx.query<{ present: boolean }>(
      "SELECT to_regclass('whaleu_media.ratings_discussion_request_markers') IS NOT NULL AS present",
    )
  ).rows[0];
  if (installed?.present !== true) return;
  await rejectRatingsDiscussionBatchRequest(actor, requestId, tx);
  if ((await ratingsDiscussionRequestMarker(actor, requestId, tx)) !== null)
    throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
}

async function rejectRatingsDiscussionBatchRequest(
  actor: string,
  requestId: string,
  tx: PoolClient,
): Promise<void> {
  const row = await tx.query(
    'SELECT 1 FROM whaleu_media.ratings_discussion_batch_request_fences WHERE actor_id=$1 AND batch_request_id=$2',
    [actor, requestId],
  );
  if (row.rowCount) throw new ApplicationError('MEDIA_REQUEST_CONFLICT');
}
