/** Shared only by disposable current180 epoch regression tests. */
import assert from 'node:assert/strict';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from '../../src/database/database.js';
import { inspectSessionEpochSchema } from '../../src/identity/session-epoch.js';

export const sqlError =
  (message: string, constraint?: string) => (error: unknown) =>
    error instanceof Error &&
    'code' in error &&
    error.code === '23514' &&
    error.message === message &&
    (constraint === undefined ||
      ('constraint' in error && error.constraint === constraint));
/** Disposable corruption injection, not deletion/bump authority. The caller MUST
 * roll back this transaction. Restore the actual guard before testing authority:
 * a disabled-schema rejection is not evidence for stale-epoch rejection. */
export async function staleEpoch(tx: PoolClient, account: string) {
  await tx.query(
    'ALTER TABLE whaleu_identity.accounts DISABLE TRIGGER session_epoch_account',
  );
  assert.equal(
    (
      await tx.query(
        'UPDATE whaleu_identity.accounts SET session_revocation_epoch=1 WHERE id=$1 AND session_revocation_epoch=0 RETURNING id',
        [account],
      )
    ).rowCount,
    1,
    'Inject exactly one zero-to-stale transition in this disposable transaction',
  );
  await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
  await tx.query(
    'ALTER TABLE whaleu_identity.accounts ENABLE TRIGGER session_epoch_account',
  );
  await inspectSessionEpochSchema(tx);
}
export async function rollbackOnly(
  pool: Pool,
  work: (tx: PoolClient) => Promise<void>,
) {
  const sentinel = new Error('rollback-only-epoch-fixture');
  await assert.rejects(
    inTransaction(pool, async (tx) => {
      await work(tx);
      throw sentinel;
    }),
    (error) => error === sentinel,
  );
}
export async function sqlRejected(
  tx: PoolClient,
  work: () => Promise<unknown>,
  check: (error: unknown) => boolean,
) {
  await tx.query('SAVEPOINT expected_rejection');
  await assert.rejects(work(), check);
  await tx.query('ROLLBACK TO SAVEPOINT expected_rejection');
  await tx.query('RELEASE SAVEPOINT expected_rejection');
}
