import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import {
  MIGRATION_LOCK,
  readMigrations,
  verifyHistory,
} from '../../../database/migrations.js';
import { supportedPostgresVersion } from '../../../database/database.js';

/** Explicit optional installer. Uses the same migration lock, verifies all base
 * history, and makes extension/schema/triggers/checksum one atomic transaction.
 * This is not startup configuration and does not activate semantic search. */
export async function installSemanticSearch(
  pool: Pick<Pool, 'connect'>,
): Promise<'installed' | 'already_installed'> {
  const sql = await readFile(
    new URL(
      '../../../../optional-migrations/semantic-search/0001_pgvector_exact.sql',
      import.meta.url,
    ),
    'utf8',
  );
  const checksum = createHash('sha256').update(sql).digest('hex');
  const base = await readMigrations(
    fileURLToPath(new URL('../../../../migrations/', import.meta.url)),
  );
  const tx = await pool.connect();
  let begun = false,
    locked = false,
    destroy = false;
  try {
    await tx.query('BEGIN');
    begun = true;
    await tx.query(
      "SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='5s'",
    );
    const status = (
      await tx.query<{ version: number; database: string; local: boolean }>(
        `SELECT current_setting('server_version_num')::integer version,current_database() database,
       (inet_server_addr() IS NULL OR inet_server_addr() <<= inet '127.0.0.0/8' OR inet_server_addr()=inet '::1') AS local`,
      )
    ).rows[0];
    if (
      !status ||
      !supportedPostgresVersion(status.version) ||
      !status.local ||
      !['whaleu_test', 'whaleu_dev'].includes(status.database)
    )
      throw new Error(
        'Optional semantic installation requires a disposable local database',
      );
    // Try-only session lock avoids a second installer waiting while retaining
    // any relation/source lock. The finalizer always releases it below.
    const lock = (
      await tx.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1,$2) locked',
        [...MIGRATION_LOCK],
      )
    ).rows[0];
    if (!lock?.locked) throw new Error('Another migration is running');
    locked = true;
    const applied = (
      await tx.query<{ name: string; checksum: string }>(
        'SELECT name,checksum FROM whaleu_meta.schema_migrations ORDER BY name',
      )
    ).rows;
    verifyHistory(base, applied);
    if (applied.length !== base.length)
      throw new Error('Apply all base migrations first');
    const exists = (
      await tx.query<{ present: string | null }>(
        "SELECT to_regclass('whaleu_semantic.installation')::text present",
      )
    ).rows[0]?.present;
    if (exists) {
      const installed = (
        await tx.query<{ checksum: string; version: number }>(
          'SELECT version,checksum FROM whaleu_semantic.installation',
        )
      ).rows;
      const extension = (
        await tx.query<{ valid: boolean }>(
          "SELECT EXISTS(SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector' AND e.extversion='0.8.7' AND n.nspname='public') valid",
        )
      ).rows[0];
      if (
        installed.length !== 1 ||
        installed[0]!.version !== 1 ||
        installed[0]!.checksum !== checksum ||
        !extension?.valid
      )
        throw new Error('Optional semantic installation history mismatch');
      await tx.query('COMMIT');
      begun = false;
      return 'already_installed';
    }
    // Installation is maintenance: common outer gate precedes relation locks,
    // base rows and generation seeding, so no concurrent source transition is lost.
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:named-block-policy:v1',0))",
    );
    await tx.query(
      'LOCK TABLE whaleu_community.posts,whaleu_community.root_comments,whaleu_community.replies,whaleu_community.content_approval_heads IN SHARE ROW EXCLUSIVE MODE',
    );
    await tx.query(sql);
    await tx.query(
      'UPDATE whaleu_semantic.installation SET checksum=$1 WHERE version=1',
      [checksum],
    );
    await tx.query('COMMIT');
    begun = false;
    return 'installed';
  } catch (error) {
    if (begun) {
      try {
        await tx.query('ROLLBACK');
      } catch {
        destroy = true;
      }
    }
    throw error;
  } finally {
    if (locked) {
      try {
        await tx.query('SELECT pg_advisory_unlock($1,$2)', [...MIGRATION_LOCK]);
      } catch {
        destroy = true;
      }
    }
    tx.release(destroy);
  }
}
