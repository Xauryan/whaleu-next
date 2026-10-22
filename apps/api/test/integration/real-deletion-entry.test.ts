import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { Pool, type PoolClient } from 'pg';
import { AppModule } from '../../src/app.module.js';
import { configureHttp } from '../../src/http/http.js';
import { loadConfig, type RuntimeConfig } from '../../src/config/config.js';
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
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import { REAL_DELETION_CONSENT } from '../../src/account-deletion/real/contracts.js';
import { RealDeletionService } from '../../src/account-deletion/real/service.js';
import { RealRequestCoordinator } from '../../src/account-deletion/real/request-coordinator.js';
import { RealRequestAdmission } from '../../src/account-deletion/real/admission.js';
import { inTransaction } from '../../src/database/database.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';
import { initializeTestApplication } from '../support/initialize-test-application.js';
import {
  admitLocalRequestValidation,
  installLocalRequestValidation,
  inspectLocalRequestValidation,
} from '../support/real-request-local-validation.js';

const secret = () => 'wu_dr_' + randomBytes(32).toString('base64url');
test(
  'real AppModule request orchestration with explicit test-only admission; installed production owner remains closed',
  { timeout: 180000 },
  async (t) => {
    const connection = process.env['TEST_DATABASE_URL'];
    assert(
      connection,
      'Fresh disposable loopback database required, never skip',
    );
    const address = new URL(connection);
    assert(['127.0.0.1', 'localhost', '[::1]'].includes(address.hostname));
    assert.equal(address.pathname, '/whaleu_test');
    const env = {
      NODE_ENV: 'test',
      DATABASE_URL: connection,
      PG_SSL_MODE: 'disable',
      PG_POOL_MAX: '5',
      LOG_LEVEL: 'silent',
      REAL_ACCOUNT_DELETION_ENTRY: 'prepare_only',
      REAL_ACCOUNT_DELETION_NEW_REQUESTS: 'qualified_owner',
      WECHAT_APP_ID: 'wx0123456789abcdef',
      WECHAT_APP_SECRET: 'synthetic-provider-secret-for-local-tests-only',
      AUTH_RATE_LIMIT_KEY: '01'.repeat(32),
      IDENTITY_DELETION_DIGEST_KEYRING: JSON.stringify({
        version: 1,
        activeEpoch: 'local-two',
        keys: [
          { epoch: 'local-one', keyHex: '02'.repeat(32) },
          { epoch: 'local-two', keyHex: '03'.repeat(32) },
        ],
      }),
    };
    const config = loadConfig(env),
      pool = new Pool(poolOptions(config));
    let lease: PoolClient | undefined,
      locked = false,
      owns = false,
      calls = 0;
    // Same production WeChat adapter and DI binding; replace only local transport.
    t.mock.method(
      globalThis,
      'fetch',
      async (input: string | URL | Request, options?: RequestInit) => {
        calls++;
        assert.equal(
          new URL(String(input)).origin,
          'https://api.weixin.qq.com',
        );
        assert.equal(options?.redirect, 'error');
        return new Response(
          JSON.stringify({
            openid: 'local-http-real-request-a',
            session_key: Buffer.alloc(16).toString('base64'),
          }),
          { status: 200 },
        );
      },
    );
    const createApp = async (runtime: RuntimeConfig, localOwner: boolean) => {
      const builder = Test.createTestingModule({
        imports: [AppModule.register(runtime)],
      });
      if (localOwner)
        builder.overrideProvider(RealRequestAdmission).useValue({
          inspect: inspectLocalRequestValidation,
          admit: admitLocalRequestValidation,
        });
      const module = await builder.compile();
      return initializeTestApplication(module, async (app) => {
        configureHttp(app);
        await app.init();
        assert(app.get(RealDeletionService) instanceof RealDeletionService);
        assert(
          app.get(RealRequestCoordinator) instanceof RealRequestCoordinator,
        );
      });
    };
    try {
      lease = await pool.connect();
      locked = (
        await lease.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert(locked);
      assert(
        supportedPostgresVersion(
          (
            await lease.query<{ v: number }>(
              "SELECT current_setting('server_version_num')::integer v",
            )
          ).rows[0]!.v,
        ),
      );
      assert.equal(
        (
          await lease.query(
            'SELECT count(*)::integer n FROM pg_namespace WHERE nspname=ANY($1::text[])',
            [['whaleu_local_request_validation', ...migrationSchemaNames]],
          )
        ).rows[0].n,
        0,
      );
      owns = true;
      await runMigrations(
        pool,
        await readMigrations(
          fileURLToPath(new URL('../../migrations', import.meta.url)),
        ),
        { mode: 'up' },
      );
      const access = mintToken('access'),
        refresh = mintToken('refresh');
      const command = {
        version: 1,
        intentId: randomUUID(),
        expectedGeneration: '0',
        consent: REAL_DELETION_CONSENT,
        recoverySecret: secret(),
      };
      const otherAccess = mintToken('access');
      const pendingCommand = {
        ...command,
        intentId: randomUUID(),
        recoverySecret: secret(),
      };
      let accountId = '',
        otherAccountId = '';
      const closed = await createApp(config, false);
      try {
        const identity = await closed.get(IdentityRepository).createSession(
          {
            provider: 'wechat',
            appId: config.WECHAT_APP_ID!,
            subject: 'local-http-real-request-a',
          },
          { access: hashToken(access), refresh: hashToken(refresh) },
        );
        accountId = identity.accountId;
        otherAccountId = (
          await closed.get(IdentityRepository).createSession(
            {
              provider: 'wechat',
              appId: config.WECHAT_APP_ID!,
              subject: 'local-http-real-request-b',
            },
            {
              access: hashToken(otherAccess),
              refresh: hashToken(mintToken('refresh')),
            },
          )
        ).accountId;
        await request(closed.getHttpServer())
          .post('/v1/account-deletion/prepare')
          .set('Authorization', 'Bearer ' + otherAccess)
          .send(pendingCommand)
          .expect(200);
        await request(closed.getHttpServer())
          .post('/v1/account-deletion/prepare')
          .set('Authorization', 'Bearer ' + access)
          .send(command)
          .expect(200);
        await t.test(
          'configured request mode cannot bypass the installed unavailable production owner or consume a provider code',
          async () => {
            const denied = await request(closed.getHttpServer())
              .post('/v1/account-deletion/accept')
              .set('Authorization', 'Bearer ' + access)
              .send({ ...command, code: 'local-code' })
              .expect(503);
            assert.equal(denied.body.error.code, 'REAL_DELETION_UNAVAILABLE');
            assert.equal(calls, 0);
            assert.equal(
              (
                await pool.query(
                  'SELECT count(*)::integer n FROM whaleu_real_deletion.reauthentication_attempts',
                )
              ).rows[0].n,
              0,
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT session_revocation_epoch FROM whaleu_identity.accounts WHERE id=$1',
                  [accountId],
                )
              ).rows[0].session_revocation_epoch,
              '0',
            );
          },
        );
      } finally {
        await closed.close();
      }
      await inTransaction(pool, installLocalRequestValidation);
      const app = await createApp(config, true);
      let accepted: unknown;
      try {
        await t.test(
          'actual controller/service commits exact core acceptance through labelled local owner and rejects original credentials',
          async () => {
            const response = await request(app.getHttpServer())
              .post('/v1/account-deletion/accept')
              .set('Authorization', 'Bearer ' + access)
              .send({ ...command, code: 'local-fresh-code' })
              .expect(200);
            accepted = response.body;
            assert.equal(response.body.phase, 'cooling');
            assert.equal(
              response.headers['cache-control'],
              'private, no-store',
            );
            assert(!JSON.stringify(response.body).includes(accountId));
            assert(
              !JSON.stringify(response.body).includes(command.recoverySecret),
            );
            assert.equal(calls, 1);
            await request(app.getHttpServer())
              .get('/v1/auth/session')
              .set('Authorization', 'Bearer ' + access)
              .expect(401);
            await request(app.getHttpServer())
              .post('/v1/auth/refresh')
              .send({ refreshToken: refresh })
              .expect(401);
          },
        );
      } finally {
        await app.close();
      }
      for (const [entry, newRequests] of [
        ['disabled', 'disabled'],
        ['prepare_only', 'disabled'],
        ['prepare_only', 'qualified_owner'],
      ] as const) {
        const matrix = await createApp(
          loadConfig({
            ...env,
            REAL_ACCOUNT_DELETION_ENTRY: entry,
            REAL_ACCOUNT_DELETION_NEW_REQUESTS: newRequests,
          }),
          false,
        );
        try {
          await t.test(
            `private target errors are indistinguishable with entry=${entry}, new=${newRequests}, no bearer`,
            async () => {
              // Independent HTTP scenarios still exercise the actual limiter. Reset
              // only these disposable test-key route buckets between configurations,
              // rather than mocking the limiter or trusting forwarded-IP headers.
              const hashes = ['deletion-status', 'deletion-accept'].flatMap(
                (operation) =>
                  [
                    'global:' + operation,
                    ...['127.0.0.1', '::ffff:127.0.0.1', '::1'].map(
                      (ip) => operation + ':' + ip,
                    ),
                  ].map((value) =>
                    createHmac(
                      'sha256',
                      Buffer.from(env.AUTH_RATE_LIMIT_KEY, 'hex'),
                    )
                      .update(value)
                      .digest('hex'),
                  ),
              );
              await pool.query(
                'DELETE FROM whaleu_identity.rate_buckets WHERE bucket_hash=ANY($1::text[])',
                [hashes],
              );
              const state = () =>
                pool.query(
                  `SELECT jsonb_build_object(
            'accounts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM whaleu_identity.accounts a WHERE id=ANY($1::uuid[])),
            'sessions',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM whaleu_identity.sessions s WHERE account_id=ANY($1::uuid[])),
            'attempts',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM whaleu_real_deletion.reauthentication_attempts a WHERE account_id=ANY($1::uuid[])),
            'admissions',(SELECT jsonb_agg(to_jsonb(a) ORDER BY request_id) FROM whaleu_real_deletion_admission.receipts a WHERE account_id=ANY($1::uuid[])),
            'requests',(SELECT jsonb_agg(to_jsonb(r) ORDER BY id) FROM whaleu_real_deletion.requests r WHERE account_id=ANY($1::uuid[]))
          ) state`,
                  [[accountId, otherAccountId]],
                );
              const before = (await state()).rows;
              const bad = [
                { ...command, intentId: randomUUID() },
                { ...pendingCommand, recoverySecret: secret() },
                { ...command, recoverySecret: secret() },
              ];
              for (const endpoint of ['status', 'accept'] as const) {
                const shapes = [];
                for (const input of bad) {
                  const body =
                    endpoint === 'accept'
                      ? { ...input, code: 'not-exchanged' }
                      : {
                          intentId: input.intentId,
                          recoverySecret: input.recoverySecret,
                        };
                  const response = await request(matrix.getHttpServer())
                    .post('/v1/account-deletion/' + endpoint)
                    .send(body)
                    .expect(404);
                  shapes.push({
                    status: response.status,
                    code: response.body.error.code,
                    message: response.body.error.message,
                  });
                  assert.equal(
                    response.body.error.code,
                    'REAL_DELETION_SCOPE_UNAVAILABLE',
                  );
                  assert(
                    !JSON.stringify(response.body).includes(input.intentId),
                  );
                  assert(
                    !JSON.stringify(response.body).includes(
                      input.recoverySecret,
                    ),
                  );
                }
                assert.deepEqual(shapes[0], shapes[1]);
                assert.deepEqual(shapes[0], shapes[2]);
              }
              for (const altered of [
                { ...pendingCommand, intentId: randomUUID() },
                { ...pendingCommand, expectedGeneration: '1' },
              ]) {
                const response = await request(matrix.getHttpServer())
                  .post('/v1/account-deletion/accept')
                  .send({ ...altered, code: 'not-exchanged' })
                  .expect(404);
                assert.equal(
                  response.body.error.code,
                  'REAL_DELETION_SCOPE_UNAVAILABLE',
                );
              }
              for (const field of [
                { version: 2 },
                { consent: 'changed-consent' },
              ]) {
                const invalid = [];
                for (const id of [pendingCommand.intentId, randomUUID()]) {
                  const response = await request(matrix.getHttpServer())
                    .post('/v1/account-deletion/accept')
                    .send({
                      ...pendingCommand,
                      ...field,
                      intentId: id,
                      code: 'not-exchanged',
                    })
                    .expect(400);
                  invalid.push({
                    status: response.status,
                    code: response.body.error.code,
                    message: response.body.error.message,
                  });
                }
                assert.deepEqual(invalid[0], invalid[1]);
              }
              // Only authenticated preparation capabilities may see mode/bearer
              // requirements. Accepted capabilities always recover before either.
              await request(matrix.getHttpServer())
                .post('/v1/account-deletion/status')
                .send({
                  intentId: pendingCommand.intentId,
                  recoverySecret: pendingCommand.recoverySecret,
                })
                .expect(entry === 'prepare_only' ? 200 : 503);
              await request(matrix.getHttpServer())
                .post('/v1/account-deletion/accept')
                .send({ ...pendingCommand, code: 'not-exchanged' })
                .expect(newRequests === 'qualified_owner' ? 401 : 503);
              for (const endpoint of ['status', 'accept'] as const) {
                const body =
                  endpoint === 'accept'
                    ? { ...command, code: 'receipt-only-no-exchange' }
                    : {
                        intentId: command.intentId,
                        recoverySecret: command.recoverySecret,
                      };
                const response = await request(matrix.getHttpServer())
                  .post('/v1/account-deletion/' + endpoint)
                  .send(body)
                  .expect(200);
                assert.deepEqual(response.body, accepted);
                assert.equal(
                  response.headers['cache-control'],
                  'private, no-store',
                );
              }
              assert.equal(calls, 1);
              assert.deepEqual((await state()).rows, before);
            },
          );
        } finally {
          await matrix.close();
        }
      }
      await t.test(
        'actual AppModule preserves the existing preparation-only nonowner role without request-owner grants',
        async () => {
          const role = 'whaleu_entry_prep_' + randomUUID().replaceAll('-', '');
          const quoted = '"' + role + '"';
          const grants = [
            'USAGE ON SCHEMA whaleu_identity,whaleu_real_deletion,whaleu_account_deletion',
            'SELECT(account_id) ON whaleu_account_deletion.fixture_accounts',
            'SELECT(id) ON whaleu_real_deletion.requests',
            'SELECT(intent_id) ON whaleu_real_deletion.reauthentication_attempts',
            'SELECT ON TABLE whaleu_identity.accounts,whaleu_identity.sessions,whaleu_identity.access_tokens,whaleu_identity.provider_identities,whaleu_identity.rate_buckets,whaleu_real_deletion.preparations',
            'UPDATE(id) ON whaleu_identity.accounts',
            'UPDATE(id) ON whaleu_identity.sessions',
            'UPDATE(token_hash) ON whaleu_identity.access_tokens',
            'UPDATE(hits) ON whaleu_identity.rate_buckets',
            'INSERT,DELETE ON whaleu_identity.rate_buckets',
            'INSERT,DELETE ON whaleu_real_deletion.preparations',
            'EXECUTE ON FUNCTION whaleu_real_deletion.preparation_catalog()',
          ];
          const administration = await pool.connect();
          const priorPgOptions = process.env['PGOPTIONS'];
          let roleCreated = false;
          try {
            const adminPrincipal = (
              await administration.query('SELECT current_user principal')
            ).rows[0].principal;
            await administration.query(
              'CREATE ROLE ' +
                quoted +
                ' NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS',
            );
            roleCreated = true;
            for (const grant of grants)
              await administration.query('GRANT ' + grant + ' TO ' + quoted);
            // loadConfig intentionally forbids URL queries. Use pg's real
            // startup environment for this isolated AppModule instead; restore
            // it below. The already-connected admin lease cannot inherit it.
            process.env['PGOPTIONS'] = '-c role=' + role;
            assert.equal(
              (await administration.query('SELECT current_user principal'))
                .rows[0].principal,
              adminPrincipal,
            );
            assert.notEqual(adminPrincipal, role);
            // No service, coordinator, limiter or transaction facade substitute.
            const limited = await createApp(
              loadConfig({
                ...env,
                REAL_ACCOUNT_DELETION_NEW_REQUESTS: 'disabled',
              }),
              false,
            );
            try {
              const database = limited.get(DatabaseService);
              assert(database instanceof DatabaseService);
              assert.equal(
                (
                  await database.query<{ principal: string }>(
                    'SELECT current_user principal',
                  )
                ).rows[0]?.principal,
                role,
              );
              const privileges = await database.query<{
                request_owner: boolean;
                admission: boolean;
                elevated: boolean;
              }>(
                `SELECT has_function_privilege(current_user,'whaleu_real_deletion.request_catalog()','EXECUTE') request_owner,
              has_schema_privilege(current_user,'whaleu_real_deletion_admission','USAGE') admission,
              (SELECT rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls FROM pg_roles WHERE rolname=current_user) elevated`,
              );
              assert.deepEqual(privileges.rows[0], {
                request_owner: false,
                admission: false,
                elevated: false,
              });
              const fresh = {
                ...pendingCommand,
                intentId: randomUUID(),
                recoverySecret: secret(),
              };
              const prepared = await request(limited.getHttpServer())
                .post('/v1/account-deletion/prepare')
                .set('Authorization', 'Bearer ' + otherAccess)
                .send(fresh)
                .expect(200);
              const goodStatus = () =>
                request(limited.getHttpServer())
                  .post('/v1/account-deletion/status')
                  .send({
                    intentId: fresh.intentId,
                    recoverySecret: fresh.recoverySecret,
                  });
              const status = await goodStatus().expect(200);
              assert.deepEqual(status.body, prepared.body);
              assert.equal(
                status.headers['cache-control'],
                'private, no-store',
              );
              for (const endpoint of ['status', 'accept'] as const) {
                const shapes = [];
                for (const invalid of [
                  { ...fresh, intentId: randomUUID() },
                  { ...fresh, recoverySecret: secret() },
                  { ...command, recoverySecret: secret() },
                ]) {
                  const body =
                    endpoint === 'accept'
                      ? { ...invalid, code: 'not-exchanged' }
                      : {
                          intentId: invalid.intentId,
                          recoverySecret: invalid.recoverySecret,
                        };
                  const response = await request(limited.getHttpServer())
                    .post('/v1/account-deletion/' + endpoint)
                    .send(body)
                    .expect(404);
                  shapes.push({
                    status: response.status,
                    code: response.body.error.code,
                    message: response.body.error.message,
                  });
                }
                assert.deepEqual(shapes[0], shapes[1]);
                assert.deepEqual(shapes[0], shapes[2]);
              }
              // A genuine accepted capability requires the separate request-owner
              // deployment contract. Missing permission is503, never hidden as404.
              const missingOwner = await request(limited.getHttpServer())
                .post('/v1/account-deletion/status')
                .send({
                  intentId: command.intentId,
                  recoverySecret: command.recoverySecret,
                })
                .expect(503);
              assert.equal(
                missingOwner.body.error.code,
                'REAL_DELETION_UNAVAILABLE',
              );
              for (const missing of [
                'SELECT(id) ON whaleu_real_deletion.requests',
                'EXECUTE ON FUNCTION whaleu_real_deletion.preparation_catalog()',
              ]) {
                await administration.query(
                  'REVOKE ' + missing + ' FROM ' + quoted,
                );
                try {
                  await goodStatus().expect(503);
                } finally {
                  for (const grant of grants)
                    await administration.query(
                      'GRANT ' + grant + ' TO ' + quoted,
                    );
                }
                await goodStatus().expect(200);
              }
              assert.equal(calls, 1);
            } finally {
              await limited.close();
            }
          } finally {
            if (priorPgOptions === undefined) delete process.env['PGOPTIONS'];
            else process.env['PGOPTIONS'] = priorPgOptions;
            try {
              if (roleCreated) {
                for (const grant of grants)
                  await administration.query(
                    'REVOKE ' + grant + ' FROM ' + quoted,
                  );
                await administration.query('DROP ROLE ' + quoted);
              }
            } finally {
              administration.release();
            }
          }
          assert.equal(process.env['PGOPTIONS'], priorPgOptions);
        },
      );
      // Both switches are closed: existing request capabilities remain recoverable.
      const recovery = await createApp(
        loadConfig({
          ...env,
          REAL_ACCOUNT_DELETION_ENTRY: 'disabled',
          REAL_ACCOUNT_DELETION_NEW_REQUESTS: 'disabled',
        }),
        false,
      );
      try {
        await t.test(
          'lost acceptance response and private status recover before current bearer/new-provider requirements even when new entry is disabled',
          async () => {
            const replay = await request(recovery.getHttpServer())
              .post('/v1/account-deletion/accept')
              .send({ ...command, code: 'consumed-code-not-exchanged' })
              .expect(200);
            assert.deepEqual(replay.body, accepted);
            const status = await request(recovery.getHttpServer())
              .post('/v1/account-deletion/status')
              .send({
                intentId: command.intentId,
                recoverySecret: command.recoverySecret,
              })
              .expect(200);
            assert.deepEqual(status.body, accepted);
            assert.equal(calls, 1);
          },
        );
        await t.test(
          'purpose-only cancel and exact lost-response replay survive disabled new acceptance without old credential resurrection',
          async () => {
            const cancel = {
              intentId: command.intentId,
              recoverySecret: command.recoverySecret,
              commandId: randomUUID(),
              expectedRevision: '1',
              action: 'explicitly-cancel-real-account-deletion-v1',
            };
            const response = await request(recovery.getHttpServer())
              .post('/v1/account-deletion/cancel')
              .send(cancel)
              .expect(200);
            assert.equal(response.body.phase, 'cancelled');
            assert.equal(response.body.revision, '2');
            const replay = await request(recovery.getHttpServer())
              .post('/v1/account-deletion/cancel')
              .send(cancel)
              .expect(200);
            assert.deepEqual(replay.body, response.body);
            await request(recovery.getHttpServer())
              .post('/v1/account-deletion/cancel')
              .send({ ...cancel, expectedRevision: '2' })
              .expect(404);
            await request(recovery.getHttpServer())
              .get('/v1/auth/session')
              .set('Authorization', 'Bearer ' + access)
              .expect(401);
            await request(recovery.getHttpServer())
              .post('/v1/auth/refresh')
              .send({ refreshToken: refresh })
              .expect(401);
            assert.deepEqual(
              (
                await pool.query(
                  'SELECT lifecycle,session_revocation_epoch FROM whaleu_identity.accounts WHERE id=$1',
                  [accountId],
                )
              ).rows[0],
              { lifecycle: 'active', session_revocation_epoch: '1' },
            );
            assert.equal(calls, 1);
          },
        );
      } finally {
        await recovery.close();
      }
    } finally {
      if (owns && lease) {
        await lease.query(
          'DROP SCHEMA IF EXISTS whaleu_local_request_validation CASCADE',
        );
        for (const schema of migrationSchemaNames)
          await lease.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
      if (locked && lease)
        await lease.query('SELECT pg_advisory_unlock($1,$2)', [
          MIGRATION_LOCK[0],
          2,
        ]);
      lease?.release();
      await pool.end();
    }
  },
);
