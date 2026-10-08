import type { PoolClient } from 'pg';
import type {
  CountEpochRow,
  CountProofOwner,
} from '../database/count-proof.js';

/** This owner alone exports its fixed epoch snapshot and fence protocol. */
export const errandCountProofOwner: CountProofOwner = {
  order: 1464356105,
  async capture(tx) {
    return (
      await tx.query<CountEpochRow>(
        'SELECT slot,version,epoch::text FROM whaleu_errands.admin_count_epochs ORDER BY slot',
      )
    ).rows;
  },
  async fence(tx) {
    // This gate is exclusive only during the final no-more-source-waits phase.
    // Saturated writers wait here in SHARED mode and retry the slot scan.
    if (
      (
        await tx.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_xact_lock(1464356105,128) AS locked',
        )
      ).rows[0]?.locked !== true
    )
      return false;
    // ORDER BY is inside the subquery so lock calls use ascending slot order.
    // Reading generated slots never hides missing metadata; capture rejects it.
    const rows = (
      await tx.query<{ locked: boolean }>(
        `SELECT pg_try_advisory_xact_lock_shared(1464356105,slot) AS locked
       FROM (SELECT generate_series(0,127) AS slot ORDER BY slot) AS slots`,
      )
    ).rows;
    return rows.length === 128 && rows.every((row) => row.locked === true);
  },
};

/** Final administrative page proof only, after every blocking source/cursor/
 * deferred wait. The caller must fail the read if this try-only fence fails. */
export async function fenceErrandAdminReads(tx: PoolClient): Promise<void> {
  await tx.query('LOCK TABLE whaleu_errands.orders IN SHARE MODE NOWAIT');
}
