import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import type { ExactQueryObservation } from './exact-discovery-counts.js';

/** Test-only race boundary. Every query remains observed, including entry policy.
 * Bind only after an actual successor INSERT, and invalidate on COMMIT/ROLLBACK.
 * A reusable PoolClient or mutable proof epoch alone is not a transaction ID.
 */
export class InsertedDiscoveryCursorTransaction {
  private client: PoolClient | undefined;
  private open = false;
  private inserted = false;
  private rolledBack = false;
  failure: unknown;

  finalizing(event: ExactQueryObservation, tx: PoolClient): boolean {
    return (
      this.open &&
      this.client === tx &&
      event.sql === 'SET CONSTRAINTS ALL IMMEDIATE'
    );
  }

  hook(
    observe: (event: ExactQueryObservation, tx: PoolClient) => Promise<void>,
  ): (event: ExactQueryObservation, tx: PoolClient) => Promise<void> {
    return async (event, tx) => {
      try {
        if (
          event.sql.includes('INSERT INTO whaleu_community.discovery_cursors')
        ) {
          assert.equal(
            event.rows,
            1,
            'The successor must actually be inserted',
          );
          assert.equal(
            this.inserted,
            false,
            'Expected one successor transaction',
          );
          this.client = tx;
          this.open = true;
          this.inserted = true;
        }
        if (
          tx === this.client &&
          (event.sql === 'COMMIT' || event.sql === 'ROLLBACK')
        ) {
          this.open = false;
          this.rolledBack = event.sql === 'ROLLBACK';
        }
        await observe(event, tx);
      } catch (error) {
        this.failure = error;
        throw error;
      }
    };
  }

  assertRolledBack(): void {
    assert.equal(
      this.failure,
      undefined,
      'The hook must not manufacture an HTTP 500',
    );
    assert.equal(this.inserted, true);
    assert.equal(this.open, false);
    assert.equal(
      this.rolledBack,
      true,
      'The successor-owning transaction must roll back',
    );
  }
}
