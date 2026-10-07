import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { loadConfig } from '../../src/config/config.js';
import {
  DatabaseService,
  poolOptions,
  supportedPostgresVersion,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { IdentityMaintenance } from '../../src/identity/maintenance.js';
import { IdentityService } from '../../src/identity/identity.service.js';
import { IdentityRateLimiter } from '../../src/identity/rate-limit.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import { AppLogger } from '../../src/observability/logger.js';

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof ApplicationError && error.code === code;
}

test(
  'real PostgreSQL identity sessions, uniqueness, expiry, replay and revocation',
  { timeout: 60000 },
  async (t) => {
    const urlString = process.env['TEST_DATABASE_URL'];
    assert.ok(
      urlString,
      'Set TEST_DATABASE_URL to disposable local whaleu_test; integration tests never silently skip',
    );
    const url = new URL(urlString);
    assert.ok(
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
      'Integration tests require loopback',
    );
    assert.equal(
      url.pathname,
      '/whaleu_test',
      'Integration tests require dedicated whaleu_test database',
    );
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: urlString,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '8',
      PG_CONNECTION_TIMEOUT_MS: '3000',
      PG_STATEMENT_TIMEOUT_MS: '10000',
      WECHAT_APP_ID: 'wx0000000000000000',
      WECHAT_APP_SECRET: 'synthetic-provider-secret-for-integration-only',
      AUTH_RATE_LIMIT_KEY: '02'.repeat(32),
    });
    const pool = new Pool(poolOptions(config));
    const database = new DatabaseService(config, new AppLogger(config));
    const repository = new IdentityRepository(database);
    // No test can contact WeChat: this provider only returns explicitly synthetic identifiers.
    const service = new IdentityService(
      {
        exchange: async (code) => ({
          provider: 'wechat',
          appId: config.WECHAT_APP_ID!,
          subject: `synthetic-${code}`,
        }),
      },
      repository,
    );
    let suiteClient: PoolClient | undefined;
    let ownsSchema = false;
    let suiteLocked = false;
    try {
      suiteClient = await pool.connect();
      const lease = await suiteClient.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1,$2) AS locked',
        [MIGRATION_LOCK[0], 2],
      );
      suiteLocked = lease.rows[0]?.locked === true;
      assert.equal(
        suiteLocked,
        true,
        'Another suite is using the disposable database; run integration files serially',
      );
      const version = await pool.query<{ version: number }>(
        "SELECT current_setting('server_version_num')::integer AS version",
      );
      assert.ok(
        supportedPostgresVersion(version.rows[0]?.version ?? 0),
        'PostgreSQL 18.6+ (18.x) is required',
      );
      const existing = await pool.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname IN ('whaleu_meta','whaleu_identity')",
      );
      assert.equal(
        existing.rows[0]?.count,
        0,
        'Refusing to touch existing schemas; use a new disposable database',
      );
      const migrations = await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      );
      assert.ok(
        migrations.some(({ name }) => name === '0001_identity_sessions.sql'),
      );
      ownsSchema = true;
      await runMigrations(pool, migrations, { mode: 'up' });
      await runMigrations(pool, migrations, { mode: 'up' });

      await t.test(
        'real migration preserves ID mappings and stores hashes rather than tokens',
        async () => {
          const credentials = await service.login('new-user');
          assert.equal(
            (await service.session(credentials.accessToken)).accountId,
            credentials.accountId,
          );
          const accounts = await pool.query<{ id: string }>(
            'SELECT id FROM whaleu_identity.accounts',
          );
          assert.equal(accounts.rowCount, 1);
          await pool.query(
            'INSERT INTO whaleu_identity.legacy_account_mappings (source_system,legacy_id,account_id) VALUES ($1,$2,$3)',
            [
              'synthetic-import',
              '900719925474099312345',
              credentials.accountId,
            ],
          );
          const mapped = await pool.query<{ legacy_id: string }>(
            'SELECT legacy_id FROM whaleu_identity.legacy_account_mappings',
          );
          assert.equal(mapped.rows[0]?.legacy_id, '900719925474099312345');
          const hashes = await pool.query<{ token_hash: string }>(
            'SELECT token_hash FROM whaleu_identity.access_tokens UNION ALL SELECT token_hash FROM whaleu_identity.refresh_tokens',
          );
          assert.equal(hashes.rowCount, 2);
          for (const row of hashes.rows)
            assert.match(row.token_hash, /^[a-f0-9]{64}$/);
          assert.ok(
            hashes.rows.some(
              ({ token_hash }) =>
                token_hash === hashToken(credentials.accessToken),
            ),
          );
          assert.ok(
            !JSON.stringify(hashes.rows).includes(credentials.refreshToken),
          );
        },
      );

      await t.test(
        'failed token insertion rolls back new account, provider identity and session together',
        async () => {
          const first = await service.login('rollback-source');
          await assert.rejects(
            repository.createSession(
              {
                provider: 'wechat',
                appId: config.WECHAT_APP_ID!,
                subject: 'synthetic-rollback-target',
              },
              {
                access: hashToken(first.accessToken),
                refresh: hashToken(mintToken('refresh')),
              },
            ),
          );
          const rows = await pool.query<{ count: number }>(
            'SELECT count(*)::integer AS count FROM whaleu_identity.provider_identities WHERE subject=$1',
            ['synthetic-rollback-target'],
          );
          assert.equal(rows.rows[0]?.count, 0);
          assert.equal(
            (await service.session(first.accessToken)).accountId,
            first.accountId,
          );
        },
      );

      await t.test(
        'concurrent first logins create one account, one provider identity and at most ten active sessions',
        async () => {
          const logins = await Promise.all(
            Array.from({ length: 12 }, () => service.login('parallel')),
          );
          assert.equal(
            new Set(logins.map(({ accountId }) => accountId)).size,
            1,
          );
          assert.equal(
            new Set(logins.map(({ sessionId }) => sessionId)).size,
            12,
          );
          const accountId = logins[0]!.accountId;
          const identities = await pool.query<{ count: number }>(
            'SELECT count(*)::integer AS count FROM whaleu_identity.provider_identities WHERE account_id=$1',
            [accountId],
          );
          assert.equal(identities.rows[0]?.count, 1);
          const active = await pool.query<{ count: number }>(
            'SELECT count(*)::integer AS count FROM whaleu_identity.sessions WHERE account_id=$1 AND revoked_at IS NULL',
            [accountId],
          );
          assert.equal(active.rows[0]?.count, 10);
        },
      );

      await t.test(
        'refresh rotates both credentials, invalidates old access, and replay commits family revocation',
        async () => {
          const first = await service.login('rotate');
          const next = await service.refresh(first.refreshToken);
          assert.equal(next.accountId, first.accountId);
          assert.equal(next.sessionId, first.sessionId);
          assert.notEqual(next.accessToken, first.accessToken);
          assert.notEqual(next.refreshToken, first.refreshToken);
          await assert.rejects(
            service.session(first.accessToken),
            hasCode('ACCESS_TOKEN_EXPIRED'),
          );
          assert.equal(
            (await service.session(next.accessToken)).accountId,
            first.accountId,
          );
          await assert.rejects(
            service.refresh(first.refreshToken),
            hasCode('REFRESH_TOKEN_REUSED'),
          );
          await assert.rejects(
            service.session(next.accessToken),
            hasCode('SESSION_REVOKED'),
          );
          await assert.rejects(
            service.refresh(next.refreshToken),
            hasCode('SESSION_REVOKED'),
          );
          const row = await pool.query<{ revoke_reason: string }>(
            'SELECT revoke_reason FROM whaleu_identity.sessions WHERE id=$1',
            [first.sessionId],
          );
          assert.equal(row.rows[0]?.revoke_reason, 'refresh_replay');
        },
      );

      await t.test(
        'duplicate concurrent refresh has one success and a committed replay revocation',
        async () => {
          const first = await service.login('refresh-race');
          const results = await Promise.allSettled([
            service.refresh(first.refreshToken),
            service.refresh(first.refreshToken),
          ]);
          const success = results.filter(
            (result) => result.status === 'fulfilled',
          );
          const failure = results.filter(
            (result) => result.status === 'rejected',
          );
          assert.equal(success.length, 1);
          assert.equal(failure.length, 1);
          assert.ok(hasCode('REFRESH_TOKEN_REUSED')(failure[0]?.reason));
          await assert.rejects(
            service.session(success[0]!.value.accessToken),
            hasCode('SESSION_REVOKED'),
          );
        },
      );

      await t.test(
        'logout is idempotent and works with historical expired access after rotation',
        async () => {
          const first = await service.login('logout');
          const next = await service.refresh(first.refreshToken);
          await service.logout(first.accessToken);
          await service.logout(first.accessToken);
          await assert.rejects(
            service.session(next.accessToken),
            hasCode('SESSION_REVOKED'),
          );
          await assert.rejects(
            service.refresh(next.refreshToken),
            hasCode('SESSION_REVOKED'),
          );
          await assert.rejects(
            service.logout(mintToken('access')),
            hasCode('AUTHENTICATION_REQUIRED'),
          );
        },
      );

      await t.test(
        'logout racing refresh always leaves the session revoked',
        async () => {
          for (let index = 0; index < 4; index += 1) {
            const first = await service.login(`logout-race-${index}`);
            const results = await Promise.allSettled([
              service.refresh(first.refreshToken),
              service.logout(first.accessToken),
            ]);
            assert.equal(results[1]?.status, 'fulfilled');
            const rotated = results[0];
            if (rotated?.status === 'fulfilled')
              await assert.rejects(
                service.session(rotated.value.accessToken),
                hasCode('SESSION_REVOKED'),
              );
            else
              assert.ok(
                rotated?.status === 'rejected' &&
                  hasCode('SESSION_REVOKED')(rotated.reason),
              );
            await assert.rejects(
              service.session(first.accessToken),
              hasCode('SESSION_REVOKED'),
            );
          }
        },
      );

      await t.test(
        'expiry and blocked account state are enforced from the database, not stale token claims',
        async () => {
          const expired = await service.login('expired');
          await pool.query(
            "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()-interval '1 minute' WHERE session_id=$1",
            [expired.sessionId],
          );
          await assert.rejects(
            service.session(expired.accessToken),
            hasCode('ACCESS_TOKEN_EXPIRED'),
          );
          await pool.query(
            "UPDATE whaleu_identity.sessions SET access_expires_at=clock_timestamp()-interval '2 minutes',refresh_expires_at=clock_timestamp()-interval '1 minute' WHERE id=$1",
            [expired.sessionId],
          );
          await assert.rejects(
            service.refresh(expired.refreshToken),
            hasCode('REFRESH_TOKEN_EXPIRED'),
          );
          const blocked = await service.login('blocked');
          await pool.query(
            "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
            [blocked.accountId],
          );
          await assert.rejects(
            service.session(blocked.accessToken),
            hasCode('ACCOUNT_BLOCKED'),
          );
          await assert.rejects(
            service.refresh(blocked.refreshToken),
            hasCode('ACCOUNT_BLOCKED'),
          );
          await assert.rejects(
            service.login('blocked'),
            hasCode('ACCOUNT_BLOCKED'),
          );
          await service.logout(blocked.accessToken);
        },
      );

      await t.test(
        'refresh cannot extend absolute session lifetime and unknown tokens disclose no identity',
        async () => {
          const first = await service.login('absolute');
          const until = new Date(Date.now() + 5 * 60 * 1000);
          await pool.query(
            'UPDATE whaleu_identity.sessions SET access_expires_at=$2,refresh_expires_at=$2,absolute_expires_at=$2 WHERE id=$1',
            [first.sessionId, until],
          );
          const next = await service.refresh(first.refreshToken);
          assert.equal(next.refreshExpiresAt, until.getTime());
          assert.equal(next.expiresAt, until.getTime());
          await assert.rejects(
            service.session(mintToken('access')),
            hasCode('AUTHENTICATION_REQUIRED'),
          );
          await assert.rejects(
            service.refresh(mintToken('refresh')),
            hasCode('AUTHENTICATION_REQUIRED'),
          );
        },
      );

      await t.test(
        'app scopes cannot accidentally merge identities or unverified union subjects',
        async () => {
          const hashes = () => ({
            access: hashToken(mintToken('access')),
            refresh: hashToken(mintToken('refresh')),
          });
          const subject = `synthetic-${randomUUID()}`;
          const one = await repository.createSession(
            {
              provider: 'wechat',
              appId: 'synthetic-app-one',
              subject,
              unionSubject: 'same-union',
            },
            hashes(),
          );
          const two = await repository.createSession(
            {
              provider: 'wechat',
              appId: 'synthetic-app-two',
              subject,
              unionSubject: 'same-union',
            },
            hashes(),
          );
          assert.notEqual(one.accountId, two.accountId);
        },
      );

      await t.test(
        'maintenance dry-run is non-mutating and tiny apply batches preserve accounts, mappings and active replay history',
        async () => {
          const maintenance = new IdentityMaintenance(database);
          const active = await service.login('maintenance-active');
          const activeNext = await service.refresh(active.refreshToken);
          const expired = await service.login('maintenance-expired');
          const revoked = await service.login('maintenance-revoked');
          const recent = await service.login('maintenance-recent');
          await service.logout(recent.accessToken);
          await pool.query(
            "UPDATE whaleu_identity.sessions SET access_expires_at=clock_timestamp()-interval '33 days', refresh_expires_at=clock_timestamp()-interval '32 days', absolute_expires_at=clock_timestamp()-interval '31 days' WHERE id=$1",
            [expired.sessionId],
          );
          await pool.query(
            "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp()-interval '31 days',revoke_reason='logout' WHERE id=$1",
            [revoked.sessionId],
          );
          await pool.query(
            'INSERT INTO whaleu_identity.legacy_account_mappings (source_system,legacy_id,account_id) VALUES ($1,$2,$3)',
            ['synthetic-maintenance', 'preserve-legacy-id', expired.accountId],
          );
          const count = async () =>
            (
              await pool.query<{
                sessions: number;
                access: number;
                refresh: number;
                accounts: number;
                identities: number;
                mappings: number;
              }>(`SELECT
          (SELECT count(*)::integer FROM whaleu_identity.sessions) AS sessions,
          (SELECT count(*)::integer FROM whaleu_identity.access_tokens) AS access,
          (SELECT count(*)::integer FROM whaleu_identity.refresh_tokens) AS refresh,
          (SELECT count(*)::integer FROM whaleu_identity.accounts) AS accounts,
          (SELECT count(*)::integer FROM whaleu_identity.provider_identities) AS identities,
          (SELECT count(*)::integer FROM whaleu_identity.legacy_account_mappings) AS mappings`)
            ).rows[0]!;
          const before = await count();
          const preview = await maintenance.run({ batchSize: 1 });
          assert.equal(preview.candidateSessions, 1);
          assert.equal(
            preview.accessTokens + preview.refreshTokens + preview.sessions,
            1,
          );
          assert.deepEqual(await count(), before);
          let deleted = 0;
          for (let index = 0; index < 10; index += 1) {
            const batch = await maintenance.run({
              mode: 'apply',
              batchSize: 1,
            });
            const rows =
              batch.accessTokens + batch.refreshTokens + batch.sessions;
            assert.ok(rows <= 1);
            if (!rows) break;
            deleted += rows;
          }
          assert.equal(deleted, 6);
          const after = await count();
          assert.equal(after.sessions, before.sessions - 2);
          assert.equal(after.access, before.access - 2);
          assert.equal(after.refresh, before.refresh - 2);
          assert.equal(after.accounts, before.accounts);
          assert.equal(after.identities, before.identities);
          assert.equal(after.mappings, before.mappings);
          assert.equal(
            (await service.session(activeNext.accessToken)).sessionId,
            active.sessionId,
          );
          await assert.rejects(
            service.refresh(active.refreshToken),
            hasCode('REFRESH_TOKEN_REUSED'),
          );
          await assert.rejects(
            service.session(recent.accessToken),
            hasCode('SESSION_REVOKED'),
          );
        },
      );

      await t.test(
        'maintenance skips locked terminal sessions and revisits them only after lock release',
        async () => {
          const credentials = await service.login('maintenance-locked');
          await pool.query(
            "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp()-interval '31 days',revoke_reason='logout' WHERE id=$1",
            [credentials.sessionId],
          );
          const locker = await pool.connect();
          try {
            await locker.query('BEGIN');
            await locker.query(
              'SELECT id FROM whaleu_identity.sessions WHERE id=$1 FOR UPDATE',
              [credentials.sessionId],
            );
            const skipped = await new IdentityMaintenance(database).run({
              mode: 'apply',
            });
            assert.equal(
              skipped.accessTokens + skipped.refreshTokens + skipped.sessions,
              0,
            );
          } finally {
            await locker.query('ROLLBACK');
            locker.release();
          }
          const deleted = await new IdentityMaintenance(database).run({
            mode: 'apply',
          });
          assert.equal(deleted.accessTokens, 1);
          assert.equal(deleted.refreshTokens, 1);
          assert.equal(deleted.sessions, 1);
        },
      );

      await t.test(
        'shared PostgreSQL risk buckets remain atomic under concurrency and contain no raw address',
        async () => {
          const limiter = new IdentityRateLimiter(config, database);
          const address = '192.0.2.123';
          const results = await Promise.allSettled(
            Array.from({ length: 25 }, () => limiter.consume('login', address)),
          );
          const successes = results.filter(
            ({ status }) => status === 'fulfilled',
          ).length;
          for (const result of results)
            if (result.status === 'rejected')
              assert.ok(hasCode('RATE_LIMITED')(result.reason));
          const addressHash = createHmac(
            'sha256',
            Buffer.from(config.AUTH_RATE_LIMIT_KEY!, 'hex'),
          )
            .update(`login:${address}`)
            .digest('hex');
          const windows = await pool.query<{ hits: number }>(
            'SELECT hits FROM whaleu_identity.rate_buckets WHERE bucket_hash=$1',
            [addressHash],
          );
          // Count each actual DB window separately: no wall-clock boundary flakiness.
          assert.equal(
            successes,
            windows.rows.reduce(
              (total, { hits }) => total + Math.min(hits, 20),
              0,
            ),
          );
          assert.equal(
            windows.rows.reduce((total, { hits }) => total + hits, 0),
            25,
          );
          const buckets = await pool.query<{
            bucket_hash: string;
            hits: number;
          }>('SELECT bucket_hash,hits FROM whaleu_identity.rate_buckets');
          assert.ok(buckets.rowCount && buckets.rowCount >= 2);
          for (const bucket of buckets.rows)
            assert.match(bucket.bucket_hash, /^[a-f0-9]{64}$/);
          assert.ok(!JSON.stringify(buckets.rows).includes(address));
        },
      );
    } finally {
      try {
        await database.onApplicationShutdown();
        if (ownsSchema) {
          await pool.query('DROP SCHEMA IF EXISTS whaleu_identity CASCADE');
          await pool.query('DROP SCHEMA IF EXISTS whaleu_meta CASCADE');
        }
      } finally {
        if (suiteLocked)
          await suiteClient?.query('SELECT pg_advisory_unlock($1,$2)', [
            MIGRATION_LOCK[0],
            2,
          ]);
        suiteClient?.release();
        await pool.end();
      }
    }
  },
);
