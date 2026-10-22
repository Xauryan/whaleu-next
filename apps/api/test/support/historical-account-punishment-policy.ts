/** TEST ONLY. Reproduce the pre-0135 overlay (no ledger), never base Safety,
 * Identity, Authorization, Review, phone, or content-owner permission. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { TestingModuleBuilder } from '@nestjs/testing';
import type { RuntimeConfig } from '../../src/config/config.js';
import { readMigrations } from '../../src/database/migrations.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { AccountPunishmentPolicy } from '../../src/safety/account-moderation/policy.js';

import { historicalPrefixes } from './historical-schema-prefixes.js';
import { historicalCommunityDistribution } from './historical-community-distribution.js';
import { configureHistoricalAvatarModeration } from './historical-avatar-moderation/configure.js';
import {
  configureHistoricalContentDefinitions,
  historicalContentDefinitionPrefixes,
} from './historical-content-definition/configure.js';
import {
  configureHistoricalPublication,
  historicalPublicationPrefixes,
} from './historical-publication/configure.js';
import { configureHistoricalIdentity } from './historical-identity/configure.js';
import { CommunityDistributionService } from '../../src/community/related-sync/service.js';
import { ContentReferenceAllocation } from '../../src/community/content-references/allocation.js';
import { historicalContentReferences } from './historical-content-references.js';

// readMigrations hashes checked-in SQL. Share this immutable manifest promise,
// not a database-validation result; the latter must be checked on every call.
let manifest: ReturnType<typeof readMigrations> | undefined;
const checkedInManifest = () =>
  (manifest ??= readMigrations(
    fileURLToPath(new URL('../../migrations', import.meta.url)),
  ));

let introducedObjects:
  Promise<{ tables: string[]; functions: string[] }> | undefined;
const accountModerationObjects = () =>
  (introducedObjects ??= (async () => {
    const migration = (await checkedInManifest()).find(({ name }) =>
      name.startsWith('0135_'),
    );
    assert.ok(
      migration,
      'The current account-moderation migration must be checked in',
    );
    const tables = new Set<string>();
    const functions = new Set<string>();
    // Finite exact inventory from trusted, once-hashed checked-in SQL. Replaced
    // predecessor functions already existed and must not count as new objects.
    for (const match of migration.sql.matchAll(
      /\bCREATE\s+(TABLE|FUNCTION)\s+(whaleu_[a-z_]+\.[a-z_]+)/gi,
    )) {
      (match[1]!.toUpperCase() === 'TABLE' ? tables : functions).add(
        match[2]!.toLowerCase(),
      );
    }
    assert.ok(tables.has('whaleu_safety.account_punishments'));
    assert.ok(tables.has('whaleu_safety.account_appeals'));
    assert.ok(
      tables.has('whaleu_authorization.account_punishment_authority_epoch'),
    );
    assert.ok(
      functions.has('whaleu_safety.account_punishment_policy_observation'),
    );
    return { tables: [...tables].sort(), functions: [...functions].sort() };
  })());

export async function historicalAccountPunishmentPolicy(
  config: RuntimeConfig,
  prefix: number,
): Promise<AccountPunishmentPolicy> {
  assert.equal(config.NODE_ENV, 'test');
  const database = new URL(config.DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname));
  assert.equal(database.pathname, '/whaleu_test');
  assert.equal(config.PG_SSL_MODE, 'disable');
  assert.ok(
    historicalPrefixes.has(prefix) && prefix < 135,
    `Unregistered historical prefix ${prefix}`,
  );
  const expected = (await checkedInManifest())
    .filter((migration) => Number(migration.name.slice(0, 4)) <= prefix)
    .map(({ name, checksum }) => ({ name, checksum }));
  assert.equal(Number(expected.at(-1)?.name.slice(0, 4)), prefix);
  const signature = JSON.stringify(expected);
  const introduced = await accountModerationObjects();
  return {
    async enforce(_accountId, _action, tx) {
      try {
        const actual = await tx.query<{ name: string; checksum: string }>(
          'SELECT name,checksum FROM whaleu_meta.schema_migrations ORDER BY name LIMIT $1',
          [expected.length + 1],
        );
        if (JSON.stringify(actual.rows) !== signature)
          throw new Error('Historical migration prefix changed');
        // Reject partial ledger deployment too, including a function installed
        // without its tables or an added ledger table without a migration row.
        const ledger = await tx.query<{ absent: boolean }>(
          `SELECT
          NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE (n.nspname || '.' || c.relname)=ANY($1::text[]))
          AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE (n.nspname || '.' || p.proname)=ANY($2::text[])) AS absent`,
          [introduced.tables, introduced.functions],
        );
        if (ledger.rows[0]?.absent !== true)
          throw new Error(
            'Historical schema contains account punishment ledger',
          );
      } catch {
        throw new ApplicationError('SAFETY_UNAVAILABLE');
      }
    },
  };
}

export async function configureHistoricalAccountPolicy(
  builder: TestingModuleBuilder,
  config: RuntimeConfig,
  prefix?: number,
): Promise<void> {
  if (prefix === undefined) return;
  assert.ok(
    historicalPrefixes.has(prefix),
    `Unregistered historical prefix ${prefix}`,
  );
  await configureHistoricalIdentity(builder, config, prefix);
  if (historicalPublicationPrefixes.includes(prefix))
    await configureHistoricalPublication(builder, config, prefix);
  if (prefix < 171)
    builder
      .overrideProvider(ContentReferenceAllocation)
      .useValue(await historicalContentReferences(config, prefix));
  if (prefix === 132)
    await configureHistoricalAvatarModeration(builder, config, prefix);
  if (historicalContentDefinitionPrefixes.includes(prefix))
    await configureHistoricalContentDefinitions(builder, config, prefix);
  // Boundaries at or after 0138 retain the real distribution owner. The
  // historical adapter remains restricted to its exact pre-0138 registry.
  if (prefix < 138)
    builder
      .overrideProvider(CommunityDistributionService)
      .useValue(await historicalCommunityDistribution(config, prefix));
  if (prefix < 135)
    builder
      .overrideProvider(AccountPunishmentPolicy)
      .useValue(await historicalAccountPunishmentPolicy(config, prefix));
}
