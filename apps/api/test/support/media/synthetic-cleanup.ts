/** Test-only single-process storage retirement, not provider quiescence. */
import type { Pool } from 'pg';
import { SyntheticMediaStorage } from './synthetic-storage.js';
import { MediaLifecycleRepository } from '../../../src/media/lifecycle-repository.js';
import { withCommunityScopeWriter } from '../community-scope-fixtures.js';
import { transactionReadEpoch } from '../../../src/database/transaction-deadlines.js';
export class SyntheticMediaCleanup {
  private readonly lifecycle: MediaLifecycleRepository;
  constructor(
    private readonly pool: Pool,
    private readonly storage: SyntheticMediaStorage,
  ) {
    this.lifecycle = new MediaLifecycleRepository({
      require: (proof, object, tx) => {
        if (!transactionReadEpoch(tx))
          throw new Error('SYNTHETIC_CLEANUP_UNMANAGED');
        storage.requireRetired(proof, object);
      },
    });
  }
  async runOne(): Promise<
    'idle' | 'deleted' | 'retained' | 'retryable' | 'stale'
  > {
    const lease = await withCommunityScopeWriter(this.pool, (tx) =>
      this.lifecycle.claimCleanup(tx),
    );
    if (!lease) return 'idle';
    // Stop all possible writers BEFORE confirming exact absence. The storage
    // retirement cannot be revoked by a later test operation or DB rollback.
    const proof = await this.storage.retire(lease.object);
    const result = await this.storage.deleteExact(lease.object);
    return withCommunityScopeWriter(this.pool, (tx) =>
      this.lifecycle.settleCleanup(lease, result, tx, proof),
    );
  }
}
