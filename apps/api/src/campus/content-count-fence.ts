import type { PoolClient } from 'pg';

/** Active-region facts only. This does not expose publication verification. */
export async function fenceSmallCampusContentCount(
  tx: PoolClient,
): Promise<void> {
  await tx.query(
    'LOCK TABLE whaleu_campus.operating_regions IN SHARE MODE NOWAIT',
  );
}
