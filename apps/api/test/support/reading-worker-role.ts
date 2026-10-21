/** Disposable PostgreSQL-only role fixture. Never called by production runtime. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  assertReadingWorkerTarget,
  type ReadingWorkerDockerTarget,
} from './reading-worker-docker-target.js';
import type { DatabaseService } from '../../src/database/database.js';
import { assertReadingWorkerRole } from '../../src/community/reading-formatting/worker-process.js';
import {
  readingTablePrivileges,
  readingColumnPrivileges,
} from '../../src/community/reading-formatting/role-contract.js';
const checked = (name: string) => {
  assert.match(name, /^[a-z_][a-z0-9_]*$/);
  return `"${name}"`;
};
const relation = (name: string) => name.split('.').map(checked).join('.');
export async function createReadingWorkerRole(
  pool: Pool,
  docker?: ReadingWorkerDockerTarget,
) {
  const target = (
    await pool.query<{ database: string; host: string | null }>(
      'SELECT current_database() database,host(inet_server_addr()) host',
    )
  ).rows[0]!;
  assertReadingWorkerTarget(target, docker);
  const name = 'reading_test_' + randomUUID().replaceAll('-', '');
  await pool.query(
    `CREATE ROLE ${checked(name)} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`,
  );
  const close = async () => {
    await pool.query(`DROP OWNED BY ${checked(name)}`);
    await pool.query(`DROP ROLE ${checked(name)}`);
  };
  try {
    const schemas = new Set([
      'whaleu_profile',
      ...readingTablePrivileges.map((p) => p.relation.split('.')[0]!),
    ]);
    for (const schema of schemas)
      await pool.query(
        `GRANT USAGE ON SCHEMA ${checked(schema)} TO ${checked(name)}`,
      );
    for (const p of readingTablePrivileges)
      await pool.query(
        `GRANT ${p.privilege} ON TABLE ${relation(p.relation)} TO ${checked(name)}`,
      );
    for (const p of readingColumnPrivileges)
      await pool.query(
        `GRANT ${p.privilege} (${checked(p.column)}) ON TABLE ${relation(p.relation)} TO ${checked(name)}`,
      );
    return { name, close };
  } catch (error) {
    let cleanupFailure: unknown;
    try {
      await close();
    } catch (cleanup) {
      cleanupFailure = cleanup;
    }
    if (cleanupFailure !== undefined)
      throw new AggregateError(
        [error, cleanupFailure],
        'Role setup and cleanup failed',
        { cause: error },
      );
    throw error;
  }
}
/** Preserve the original managed transaction/finalizer and owner policy. The
 * role remains active through its final proofs/COMMIT, not reset after callback. */
export async function withReadingWorkerRole<T>(
  database: DatabaseService,
  name: string,
  run: () => Promise<T>,
): Promise<T> {
  const originalMethod = database.transaction;
  const original = originalMethod.bind(database);
  database.transaction = (operation, options) =>
    original(async (tx) => {
      await tx.query(`SET LOCAL ROLE ${checked(name)}`);
      await assertReadingWorkerRole(tx);
      return operation(tx);
    }, options);
  try {
    return await run();
  } finally {
    database.transaction = originalMethod;
  }
}
