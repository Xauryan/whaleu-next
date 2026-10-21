/** TEST ONLY. Explicit schema-0167 rehearsal and synthetic external identity
 * provider. No auth rows, acceptance verdicts or migration timestamps invented. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Pool } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { APP_CONFIG } from '../../src/config/config.js';
import type { RuntimeConfig } from '../../src/config/config.js';
import { DatabaseService } from '../../src/database/database.js';
import { readMigrations } from '../../src/database/migrations.js';
import { IDENTITY_PROVIDER } from '../../src/identity/contracts.js';
import type {
  IdentityProvider,
  SessionCredentials,
} from '../../src/identity/contracts.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { IdentityService } from '../../src/identity/identity.service.js';
import type { DiscussionOrderCutoverHooks } from '../integration/search-fixtures.js';
import { discussionOrderUpgradeIdentity } from './discussion-order-upgrade-identity.js';

export function discussionOrderUpgradeFixture() {
  let phase: 'unstarted' | 'historical-0167' | 'current' = 'unstarted';
  let installedConfig: RuntimeConfig | undefined;
  let exchanges = 0;
  const pendingCodes = new Set<string>();
  const provider: IdentityProvider = {
    async exchange(code) {
      assert.ok(phase === 'historical-0167' || phase === 'current');
      assert.ok(
        pendingCodes.delete(code),
        'Only a fixture-issued synthetic code may enroll',
      );
      exchanges++;
      return {
        provider: 'wechat',
        appId: 'synthetic-discussion-order-upgrade-only',
        subject: code,
      };
    },
  };
  const hooks: DiscussionOrderCutoverHooks = {
    async createApp(config, requestedPhase) {
      assert.equal(config.NODE_ENV, 'test');
      assert.equal(config.NATIVE_VERIFICATION_ENROLLMENT, 'disabled');
      assert.equal(
        phase,
        requestedPhase === 'historical-0167' ? 'unstarted' : 'historical-0167',
      );
      // One-way lifetime. Failed current compilation never restores predecessor.
      phase = requestedPhase;
      const nextConfig = { ...config, AUTH_RATE_LIMIT_KEY: '04'.repeat(32) };
      if (installedConfig) assert.deepEqual(nextConfig, installedConfig);
      else installedConfig = nextConfig;
      const builder = Test.createTestingModule({
        imports: [AppModule.register(installedConfig)],
      });
      builder.overrideProvider(IDENTITY_PROVIDER).useValue(provider);
      if (requestedPhase === 'historical-0167') {
        builder.overrideProvider(IdentityRepository).useFactory({
          inject: [DatabaseService, APP_CONFIG],
          factory: (database: DatabaseService, actualConfig: RuntimeConfig) =>
            discussionOrderUpgradeIdentity(
              database,
              actualConfig,
              () => phase === 'historical-0167',
            ),
        });
        // Keep the real service, explicitly bound to this exact historical owner.
        builder.overrideProvider(IdentityService).useFactory({
          inject: [IDENTITY_PROVIDER, IdentityRepository],
          factory: (port: IdentityProvider, owner: IdentityRepository) =>
            new IdentityService(port, owner),
        });
      }
      // Current phase has NO IdentityRepository/IdentityService override.
      return (await builder.compile()).createNestApplication({ logger: false });
    },
    async createActor(app: INestApplication): Promise<SessionCredentials> {
      assert.equal(app.get(APP_CONFIG), installedConfig);
      const code = `discussion-upgrade-${randomUUID()}`;
      pendingCodes.add(code);
      try {
        const result = await request(app.getHttpServer())
          .post('/v1/auth/wechat/login')
          .send({ code });
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.deepEqual(Object.keys(result.body).sort(), [
          'accessToken',
          'accountId',
          'expiresAt',
          'refreshExpiresAt',
          'refreshToken',
          'sessionId',
        ]);
        for (const key of [
          'accountId',
          'sessionId',
          'accessToken',
          'refreshToken',
        ])
          assert.equal(typeof result.body[key], 'string');
        for (const key of ['expiresAt', 'refreshExpiresAt'])
          assert.equal(typeof result.body[key], 'number');
        return result.body as SessionCredentials;
      } finally {
        pendingCodes.delete(code);
      }
    },
  };
  const assertOldSchema = async (pool: Pool) => {
    assert.equal(phase, 'historical-0167');
    const expected = (
      await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      )
    )
      .filter(({ name }) => Number(name.slice(0, 4)) <= 167)
      .map(({ name, checksum }) => ({ name, checksum }));
    assert.equal(expected.at(-1)?.name, '0167_personal_timetable.sql');
    assert.deepEqual(
      (
        await pool.query(
          'SELECT name,checksum FROM whaleu_meta.schema_migrations ORDER BY name',
        )
      ).rows,
      expected,
    );
    const state = (
      await pool.query<{ absent: boolean }>(`
      SELECT NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='whaleu_account_deletion')
      AND NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid='whaleu_identity.accounts'::regclass
        AND NOT attisdropped AND attname=ANY(ARRAY['lifecycle','lifecycle_generation','deletion_request_id']))
      AND to_regclass('whaleu_community.discussion_root_order') IS NULL
      AND to_regclass('whaleu_community.discussion_order_memberships') IS NULL
      AND to_regclass('whaleu_community.discussion_order_events') IS NULL
      AND to_regclass('whaleu_community.discussion_live_root_order') IS NULL AS absent`)
    ).rows[0];
    assert.equal(
      state?.absent,
      true,
      'The real pre-0168 schema must remain installed',
    );
  };
  return {
    hooks,
    assertOldSchema,
    provider,
    providerExchanges: () => exchanges,
  };
}
