import { Inject, Injectable } from '@nestjs/common';
import { fileURLToPath } from 'node:url';
import { APP_CONFIG, loadConfig } from '../config/config.js';
import type { RuntimeConfig } from '../config/config.js';
import { DatabaseService } from '../database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  verifyHistory,
} from '../database/migrations.js';
import type { Migration } from '../database/migrations.js';

// A floor, not a replacement for the deployed migration directory. A future
// deployment with additional checked-in migrations must require those too.
export const APPLICATION_SCHEMA_FLOOR =
  '0180_identity_session_revocation_epoch.sql';
const minimumMigrationCount = Number(APPLICATION_SCHEMA_FLOOR.slice(0, 4));
const maximumMigrationCount = 9999;
export const APPLICATION_MIGRATIONS = Symbol('APPLICATION_MIGRATIONS');
export type ApplicationMigrations = () => Promise<readonly Migration[]>;

/** The same source/dist-relative directory and loader used by db:migrate.
 * No migration SQL is executed. An incomplete artifact is never a legacy mode. */
export async function readApplicationMigrations(
  directory = fileURLToPath(new URL('../../migrations/', import.meta.url)),
): Promise<readonly Migration[]> {
  return readMigrations(directory);
}

function validateRequirements(
  migrations: readonly Migration[],
): readonly Migration[] {
  if (
    migrations.length < minimumMigrationCount ||
    migrations.length > maximumMigrationCount ||
    migrations[minimumMigrationCount - 1]?.name !== APPLICATION_SCHEMA_FLOOR ||
    migrations.some(
      (migration, index) =>
        !new RegExp(
          `^${String(index + 1).padStart(4, '0')}_[a-z0-9_]+\\.sql$`,
        ).test(migration.name) || !/^[a-f0-9]{64}$/.test(migration.checksum),
    )
  )
    throw new Error('Invalid application migration requirements');
  return Object.freeze(
    migrations.map((migration) => Object.freeze({ ...migration })),
  );
}

function validConfiguration(config: RuntimeConfig): boolean {
  // Reuse startup validation, including cross-field requirements. Do not infer
  // provider readiness or silently fill missing fields in an injected config.
  const checked = loadConfig(
    Object.fromEntries(
      Object.entries(config).map(([key, value]) => [
        key,
        value === undefined ? undefined : String(value),
      ]),
    ),
  );
  return Object.entries(checked).every(
    ([key, value]) => config[key as keyof RuntimeConfig] === value,
  );
}

@Injectable()
export class ApplicationReadinessService {
  private requirements: Promise<readonly Migration[]> | undefined;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(APPLICATION_MIGRATIONS)
    private readonly readRequirements: ApplicationMigrations,
  ) {}

  async ready(): Promise<boolean> {
    try {
      if (!validConfiguration(this.config) || !(await this.database.ready()))
        return false;
      // Load the immutable deployment artifact once, sharing concurrent probes.
      // A broken artifact remains unready until repaired and the process restarted.
      const migrations = await (this.requirements ??=
        this.readRequirements().then(validateRequirements));
      return await this.database.transaction(
        async (tx) => {
          await tx.query('SET TRANSACTION READ ONLY');
          const gate = await tx.query<{ locked: boolean }>(
            'SELECT pg_catalog.pg_try_advisory_xact_lock_shared($1::integer, $2::integer) AS locked',
            [...MIGRATION_LOCK],
          );
          if (gate.rows.length !== 1 || gate.rows[0]?.locked !== true)
            return false;
          // A separate READ COMMITTED statement takes its snapshot after the gate.
          // A single SELECT would take its snapshot before acquiring that gate.
          const result = await tx.query<{
            name: string | null;
            checksum: string | null;
          }>(
            `SELECT
            CASE WHEN pg_catalog.octet_length(name) <= 255 THEN name ELSE NULL END AS name,
            CASE WHEN pg_catalog.octet_length(checksum) = 64 THEN checksum ELSE NULL END AS checksum
          FROM whaleu_meta.schema_migrations
          LIMIT $1`,
            [migrations.length + 1],
          );
          // Read at most the expected count plus one, without sorting unbounded
          // history. Missing table/SELECT permission, contention and SQL errors close.
          if (result.rows.length !== migrations.length) return false;
          const applied: { name: string; checksum: string }[] = [];
          for (const row of result.rows) {
            if (
              typeof row.name !== 'string' ||
              typeof row.checksum !== 'string'
            )
              return false;
            applied.push({ name: row.name, checksum: row.checksum });
          }
          if (
            new Set(applied.map(({ name }) => name)).size !== migrations.length
          )
            return false;
          verifyHistory(migrations, applied);
          return true;
        },
        { isolationLevel: 'read committed' },
      );
    } catch {
      // Readiness is public: never disclose filenames, SQL, config or secrets.
      return false;
    }
  }
}
