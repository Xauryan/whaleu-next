import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { transactionReadEpoch } from '../database/transaction-deadlines.js';
/** Immutable mapping routing hint only. Acquire BEFORE any intent/asset locks. */
export async function lockMediaBatchesForIntents(
  ids: readonly string[],
  tx: PoolClient,
  write = true,
): Promise<void> {
  if (!transactionReadEpoch(tx))
    throw new ApplicationError('MEDIA_UNAVAILABLE');
  if (!ids.length) return;
  const ratings = await tx.query(
    `SELECT id FROM whaleu_media.upload_intents WHERE id=ANY($1::uuid[]) AND protocol_version=7`,
    [ids],
  );
  if (ratings.rowCount)
    await tx.query(
      `SELECT b.id FROM whaleu_media.ratings_discussion_batches b WHERE b.id IN
    (SELECT m.batch_id FROM whaleu_media.ratings_discussion_members m WHERE m.intent_id=ANY($1::uuid[]))
    ORDER BY b.id FOR ${write ? 'UPDATE' : 'SHARE'} OF b NOWAIT`,
      [ids],
    );
  await tx.query(
    `SELECT b.id FROM whaleu_media.publication_batches b WHERE b.id IN
    (SELECT m.batch_id FROM whaleu_media.publication_batch_members m WHERE m.intent_id=ANY($1::uuid[]))
    ORDER BY b.id FOR ${write ? 'UPDATE' : 'SHARE'} OF b`,
    [ids],
  );
}
/** Queue admission may skip a busy batch, just as it skips a busy intent. */
export async function tryLockMediaBatchForIntent(
  id: string,
  tx: PoolClient,
): Promise<boolean> {
  if (!transactionReadEpoch(tx))
    throw new ApplicationError('MEDIA_UNAVAILABLE');
  const mapping = (
    await tx.query<{ batch_id: string }>(
      'SELECT batch_id FROM whaleu_media.publication_batch_members WHERE intent_id=$1',
      [id],
    )
  ).rows[0];
  const media7 =
    (
      await tx.query(
        'SELECT id FROM whaleu_media.upload_intents WHERE id=$1 AND protocol_version=7',
        [id],
      )
    ).rowCount === 1;
  const ratings = media7
    ? (
        await tx.query<{ batch_id: string }>(
          'SELECT batch_id FROM whaleu_media.ratings_discussion_members WHERE intent_id=$1',
          [id],
        )
      ).rows[0]
    : undefined;
  if (media7 && !ratings) throw new ApplicationError('MEDIA_UNAVAILABLE');
  if (mapping && ratings) throw new ApplicationError('MEDIA_UNAVAILABLE');
  if (ratings)
    return (
      (
        await tx.query(
          'SELECT id FROM whaleu_media.ratings_discussion_batches WHERE id=$1 FOR UPDATE SKIP LOCKED',
          [ratings.batch_id],
        )
      ).rowCount === 1
    );
  if (!mapping) return true;
  return (
    (
      await tx.query(
        'SELECT id FROM whaleu_media.publication_batches WHERE id=$1 FOR UPDATE SKIP LOCKED',
        [mapping.batch_id],
      )
    ).rowCount === 1
  );
}
