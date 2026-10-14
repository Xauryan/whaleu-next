/** TEST ONLY: genuine signed predecessor owner for the exact 0132 upgrade
 * fixture. Never installed by AppModule or selected by production schema probing. */
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import type { TestingModuleBuilder } from '@nestjs/testing';
import type { PoolClient } from 'pg';
import type { RuntimeConfig } from '../../../src/config/config.js';
import { DatabaseService } from '../../../src/database/database.js';
import type { TransactionOptions } from '../../../src/database/database.js';
import { readMigrations } from '../../../src/database/migrations.js';
import { IdentityService } from '../../../src/identity/identity.service.js';
import { AuthorizationService } from '../../../src/authorization/authorization.service.js';
import { ProfileModerationTargetFacade } from '../../../src/community/profile-moderation-target.facade.js';
import { ProfileRepository } from '../../../src/profile/profile.repository.js';
import { ProfileAvatarService } from '../../../src/profile/avatar/service.js';
import { ProfileAvatarModerationService } from '../../../src/profile/avatar-moderation/service.js';
import { ProfileAvatarModerationService as HistoricalAvatarModerationService } from './service.js';

export async function configureHistoricalAvatarModeration(
  builder: TestingModuleBuilder,
  config: RuntimeConfig,
  prefix: number,
): Promise<void> {
  assert.equal(
    prefix,
    132,
    'Only the exact session-retention predecessor is supported',
  );
  assert.equal(config.NODE_ENV, 'test');
  assert.equal(process.env['WHALEU_TEST_MAINTENANCE'], 'controlled');
  const databaseUrl = new URL(config.DATABASE_URL);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname));
  assert.equal(databaseUrl.pathname, '/whaleu_test');
  assert.equal(config.PG_SSL_MODE, 'disable');
  const expected = (
    await readMigrations(
      fileURLToPath(new URL('../../../migrations', import.meta.url)),
    )
  )
    .filter(({ name }) => Number(name.slice(0, 4)) <= prefix)
    .map(({ name, checksum }) => ({ name, checksum }));
  assert.equal(Number(expected.at(-1)?.name.slice(0, 4)), prefix);
  const requirePrefix = async (tx: PoolClient) => {
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
      'Historical avatar owner cannot cross an upgrade',
    );
    const objects = await tx.query<{ absent: boolean }>(
      `SELECT to_regclass('whaleu_community.rating_target_link_generation') IS NULL
       AND to_regclass('whaleu_profile.avatar_moderation_rating_epochs') IS NULL
       AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='whaleu_profile' AND p.proname=ANY(ARRAY[
           'avatar_moderation_community_vector','avatar_moderation_rating_epoch_guard',
           'avatar_moderation_rating_epoch_inventory_current','avatar_moderation_rating_original_community',
           'avatar_moderation_rating_inputs_current','avatar_moderation_command_community'])) AS absent`,
    );
    assert.equal(
      objects.rows[0]?.absent,
      true,
      'No partial current avatar bridge is allowed',
    );
  };
  builder.overrideProvider(ProfileAvatarModerationService).useFactory({
    inject: [
      DatabaseService,
      IdentityService,
      AuthorizationService,
      ProfileModerationTargetFacade,
      ProfileRepository,
      ProfileAvatarService,
    ],
    factory: (
      database: DatabaseService,
      identity: IdentityService,
      authorization: AuthorizationService,
      targets: ProfileModerationTargetFacade,
      profiles: ProfileRepository,
      avatar: ProfileAvatarService,
    ) => {
      const guardedDatabase = new Proxy(database, {
        get(target, property, receiver) {
          if (property !== 'transaction')
            return Reflect.get(target, property, receiver);
          return <T>(
            operation: (tx: PoolClient) => Promise<T>,
            options?: TransactionOptions,
          ) =>
            database.transaction(async (tx) => {
              await requirePrefix(tx);
              const value = await operation(tx);
              await requirePrefix(tx);
              return value;
            }, options);
        },
      });
      return new HistoricalAvatarModerationService(
        guardedDatabase,
        identity,
        authorization,
        targets,
        profiles,
        avatar,
      );
    },
  });
}
