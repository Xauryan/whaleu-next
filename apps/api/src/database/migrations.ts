import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import type { Pool, PoolClient } from 'pg';
import { supportedPostgresVersion } from './database.js';

export interface Migration {
  readonly name: string;
  readonly checksum: string;
  readonly sql: string;
}
export interface MigrationState {
  readonly name: string;
  readonly status: 'applied' | 'pending';
}
interface AppliedMigration {
  name: string;
  checksum: string;
}

// Session-scoped, database-local lock shared by every WhaleU migration process.
export const MIGRATION_LOCK = [1464355925, 1] as const;

export async function readMigrations(directory: string): Promise<Migration[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const migrations: Migration[] = [];
  const ids = new Set<string>();
  for (const entry of entries.sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  )) {
    if (entry.name === 'README.md' || entry.name === '.gitkeep') continue;
    const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(entry.name);
    if (!entry.isFile() || !match || ids.has(match[1]!)) {
      throw new Error('Invalid or duplicate migration filename');
    }
    ids.add(match[1]!);
    const sql = await readFile(join(directory, entry.name), 'utf8');
    if (!sql.trim()) throw new Error('Empty migration file');
    migrations.push({
      name: entry.name,
      checksum: createHash('sha256').update(sql).digest('hex'),
      sql,
    });
  }
  return migrations;
}

export function verifyHistory(
  migrations: readonly Migration[],
  applied: readonly AppliedMigration[],
): void {
  const known = new Map(
    migrations.map((migration) => [migration.name, migration.checksum]),
  );
  for (const record of applied) {
    if (known.get(record.name) !== record.checksum) {
      throw new Error(
        'Migration history mismatch; restore the original checked-in files',
      );
    }
  }
  const appliedNames = new Set(applied.map((migration) => migration.name));
  let pendingFound = false;
  for (const migration of migrations) {
    if (!appliedNames.has(migration.name)) pendingFound = true;
    else if (pendingFound)
      throw new Error('Migration history is not an ordered prefix');
  }
}

async function acquireLock(
  client: PoolClient,
  timeoutMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  do {
    const result = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_lock($1, $2) AS locked',
      [...MIGRATION_LOCK],
    );
    if (result.rows[0]?.locked) return;
    if (performance.now() >= deadline) break;
    await setTimeout(Math.min(100, Math.max(1, deadline - performance.now())));
  } while (performance.now() <= deadline);
  throw new Error('Timed out waiting for the migration lock');
}

export async function runMigrations(
  pool: Pick<Pool, 'connect'>,
  migrations: readonly Migration[],
  options: { mode: 'up' | 'status'; lockTimeoutMs?: number },
): Promise<MigrationState[]> {
  const client = await pool.connect();
  let locked = false;
  let destroy = false;
  try {
    const version = await client.query<{ version: number }>(
      "SELECT current_setting('server_version_num')::integer AS version",
    );
    if (!supportedPostgresVersion(version.rows[0]?.version ?? 0)) {
      throw new Error('PostgreSQL 18.6 or a newer 18.x patch is required');
    }
    await acquireLock(client, options.lockTimeoutMs ?? 10000);
    locked = true;
    const table = await client.query<{ present: string | null }>(
      "SELECT to_regclass('whaleu_meta.schema_migrations')::text AS present",
    );
    let applied: AppliedMigration[] = [];
    if (table.rows[0]?.present) {
      applied = (
        await client.query<AppliedMigration>(
          'SELECT name, checksum FROM whaleu_meta.schema_migrations ORDER BY name',
        )
      ).rows;
    }
    verifyHistory(migrations, applied);
    const appliedNames = new Set(applied.map((migration) => migration.name));
    if (options.mode === 'status') {
      return migrations.map(({ name }) => ({
        name,
        status: appliedNames.has(name) ? 'applied' : 'pending',
      }));
    }
    // Metadata only: no application tables are invented by this foundation.
    await client.query('BEGIN');
    await client.query('CREATE SCHEMA IF NOT EXISTS whaleu_meta');
    await client.query(`CREATE TABLE IF NOT EXISTS whaleu_meta.schema_migrations (
      name text PRIMARY KEY,
      checksum character(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    await client.query('COMMIT');
    for (const migration of migrations) {
      if (appliedNames.has(migration.name)) continue;
      await client.query('BEGIN');
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO whaleu_meta.schema_migrations (name, checksum) VALUES ($1, $2)',
        [migration.name, migration.checksum],
      );
      await client.query('COMMIT');
    }
    return migrations.map(({ name }) => ({ name, status: 'applied' }));
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      destroy = true;
    }
    throw error;
  } finally {
    if (locked && !destroy) {
      try {
        await client.query('SELECT pg_advisory_unlock($1, $2)', [
          ...MIGRATION_LOCK,
        ]);
      } catch {
        destroy = true;
      }
    }
    client.release(destroy);
  }
}
