/** TEST ONLY. The exact c27 reader for four explicitly registered historical
 * fixtures. Current Review/Media/Safety/authorization and validation stay real.
 * This is neither an empty text-source mock nor a missing-table fallback.
 * The same closed boundary also gates the absent c27 reading-enrollment hook. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { TestingModuleBuilder } from '@nestjs/testing';
import type { PoolClient } from 'pg';
import { CampusService } from '../../../src/campus/campus.service.js';
import type { RuntimeConfig } from '../../../src/config/config.js';
import {
  MIGRATION_LOCK,
  readMigrations,
} from '../../../src/database/migrations.js';
import { transactionLifetime } from '../../../src/database/transaction-deadlines.js';
import { ContentDefinitionRepository } from '../../../src/community/content-review/content-definition.repository.js';
import { historicalPrefixes } from '../historical-schema-prefixes.js';
import { ContentDefinitionRepository as PredecessorContentDefinitionRepository } from './content-definition.repository.js';
import { configureHistoricalReadingEnrollment } from './reading-enrollment.js';

// Closed caller inventory, not a less-than-current compatibility mode:
// 0132 session retention, 0137 related-sync upgrade, 0144 pre0148 card upgrade,
// 0174 follow/social deletion predecessor.
export const historicalContentDefinitionPrefixes = Object.freeze([
  132, 137, 144, 174,
]);

/** All independently installable 0175 object families, including its renamed
 * predecessor function, added columns, constraints, indexes and dynamic triggers.
 * Existing replaced functions are not new objects and are not excluded. */
export const historicalTextSourceAbsenceSql = `SELECT
  NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='whaleu_community' AND (starts_with(c.relname,'community_text_sources') OR starts_with(c.relname,'text_source_')))
  AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='whaleu_community' AND (starts_with(p.proname,'text_source_') OR p.proname='profile_moderation_definition_pre_text_source'))
  AND NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='whaleu_community' AND starts_with(t.tgname,'text_source_'))
  AND NOT EXISTS (SELECT 1 FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='whaleu_community' AND NOT a.attisdropped AND starts_with(a.attname,'text_source_'))
  AND NOT EXISTS (SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace
    WHERE n.nspname='whaleu_community' AND starts_with(c.conname,'text_source_'))
  AND NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname='whaleu_community' AND t.typname=ANY(ARRAY['community_text_sources','_community_text_sources'])) AS absent`;

export class HistoricalContentDefinitionRepository extends PredecessorContentDefinitionRepository {
  constructor(
    campuses: CampusService,
    private readonly requirePrefix: (tx: PoolClient) => Promise<void>,
  ) {
    super(campuses);
  }

  override async current(
    ...args: Parameters<PredecessorContentDefinitionRepository['current']>
  ) {
    await this.requirePrefix(args[3]);
    const result = await super.current(...args);
    await this.requirePrefix(args[3]);
    return result;
  }

  override async newRelatedRoot(
    ...args: Parameters<
      PredecessorContentDefinitionRepository['newRelatedRoot']
    >
  ) {
    await this.requirePrefix(args[2]);
    const result = await super.newRelatedRoot(...args);
    await this.requirePrefix(args[2]);
    return result;
  }
}

export async function historicalContentDefinitionBoundary(
  config: RuntimeConfig,
  prefix: number,
): Promise<(tx: PoolClient) => Promise<void>> {
  assert.equal(config.NODE_ENV, 'test');
  const database = new URL(config.DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname));
  assert.equal(database.pathname, '/whaleu_test');
  assert.equal(config.PG_SSL_MODE, 'disable');
  assert.ok(
    ![...database.searchParams.keys()].some((key) => /^ssl/i.test(key)),
  );
  assert.ok(
    historicalPrefixes.has(prefix) &&
      historicalContentDefinitionPrefixes.includes(prefix),
  );
  const expected = (
    await readMigrations(
      fileURLToPath(new URL('../../../migrations', import.meta.url)),
    )
  )
    .filter(({ name }) => Number(name.slice(0, 4)) <= prefix)
    .map(({ name, checksum }) => ({ name, checksum }));
  assert.equal(Number(expected.at(-1)?.name.slice(0, 4)), prefix);
  const requirePrefix = async (tx: PoolClient): Promise<void> => {
    assert.ok(
      transactionLifetime(tx),
      'Historical content definitions require a managed transaction',
    );
    // Retained until the SAME caller transaction commits. This conflicts with
    // the actual migration runner, not an unrelated fixture-only lock.
    const lock = await tx.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_xact_lock_shared($1,$2) AS locked',
      [...MIGRATION_LOCK],
    );
    assert.equal(lock.rows[0]?.locked, true, 'Historical schema is upgrading');
    await tx.query(
      'LOCK TABLE whaleu_meta.schema_migrations IN SHARE MODE NOWAIT',
    );
    const actual = await tx.query(
      'SELECT name,checksum FROM whaleu_meta.schema_migrations ORDER BY name LIMIT $1',
      [expected.length + 1],
    );
    assert.deepEqual(
      actual.rows,
      expected,
      'Historical content definitions cannot cross an upgrade',
    );
    const objects = await tx.query<{ absent: boolean }>(
      historicalTextSourceAbsenceSql,
    );
    assert.equal(
      objects.rows[0]?.absent,
      true,
      'Partial text-source schema is not a predecessor',
    );
  };
  return requirePrefix;
}

export async function historicalContentDefinitionRepository(
  campuses: CampusService,
  config: RuntimeConfig,
  prefix: number,
): Promise<HistoricalContentDefinitionRepository> {
  return new HistoricalContentDefinitionRepository(
    campuses,
    await historicalContentDefinitionBoundary(config, prefix),
  );
}

export async function configureHistoricalContentDefinitions(
  builder: TestingModuleBuilder,
  config: RuntimeConfig,
  prefix: number,
): Promise<void> {
  assert.ok(
    historicalPrefixes.has(prefix) &&
      historicalContentDefinitionPrefixes.includes(prefix),
  );
  const requirePrefix = await historicalContentDefinitionBoundary(
    config,
    prefix,
  );
  builder.overrideProvider(ContentDefinitionRepository).useFactory({
    inject: [CampusService],
    factory: (campuses: CampusService) =>
      new HistoricalContentDefinitionRepository(campuses, requirePrefix),
  });
  configureHistoricalReadingEnrollment(builder, requirePrefix);
}
