import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import { retainCategoryIconState } from './icon-proof.js';
/** Exact registrations, including absence/held/future registrations, stay in the
 * proof. A target/discussion capability never grants Category media authority. */
export async function categoryIconCapabilities(
  protocolIds: readonly string[],
  keys: readonly string[],
  tx: PoolClient,
) {
  await retainCategoryIconState(keys, tx);
  const rows = (
    await tx.query<{
      id: string;
      protocol_version_id: string;
      source_digest: string;
      valid_until: Date;
      current: boolean;
    }>(
      `SELECT c.id,c.protocol_version_id,c.source_digest,c.valid_until,whaleu_ratings.category_icon_capability_current(c.id,clock_timestamp()) current FROM whaleu_ratings.category_icon_capability_sources c WHERE c.protocol_version_id=ANY($1::uuid[]) ORDER BY c.protocol_version_id`,
      [protocolIds],
    )
  ).rows;
  for (const row of rows)
    if (row.current)
      registerTransactionDeadline(
        tx,
        row.valid_until.getTime(),
        'RATING_SCOPE_UNAVAILABLE',
      );
  return [...protocolIds].sort().map((protocolVersionId) => {
    const row = rows.find(
      (item) => item.protocol_version_id === protocolVersionId,
    );
    return row
      ? {
          id: row.id,
          protocolVersionId,
          sourceDigest: row.source_digest,
          validUntil: row.valid_until.toISOString(),
          current: row.current === true,
        }
      : { protocolVersionId, current: false };
  });
}
export function requireCategoryIconCapabilities(
  values: Awaited<ReturnType<typeof categoryIconCapabilities>>,
) {
  if (!values.length || values.some((value) => !value.current))
    throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
}
export async function categoryIconSnapshot(
  keys: readonly string[],
  tx: PoolClient,
): Promise<string> {
  const value = (
    await tx.query<{ snapshot: string }>(
      'SELECT whaleu_ratings.category_icon_snapshot($1::text[]) snapshot',
      [keys],
    )
  ).rows[0]?.snapshot;
  if (!value || !/^[a-f0-9]{64}$/.test(value))
    throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
  return value;
}
