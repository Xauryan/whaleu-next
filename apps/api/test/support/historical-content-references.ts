/** TEST ONLY. Reproduce the absence of reference allocation before 0171.
 * Never used by production or by a current-schema fixture. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { RuntimeConfig } from '../../src/config/config.js';
import {
  MIGRATION_LOCK,
  readMigrations,
} from '../../src/database/migrations.js';
import { transactionLifetime } from '../../src/database/transaction-deadlines.js';
import { ApplicationError } from '../../src/http/application-error.js';
import type { ContentReferenceAllocation } from '../../src/community/content-references/allocation.js';
import { referenceTargetSchema } from '../../src/community/content-references/contracts.js';
import { historicalPrefixes } from './historical-schema-prefixes.js';

export async function historicalContentReferences(
  config: RuntimeConfig,
  prefix: number,
): Promise<Pick<ContentReferenceAllocation, 'allocateForPublication'>> {
  assert.equal(config.NODE_ENV, 'test');
  const database = new URL(config.DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname));
  assert.equal(database.pathname, '/whaleu_test');
  assert.equal(config.PG_SSL_MODE, 'disable');
  assert.ok(
    ![...database.searchParams.keys()].some((key) => /^ssl/i.test(key)),
  );
  assert.ok(historicalPrefixes.has(prefix) && prefix < 171);
  const migrations = await readMigrations(
    fileURLToPath(new URL('../../migrations', import.meta.url)),
  );
  const expected = migrations
    .filter(({ name }) => Number(name.slice(0, 4)) <= prefix)
    .map(({ name, checksum }) => ({ name, checksum }));
  assert.equal(Number(expected.at(-1)?.name.slice(0, 4)), prefix);
  const introduced = migrations.find(({ name }) => name.startsWith('0171_'));
  assert.ok(introduced);
  // This historical seam covers only the additive, separately named owner.
  // Any future change to that assumption requires a new reviewed fixture.
  assert.equal(/\b(?:ALTER|DROP)\s/i.test(introduced.sql), false);
  for (const match of introduced.sql.matchAll(
    /\bCREATE\s+(TABLE|FUNCTION)\s+([a-z_]+\.[a-z_]+)/gi,
  ))
    assert.ok(match[2]!.startsWith('whaleu_community.content_reference_'));
  const signature = JSON.stringify(expected);
  return {
    async allocateForPublication(target, tx) {
      try {
        referenceTargetSchema.parse(target);
        if (!transactionLifetime(tx)) throw new Error('Unmanaged transaction');
        // Nonblocking shared fence conflicts with the actual migration runner's
        // exclusive session lock. The historical prefix cannot advance mid-TX.
        const lock = await tx.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_xact_lock_shared($1,$2) AS locked',
          [...MIGRATION_LOCK],
        );
        if (lock.rows[0]?.locked !== true)
          throw new Error('Migration in progress');
        const applied = await tx.query<{ name: string; checksum: string }>(
          'SELECT name,checksum FROM whaleu_meta.schema_migrations ORDER BY name LIMIT $1',
          [expected.length + 1],
        );
        if (JSON.stringify(applied.rows) !== signature)
          throw new Error('Historical prefix changed');
        const catalog = await tx.query<{ absent: boolean }>(
          `SELECT
          NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='whaleu_community' AND c.relname LIKE 'content_reference_%')
          AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
            WHERE n.nspname='whaleu_community' AND p.proname LIKE 'content_reference_%')
          AND NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname='whaleu_community' AND t.tgname LIKE 'content_reference_%') AS absent`,
        );
        if (catalog.rows[0]?.absent !== true)
          throw new Error('Partially installed reference owner');
        return { state: 'inactive' };
      } catch {
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      }
    },
  };
}
