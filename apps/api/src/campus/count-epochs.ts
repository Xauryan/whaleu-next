import type {
  CountEpochRow,
  CountProofOwner,
} from '../database/count-proof.js';

/** This owner alone exports its fixed epoch snapshot and fence protocol. */
export const campusCountProofOwner: CountProofOwner = {
  order: 1464356103,
  async capture(tx) {
    return (
      await tx.query<CountEpochRow>(
        'SELECT slot,version,epoch::text FROM whaleu_campus.discovery_count_epochs ORDER BY slot',
      )
    ).rows;
  },
  async fence(tx) {
    // Compatible readers share one final fence. Every admitted BEFORE STATEMENT
    // writer (including zero-row writes) must UPDATE this epoch table before
    // touching business rows, so its RowExclusiveLock conflicts in either order.
    // Do not also take shared advisory slots: a writer could exhaust them, pass
    // the now-unowned overflow gate, and raise 55P03 instead of waiting here.
    // Keep the original writer/overflow protocol and fixed-vector validation.
    await tx.query(
      'LOCK TABLE whaleu_campus.discovery_count_epochs IN SHARE MODE NOWAIT',
    );
    return true;
  },
};
