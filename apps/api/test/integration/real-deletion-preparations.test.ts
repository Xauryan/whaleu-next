import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { configureHttp } from '../../src/http/http.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  type RequiredTransactionProof,
} from '../../src/database/transaction-deadlines.js';
import { Pool, type PoolClient } from 'pg';
import { loadConfig } from '../../src/config/config.js';
import {
  DatabaseService,
  inTransaction,
  poolOptions,
  supportedPostgresVersion,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import type { Request } from 'express';
import type { TransactionOptions } from '../../src/database/database.js';
import { IdentityRateLimiter } from '../../src/identity/rate-limit.js';
import { RealDeletionController } from '../../src/account-deletion/real/module.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { IdentityService } from '../../src/identity/identity.service.js';
import { WechatIdentityProvider } from '../../src/identity/wechat-provider.js';
import { mintToken, hashToken } from '../../src/identity/tokens.js';
import { AppLogger } from '../../src/observability/logger.js';
import { RealDeletionService } from '../../src/account-deletion/real/service.js';
import { REAL_DELETION_CONSENT } from '../../src/account-deletion/real/contracts.js';
import {
  preparationRow,
  retainPreparation,
} from '../../src/account-deletion/real/preparation-repository.js';
import {
  inspectPreparationSchema,
  retainPreparationSchema,
} from '../../src/account-deletion/real/qualification.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';
const appCode = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
const sqlCode = (code: string) => (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === code;
const secret = () => 'wu_dr_' + randomBytes(32).toString('base64url'); // local disposable fixture only

test(
  '0181 real preparation persistence is non-destructive, private and non-activating',
  { timeout: 180000 },
  async (t) => {
    const connection = process.env['TEST_DATABASE_URL'];
    assert.ok(connection, 'Fresh loopback whaleu_test required, never skipped');
    const url = new URL(connection);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: connection,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '5',
      REAL_ACCOUNT_DELETION_ENTRY: 'prepare_only',
      WECHAT_APP_ID: 'wx0123456789abcdef',
      WECHAT_APP_SECRET: 'synthetic-provider-secret-for-local-tests-only',
      AUTH_RATE_LIMIT_KEY: '01'.repeat(32),
    });
    const pool = new Pool(poolOptions(config));
    const db = new DatabaseService(config, new AppLogger(config));
    const identities = new IdentityRepository(db, config);
    let providerCalls = 0;
    const identity = new IdentityService(
      new WechatIdentityProvider(config, async () => {
        providerCalls++;
        throw new Error('No external provider operation permitted');
      }),
      identities,
    );
    const service = new RealDeletionService(config, db, identity);
    let suite: PoolClient | undefined,
      owns = false,
      locked = false;
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert(locked);
      assert(
        supportedPostgresVersion(
          (
            await suite.query<{ v: number }>(
              "SELECT current_setting('server_version_num')::integer v",
            )
          ).rows[0]!.v,
        ),
      );
      assert.equal(
        (
          await suite.query<{ n: number }>(
            'SELECT count(*)::integer n FROM pg_namespace WHERE nspname=ANY($1::text[])',
            [migrationSchemaNames],
          )
        ).rows[0]!.n,
        0,
        'Never touch existing application schemas',
      );
      const migrations = await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      );
      assert(
        migrations.some(
          (m) => m.name === '0181_identity_real_deletion_preparations.sql',
        ),
      );
      owns = true;
      await runMigrations(pool, migrations, { mode: 'up' });
      await inTransaction(pool, inspectPreparationSchema);
      const access = mintToken('access'),
        refresh = mintToken('refresh');
      const session = await identities.createSession(
        {
          provider: 'wechat',
          appId: config.WECHAT_APP_ID!,
          subject: 'synthetic-real-prepare-a',
        },
        { access: hashToken(access), refresh: hashToken(refresh) },
      );
      const otherAccess = mintToken('access');
      const other = await identities.createSession(
        {
          provider: 'wechat',
          appId: config.WECHAT_APP_ID!,
          subject: 'synthetic-real-prepare-b',
        },
        {
          access: hashToken(otherAccess),
          refresh: hashToken(mintToken('refresh')),
        },
      );
      const command = {
        version: 1 as const,
        intentId: randomUUID(),
        expectedGeneration: '0',
        consent: REAL_DELETION_CONSENT,
        recoverySecret: secret(),
      };
      const before = (
        await pool.query(
          'SELECT status,lifecycle,lifecycle_generation,session_revocation_epoch FROM whaleu_identity.accounts WHERE id=$1',
          [session.accountId],
        )
      ).rows;
      const otherBefore = (
        await pool.query(
          'SELECT to_jsonb(a) value FROM whaleu_identity.accounts a WHERE id=$1',
          [other.accountId],
        )
      ).rows;
      await t.test(
        'actual current native account can prepare and recover a lost response without provider dispatch',
        async () => {
          const first = await service.prepare(access, command);
          assert.equal(first.phase, 'prepared');
          assert.equal(first.acceptedAt, null);
          assert.deepEqual(await service.prepare(access, command), first);
          assert.deepEqual(
            await service.status({
              intentId: command.intentId,
              recoverySecret: command.recoverySecret,
            }),
            first,
          );
          assert(!JSON.stringify(first).includes(session.accountId));
          assert(!JSON.stringify(first).includes(command.recoverySecret));
          assert.deepEqual(
            (
              await pool.query(
                'SELECT status,lifecycle,lifecycle_generation,session_revocation_epoch FROM whaleu_identity.accounts WHERE id=$1',
                [session.accountId],
              )
            ).rows,
            before,
          );
          assert.deepEqual(
            (
              await pool.query(
                'SELECT to_jsonb(a) value FROM whaleu_identity.accounts a WHERE id=$1',
                [other.accountId],
              )
            ).rows,
            otherBefore,
          );
          const persisted = (
            await pool.query(
              'SELECT to_jsonb(p) value FROM whaleu_real_deletion.preparations p WHERE intent_id=$1',
              [command.intentId],
            )
          ).rows;
          assert(!JSON.stringify(persisted).includes(command.recoverySecret));
          assert.equal(providerCalls, 0);
        },
      );
      await t.test(
        'same intent cannot replace secret, generation or account; unknown recovery is indistinguishable',
        async () => {
          await assert.rejects(
            service.prepare(access, { ...command, recoverySecret: secret() }),
            appCode('REAL_DELETION_INTENT_CONFLICT'),
          );
          await assert.rejects(
            service.prepare(access, { ...command, expectedGeneration: '1' }),
            appCode('REAL_DELETION_INTENT_CONFLICT'),
          );
          await assert.rejects(
            service.prepare(otherAccess, command),
            appCode('REAL_DELETION_SCOPE_UNAVAILABLE'),
          );
          await assert.rejects(
            service.status({
              intentId: command.intentId,
              recoverySecret: secret(),
            }),
            appCode('REAL_DELETION_SCOPE_UNAVAILABLE'),
          );
          await assert.rejects(
            service.status({
              intentId: randomUUID(),
              recoverySecret: secret(),
            }),
            appCode('REAL_DELETION_SCOPE_UNAVAILABLE'),
          );
        },
      );
      await t.test(
        'real active preparations do not reserve generation and account-local count is capped',
        async () => {
          for (let i = 0; i < 3; i++)
            await service.prepare(access, {
              ...command,
              intentId: randomUUID(),
              recoverySecret: secret(),
            });
          await assert.rejects(
            service.prepare(access, {
              ...command,
              intentId: randomUUID(),
              recoverySecret: secret(),
            }),
            appCode('REAL_DELETION_UNAVAILABLE'),
          );
          assert.equal(
            (
              await pool.query<{ n: number }>(
                'SELECT count(*)::integer n FROM whaleu_real_deletion.preparations WHERE account_id=$1',
                [session.accountId],
              )
            ).rows[0]!.n,
            4,
          );
          assert.deepEqual(
            (
              await pool.query(
                'SELECT status,lifecycle,lifecycle_generation,session_revocation_epoch FROM whaleu_identity.accounts WHERE id=$1',
                [session.accountId],
              )
            ).rows,
            before,
          );
        },
      );
      await t.test(
        'accept and cancellation remain closed before provider or any epoch mutation',
        async () => {
          await assert.rejects(
            service.accept({ ...command, code: 'synthetic-code' }),
            appCode('REAL_DELETION_UNAVAILABLE'),
          );
          await assert.rejects(
            service.cancel({
              intentId: command.intentId,
              recoverySecret: command.recoverySecret,
              commandId: randomUUID(),
              expectedRevision: '0',
              action: 'explicitly-cancel-real-account-deletion-v1',
            }),
            appCode('REAL_DELETION_UNAVAILABLE'),
          );
          assert.equal(providerCalls, 0);
          await assert.rejects(
            pool.query(
              'UPDATE whaleu_identity.accounts SET session_revocation_epoch=1 WHERE id=$1',
              [session.accountId],
            ),
            sqlCode('23514'),
          );
        },
      );
      for (const statement of [
        "UPDATE whaleu_real_deletion.preparations SET recovery_hash=repeat('0',64) WHERE intent_id=$1",
        'DELETE FROM whaleu_real_deletion.preparations WHERE intent_id=$1',
      ])
        await t.test(
          'live preparation identity/retention is guarded: ' + statement,
          () =>
            assert.rejects(
              pool.query(statement, [command.intentId]),
              sqlCode('23514'),
            ),
        );
      for (const statement of [
        'ALTER TABLE whaleu_real_deletion.preparations DISABLE TRIGGER preparation_guard',
        'ALTER INDEX whaleu_identity.accounts_pkey SET (fillfactor=70)',
        'ALTER TABLE whaleu_real_deletion.preparations DROP CONSTRAINT preparations_recovery_hash_check',
        "CREATE FUNCTION whaleu_real_deletion.preparation_protocol(text) RETURNS jsonb LANGUAGE sql AS 'SELECT null::jsonb'",
      ])
        await t.test(
          'real schema drift fails closed: ' + statement,
          async () => {
            await assert.rejects(
              inTransaction(pool, async (tx) => {
                await tx.query(statement);
                await retainPreparationSchema(tx);
              }),
              appCode('REAL_DELETION_UNAVAILABLE'),
            );
            await inTransaction(pool, inspectPreparationSchema);
          },
        );
      await t.test(
        'rollback-only expiry drift reaches SQL deadline rejection without creating deletion authority',
        async () => {
          const rollback = new Error('expiry-fixture-rollback');
          await assert.rejects(
            inTransaction(pool, async (tx) => {
              await tx.query(
                'ALTER TABLE whaleu_real_deletion.preparations DISABLE TRIGGER preparation_guard',
              );
              await tx.query(
                "UPDATE whaleu_real_deletion.preparations SET created_at=at.value-interval '901 seconds',expires_at=at.value-interval '1 second' FROM(SELECT clock_timestamp() value) at WHERE intent_id=$1",
                [command.intentId],
              );
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
              await tx.query(
                'ALTER TABLE whaleu_real_deletion.preparations ENABLE TRIGGER preparation_guard',
              );
              await retainPreparationSchema(tx);
              const expired = (
                await tx.query<{ expired: boolean }>(
                  'SELECT expires_at<=clock_timestamp() expired FROM whaleu_real_deletion.preparations WHERE intent_id=$1',
                  [command.intentId],
                )
              ).rows[0]!.expired;
              assert.equal(expired, true);
              const row = await preparationRow(tx, command.intentId);
              assert(row);
              await assert.rejects(
                retainPreparation(tx, row),
                appCode('REAL_DELETION_SCOPE_UNAVAILABLE'),
              );
              throw rollback;
            }),
            (e) => e === rollback,
          );
          assert.equal(
            (
              await service.status({
                intentId: command.intentId,
                recoverySecret: command.recoverySecret,
              })
            ).phase,
            'prepared',
          );
        },
      );
      await t.test(
        'exact preparation text preserves microseconds and SQL equality expires without Date authorization',
        async () => {
          const rollback = new Error('exact-expiry-fixture-rollback');
          await assert.rejects(
            inTransaction(pool, async (tx) => {
              await tx.query(
                'ALTER TABLE whaleu_real_deletion.preparations DISABLE TRIGGER preparation_guard',
              );
              await tx.query(
                `UPDATE whaleu_real_deletion.preparations SET created_at='2098-01-01 00:00:00.000999+00'::timestamptz-interval '900 seconds',expires_at='2098-01-01 00:00:00.000999+00' WHERE intent_id=$1`,
                [command.intentId],
              );
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
              await tx.query(
                'ALTER TABLE whaleu_real_deletion.preparations ENABLE TRIGGER preparation_guard',
              );
              const row = await preparationRow(tx, command.intentId);
              assert(row);
              assert.match(row.expires_at_exact, /\.000999[+-]/);
              assert.equal(
                row.expires_at.getUTCMilliseconds(),
                0,
                'Date truncation is presentation only',
              );
              await retainPreparation(tx, row);
              const bounds = (
                await tx.query<{
                  before: boolean;
                  equal: boolean;
                  after: boolean;
                }>(
                  `SELECT $1::timestamptz > '2098-01-01 00:00:00.000998+00'::timestamptz before, $1::timestamptz <= '2098-01-01 00:00:00.000999+00'::timestamptz equal, $1::timestamptz <= '2098-01-01 00:00:00.001000+00'::timestamptz after`,
                  [row.expires_at_exact],
                )
              ).rows[0];
              assert.deepEqual(bounds, {
                before: true,
                equal: true,
                after: true,
              });
              throw rollback;
            }),
            (e) => e === rollback,
          );
        },
      );
      await t.test(
        'preparation valid at its final owner proof expires during a later proof and all tentative writes roll back',
        async () => {
          let laterProofReached = false;
          const original = (
            await pool.query(
              'SELECT created_at::text,expires_at::text FROM whaleu_real_deletion.preparations WHERE intent_id=$1',
              [command.intentId],
            )
          ).rows;
          const later: RequiredTransactionProof<string> = {
            maximumFacts: 1,
            failureCode: 'REAL_DELETION_SCOPE_UNAVAILABLE',
            validate: async (_facts, tx) => {
              const row = await preparationRow(tx, command.intentId);
              assert(
                row?.current,
                'preparation proof has already passed while live',
              );
              laterProofReached = true;
              // Test-only bounded wait AFTER the real preparation owner validator.
              await tx.query(
                `SELECT pg_sleep(GREATEST(0,extract(epoch FROM expires_at-clock_timestamp()))::double precision+0.02) FROM whaleu_real_deletion.preparations WHERE intent_id=$1`,
                [command.intentId],
              );
            },
          };
          await assert.rejects(
            inTransaction(pool, async (tx) => {
              await tx.query(
                'ALTER TABLE whaleu_real_deletion.preparations DISABLE TRIGGER preparation_guard',
              );
              await tx.query(
                `UPDATE whaleu_real_deletion.preparations SET created_at=at.value-interval '899 seconds',expires_at=at.value+interval '1 second' FROM(SELECT clock_timestamp() value) at WHERE intent_id=$1`,
                [command.intentId],
              );
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
              await tx.query(
                'ALTER TABLE whaleu_real_deletion.preparations ENABLE TRIGGER preparation_guard',
              );
              const row = await preparationRow(tx, command.intentId);
              assert(row?.current);
              await retainPreparation(tx, row);
              enableRequiredTransactionProof(tx, later);
              registerRequiredTransactionFact(
                tx,
                later,
                command.intentId,
                command.intentId,
              );
            }),
            appCode('REAL_DELETION_SCOPE_UNAVAILABLE'),
          );
          assert(
            laterProofReached,
            'failure must occur after the preparation proof, not before',
          );
          assert.deepEqual(
            (
              await pool.query(
                'SELECT created_at::text,expires_at::text FROM whaleu_real_deletion.preparations WHERE intent_id=$1',
                [command.intentId],
              )
            ).rows,
            original,
          );
          assert.equal(
            (
              await service.status({
                intentId: command.intentId,
                recoverySecret: command.recoverySecret,
              })
            ).phase,
            'prepared',
          );
        },
      );
      await t.test(
        'account lock contention rejects promptly and leaves no intent or authority',
        async () => {
          const blocker = await pool.connect();
          const blocked = {
            ...command,
            intentId: randomUUID(),
            recoverySecret: secret(),
          };
          try {
            await blocker.query('BEGIN');
            await blocker.query(
              'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR UPDATE',
              [other.accountId],
            );
            await assert.rejects(
              service.prepare(otherAccess, blocked),
              appCode('REAL_DELETION_UNAVAILABLE'),
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_real_deletion.preparations WHERE intent_id=$1',
                  [blocked.intentId],
                )
              ).rowCount,
              0,
            );
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
          }
        },
      );
      await t.test(
        'actual non-owner minimal privileges support controller prepare/status; removing each required grant denies',
        async (rt) => {
          const role = 'whaleu_prep_' + randomUUID().replaceAll('-', '');
          const quoted = '"' + role + '"';
          const grants = [
            'USAGE ON SCHEMA whaleu_identity,whaleu_real_deletion,whaleu_account_deletion',
            'SELECT(account_id) ON whaleu_account_deletion.fixture_accounts',
            'SELECT ON TABLE whaleu_identity.accounts,whaleu_identity.sessions,whaleu_identity.access_tokens,whaleu_identity.provider_identities,whaleu_identity.rate_buckets,whaleu_real_deletion.preparations',
            'UPDATE(id) ON whaleu_identity.accounts',
            'UPDATE(id) ON whaleu_identity.sessions',
            'UPDATE(token_hash) ON whaleu_identity.access_tokens',
            'UPDATE(hits) ON whaleu_identity.rate_buckets',
            'INSERT,DELETE ON whaleu_identity.rate_buckets',
            'INSERT,DELETE ON whaleu_real_deletion.preparations',
            'EXECUTE ON FUNCTION whaleu_real_deletion.preparation_catalog()',
          ];
          const roleDb = {
            transaction: <T>(
              work: (tx: PoolClient) => Promise<T>,
              options?: TransactionOptions,
            ) =>
              inTransaction(
                pool,
                async (tx) => {
                  await tx.query('SET LOCAL ROLE ' + quoted);
                  return work(tx);
                },
                options,
              ),
          } as DatabaseService;
          const restricted = new RealDeletionService(config, roleDb, identity);
          const controller = new RealDeletionController(
            restricted,
            new IdentityRateLimiter(config, roleDb),
            config,
          );
          const request = { socket: { remoteAddress: '127.0.0.1' } } as Request;
          const scoped = {
            ...command,
            intentId: randomUUID(),
            recoverySecret: secret(),
          };
          const denied = (e: unknown) =>
            sqlCode('42501')(e) ||
            appCode('REAL_DELETION_UNAVAILABLE')(e) ||
            appCode('AUTH_NOT_CONFIGURED')(e);
          await pool.query(
            'CREATE ROLE ' +
              quoted +
              ' NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
          );
          try {
            for (const grant of grants)
              await pool.query('GRANT ' + grant + ' TO ' + quoted);
            assert.equal(
              (
                await pool.query<{ elevated: boolean }>(
                  'SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolreplication elevated FROM pg_roles WHERE rolname=$1',
                  [role],
                )
              ).rows[0]?.elevated,
              false,
            );
            const prepared = await controller.prepare(
              'Bearer ' + otherAccess,
              scoped,
              request,
            );
            assert.equal(prepared.phase, 'prepared');
            assert.deepEqual(
              await controller.status(
                {
                  intentId: scoped.intentId,
                  recoverySecret: scoped.recoverySecret,
                },
                request,
              ),
              prepared,
            );
            for (const missing of [
              'USAGE ON SCHEMA whaleu_real_deletion',
              'USAGE ON SCHEMA whaleu_identity',
              'USAGE ON SCHEMA whaleu_account_deletion',
              'SELECT(account_id) ON whaleu_account_deletion.fixture_accounts',
              'SELECT ON whaleu_identity.accounts',
              'SELECT ON whaleu_identity.sessions',
              'SELECT ON whaleu_identity.access_tokens',
              'SELECT ON whaleu_identity.rate_buckets',
              'INSERT ON whaleu_identity.rate_buckets',
              'DELETE ON whaleu_identity.rate_buckets',
              'UPDATE(hits) ON whaleu_identity.rate_buckets',
              'SELECT ON whaleu_real_deletion.preparations',
              'SELECT ON whaleu_identity.provider_identities',
              'UPDATE(id) ON whaleu_identity.accounts',
              'UPDATE(id) ON whaleu_identity.sessions',
              'UPDATE(token_hash) ON whaleu_identity.access_tokens',
              'INSERT ON whaleu_real_deletion.preparations',
              'DELETE ON whaleu_real_deletion.preparations',
              'EXECUTE ON FUNCTION whaleu_real_deletion.preparation_catalog()',
            ])
              await rt.test(
                'removing exact required privilege: ' + missing,
                async () => {
                  await pool.query('REVOKE ' + missing + ' FROM ' + quoted);
                  try {
                    await assert.rejects(
                      controller.prepare(
                        'Bearer ' + otherAccess,
                        {
                          ...scoped,
                          intentId: randomUUID(),
                          recoverySecret: secret(),
                        },
                        request,
                      ),
                      denied,
                    );
                  } finally {
                    for (const grant of grants)
                      await pool.query('GRANT ' + grant + ' TO ' + quoted);
                  }
                },
              );
            assert.equal(
              (
                await pool.query<{ n: number }>(
                  'SELECT count(*)::integer n FROM whaleu_real_deletion.preparations WHERE account_id=$1',
                  [other.accountId],
                )
              ).rows[0]!.n,
              1,
            );
          } finally {
            // Exact local fixture grants only, never blanket DROP OWNED or production role action.
            for (const grant of grants)
              await pool.query('REVOKE ' + grant + ' FROM ' + quoted);
            await pool.query('DROP ROLE ' + quoted);
          }
        },
      );
      await t.test(
        'real AppModule plus PostgreSQL serves authenticated prepare/status HTTP without service, limiter or database substitution',
        async (ht) => {
          let networkCalls = 0;
          ht.mock.method(globalThis, 'fetch', async () => {
            networkCalls++;
            throw new Error(
              'External transport forbidden in preparation HTTP test',
            );
          });
          const module = await Test.createTestingModule({
            imports: [AppModule.register(config)],
          }).compile();
          const app = module.createNestApplication();
          configureHttp(app);
          await app.init();
          try {
            assert(app.get(RealDeletionService) instanceof RealDeletionService);
            assert(app.get(DatabaseService) instanceof DatabaseService);
            assert(app.get(IdentityRateLimiter) instanceof IdentityRateLimiter);
            const httpAccess = mintToken('access');
            const httpAccount = await app.get(IdentityRepository).createSession(
              {
                provider: 'wechat',
                appId: config.WECHAT_APP_ID!,
                subject: 'synthetic-real-prepare-http',
              },
              {
                access: hashToken(httpAccess),
                refresh: hashToken(mintToken('refresh')),
              },
            );
            const httpCommand = {
              ...command,
              intentId: randomUUID(),
              recoverySecret: secret(),
            };
            const prepared = await request(app.getHttpServer())
              .post('/v1/account-deletion/prepare')
              .set('Authorization', 'Bearer ' + httpAccess)
              .send(httpCommand)
              .expect(200);
            assert.equal(
              prepared.headers['cache-control'],
              'private, no-store',
            );
            assert.match(
              prepared.headers['x-request-id'] ?? '',
              /^[0-9a-f-]{36}$/,
            );
            assert.equal(prepared.headers['x-content-type-options'], 'nosniff');
            assert.equal(prepared.body.intentId, httpCommand.intentId);
            assert.equal(prepared.body.phase, 'prepared');
            assert.equal(prepared.body.acceptedAt, null);
            assert(
              !JSON.stringify(prepared.body).includes(httpAccount.accountId),
            );
            assert(
              !JSON.stringify(prepared.body).includes(
                httpCommand.recoverySecret,
              ),
            );
            const replay = await request(app.getHttpServer())
              .post('/v1/account-deletion/prepare')
              .set('Authorization', 'Bearer ' + httpAccess)
              .send(httpCommand)
              .expect(200);
            assert.deepEqual(replay.body, prepared.body);
            const status = await request(app.getHttpServer())
              .post('/v1/account-deletion/status')
              .send({
                intentId: httpCommand.intentId,
                recoverySecret: httpCommand.recoverySecret,
              })
              .expect(200);
            assert.deepEqual(status.body, prepared.body);
            assert.equal(status.headers['cache-control'], 'private, no-store');
            const denied = await request(app.getHttpServer())
              .post('/v1/account-deletion/prepare')
              .set('Authorization', 'Bearer ' + mintToken('access'))
              .send({ ...httpCommand, intentId: randomUUID() })
              .expect(404);
            assert.equal(
              denied.body.error.code,
              'REAL_DELETION_SCOPE_UNAVAILABLE',
            );
            await request(app.getHttpServer())
              .post('/v1/account-deletion/prepare')
              .set('Authorization', 'Bearer ' + httpAccess)
              .send({ ...httpCommand, accountId: httpAccount.accountId })
              .expect(400);
            const missing = await request(app.getHttpServer())
              .post('/v1/account-deletion/status')
              .send({
                intentId: httpCommand.intentId,
                recoverySecret: secret(),
              })
              .expect(404);
            assert.equal(
              missing.body.error.code,
              'REAL_DELETION_SCOPE_UNAVAILABLE',
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT count(*)::integer n FROM whaleu_real_deletion.preparations WHERE account_id=$1',
                  [httpAccount.accountId],
                )
              ).rows[0].n,
              1,
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT session_revocation_epoch::text epoch FROM whaleu_identity.accounts WHERE id=$1',
                  [httpAccount.accountId],
                )
              ).rows[0].epoch,
              '0',
            );
            await app.get(IdentityService).logout(httpAccess);
            const revoked = await request(app.getHttpServer())
              .post('/v1/account-deletion/prepare')
              .set('Authorization', 'Bearer ' + httpAccess)
              .send(httpCommand)
              .expect(401);
            assert.equal(revoked.body.error.code, 'SESSION_REVOKED');
            assert.equal(networkCalls, 0);
          } finally {
            await app.close();
          }
        },
      );
      await t.test(
        'default disabled entry leaves persisted facts and ordinary authentication unchanged',
        async () => {
          const disabled = new RealDeletionService(
            { ...config, REAL_ACCOUNT_DELETION_ENTRY: 'disabled' },
            db,
            identity,
          );
          assert.throws(
            () => disabled.prepare(access, command),
            appCode('REAL_DELETION_UNAVAILABLE'),
          );
          assert.equal(
            (await identity.session(access)).accountId,
            session.accountId,
          );
          assert.equal(providerCalls, 0);
        },
      );
    } finally {
      await db.onApplicationShutdown();
      if (owns && suite)
        for (const schema of migrationSchemaNames)
          await suite.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      if (locked && suite)
        await suite.query('SELECT pg_advisory_unlock($1,$2)', [
          MIGRATION_LOCK[0],
          2,
        ]);
      suite?.release();
      await pool.end();
    }
  },
);
