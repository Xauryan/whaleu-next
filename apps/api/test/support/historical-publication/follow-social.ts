/** TEST ONLY. Separate exact0174 deletion witness, never pre-deletion Identity.
 * Only explicitly opted-in like/save lineage and lifecycle refusal tests use it.
 */
import assert from 'node:assert/strict';
import type { TestingModuleBuilder } from '@nestjs/testing';
import type { PoolClient } from 'pg';
import { APP_CONFIG } from '../../../src/config/config.js';
import type { RuntimeConfig } from '../../../src/config/config.js';
import { DatabaseService } from '../../../src/database/database.js';
import { PublicationService } from '../../../src/community/publication.service.js';
import { AppLogger } from '../../../src/observability/logger.js';
import { AccountPunishmentPolicy } from '../../../src/safety/account-moderation/policy.js';
import { historicalContentDefinitionBoundary } from '../historical-content-definition/configure.js';
import {
  guardedHistoricalPublicationDatabase,
  historicalHomeAbsenceBoundary,
  HistoricalPublicationService,
} from './configure.js';

// Positive lifecycle ownership, not the pre0172 adapter's missing-column rule.
// This is a bounded check of one table's three columns and one enabled trigger.
export const historicalDeletionLifecycleSql = `SELECT
  (SELECT count(*) FROM pg_attribute
   WHERE attrelid=to_regclass('whaleu_identity.accounts') AND NOT attisdropped
     AND (attname,atttypid,attnotnull) IN
       (('lifecycle','text'::regtype,true),
        ('lifecycle_generation','bigint'::regtype,true),
        ('deletion_request_id','uuid'::regtype,false)))=3
  AND EXISTS (SELECT 1 FROM pg_trigger
    WHERE tgrelid=to_regclass('whaleu_identity.accounts')
      AND tgname='deletion_lifecycle_guard' AND NOT tgisinternal AND tgtype=19
      AND tgenabled IN ('O','A')
      AND tgfoid=to_regprocedure('whaleu_account_deletion.lifecycle_guard()')) AS present`;

export async function historicalFollowSocialPublicationBoundary(
  config: RuntimeConfig,
): Promise<(tx: PoolClient) => Promise<void>> {
  // Connection-string parameters can override the apparent host/database in pg.
  // Admit only the literal disposable endpoint, before shared-boundary setup.
  const database = new URL(config.DATABASE_URL);
  assert.ok(['postgres:', 'postgresql:'].includes(database.protocol));
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname));
  assert.equal(database.pathname, '/whaleu_test');
  assert.ok(
    !database.href.includes('?') && !database.href.includes('#'),
    'Exact0174 database URL cannot contain query or fragment syntax',
  );
  const requirePrefix = await historicalContentDefinitionBoundary(config, 174);
  const requireHomeAbsent = await historicalHomeAbsenceBoundary();
  return async (tx) => {
    await requirePrefix(tx);
    await requireHomeAbsent(tx);
    await tx.query(
      'LOCK TABLE whaleu_identity.accounts IN ACCESS SHARE MODE NOWAIT',
    );
    const result = await tx.query<{ present: boolean }>(
      historicalDeletionLifecycleSql,
    );
    assert.equal(
      result.rows[0]?.present,
      true,
      'Exact0174 publication requires the deletion lifecycle owner',
    );
  };
}

export async function configureHistoricalFollowSocialPublication(
  builder: TestingModuleBuilder,
  config: RuntimeConfig,
): Promise<void> {
  const boundary = await historicalFollowSocialPublicationBoundary(config);
  builder.overrideProvider(DatabaseService).useFactory({
    inject: [APP_CONFIG, AppLogger, AccountPunishmentPolicy],
    factory: (
      current: RuntimeConfig,
      logger: AppLogger,
      policy: AccountPunishmentPolicy,
    ) => {
      assert.equal(current.DATABASE_URL, config.DATABASE_URL);
      assert.equal(current.NODE_ENV, 'test');
      assert.equal(current.PG_SSL_MODE, 'disable');
      return guardedHistoricalPublicationDatabase(
        new DatabaseService(current, logger, policy),
        boundary,
      );
    },
  });
  builder
    .overrideProvider(PublicationService)
    .useClass(HistoricalPublicationService);
}
