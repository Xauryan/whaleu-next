import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Pool, type PoolClient } from 'pg';
import { loadConfig } from '../../src/config/config.js';
import {
  DatabaseService,
  inTransaction,
  poolOptions,
  supportedPostgresVersion,
  type TransactionOptions,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { IdentityService } from '../../src/identity/identity.service.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import {
  inspectSessionEpochSchema,
  retainSessionEpochSchema,
} from '../../src/identity/session-epoch.js';
import { initializeNativeExperienceAccount } from '../../src/experience/lifecycle.js';
import { initializeNativeSafetyAccount } from '../../src/safety/lifecycle.js';
import { AppLogger } from '../../src/observability/logger.js';
import { PersonalTimetableRepository } from '../../src/personal-timetable/repository.js';
import { PersonalTimetableService } from '../../src/personal-timetable/service.js';
import {
  type TimetableReceipt,
  type TimetableCommand,
} from '../../src/personal-timetable/contracts.js';
import type { SessionView } from '../../src/identity/contracts.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';
const appCode = (code: string) => (e: unknown) =>
  e instanceof ApplicationError && e.code === code;
const sqlCode = (code: string) => (e: unknown) =>
  e instanceof Error && 'code' in e && e.code === code;
const appId = 'wx0123456789abcdef';
const credentials = () => ({
  access: mintToken('access'),
  refresh: mintToken('refresh'),
});
const hashes = (tokens: ReturnType<typeof credentials>) => ({
  access: hashToken(tokens.access),
  refresh: hashToken(tokens.refresh),
});

test(
  '0180 real epoch schema, old credentials, authority coverage and final rollback',
  { timeout: 180000 },
  async (t) => {
    const connection = process.env['TEST_DATABASE_URL'];
    assert.ok(
      connection,
      'Disposable loopback whaleu_test required; never skip',
    );
    const url = new URL(connection);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: connection,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '5',
    });
    const pool = new Pool(poolOptions(config));
    const db = new DatabaseService(config, new AppLogger(config));
    const repository = new IdentityRepository(db, config);
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
      assert.equal(locked, true, 'Another suite owns this disposable database');
      assert.ok(
        supportedPostgresVersion(
          (
            await suite.query<{ version: number }>(
              "SELECT current_setting('server_version_num')::integer version",
            )
          ).rows[0]!.version,
        ),
      );
      assert.equal(
        (
          await suite.query<{ count: number }>(
            'SELECT count(*)::integer count FROM pg_namespace WHERE nspname=ANY($1::text[])',
            [migrationSchemaNames],
          )
        ).rows[0]!.count,
        0,
        'Never touch an existing app schema',
      );
      const migrations = await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      );
      const candidate = migrations.find(
        (m) => m.name === '0180_identity_session_revocation_epoch.sql',
      );
      assert.ok(candidate);
      owns = true;
      await runMigrations(
        pool,
        migrations.filter((m) => m.name < candidate.name),
        { mode: 'up' },
      );

      // Real predecessor storage, generated test-only identifiers, no provider network.
      const old = {
        account: randomUUID(),
        session: randomUUID(),
        subject: 'synthetic-epoch-old',
        tokens: credentials(),
      };
      const timetable = new PersonalTimetableRepository();
      const command: TimetableCommand = {
        version: 1,
        requestId: randomUUID(),
        termId: randomUUID(),
        operation: 'term.create',
        expectedRevision: 0,
        payload: {
          name: 'Synthetic predecessor term',
          weekOneMonday: '2026-10-19',
          weekCount: 16,
          timeZone: 'Asia/Shanghai',
        },
      };
      let receipt: TimetableReceipt | undefined;
      await inTransaction(pool, async (tx) => {
        await tx.query('INSERT INTO whaleu_identity.accounts(id) VALUES($1)', [
          old.account,
        ]);
        await initializeNativeExperienceAccount(old.account, tx);
        await initializeNativeSafetyAccount(old.account, tx);
        await tx.query(
          "INSERT INTO whaleu_identity.provider_identities(provider,app_id,subject,account_id) VALUES('wechat',$1,$2,$3)",
          [appId, old.subject, old.account],
        );
        await tx.query(
          "INSERT INTO whaleu_identity.sessions(id,account_id,access_expires_at,refresh_expires_at,absolute_expires_at) VALUES($1,$2,clock_timestamp()+interval '10 minutes',clock_timestamp()+interval '7 days',clock_timestamp()+interval '30 days')",
          [old.session, old.account],
        );
        await tx.query(
          "INSERT INTO whaleu_identity.access_tokens(token_hash,session_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '10 minutes')",
          [hashToken(old.tokens.access), old.session],
        );
        await tx.query(
          'INSERT INTO whaleu_identity.refresh_tokens(token_hash,session_id) VALUES($1,$2)',
          [hashToken(old.tokens.refresh), old.session],
        );
        // Execute the actual predecessor owner operation, not an invented receipt.
        // The existing SQL Identity predicate proves the presented pre-epoch token.
        await tx.query(
          'SELECT id FROM whaleu_identity.accounts WHERE id=$1 FOR SHARE',
          [old.account],
        );
        await tx.query(
          'SELECT id FROM whaleu_identity.sessions WHERE id=$1 FOR SHARE',
          [old.session],
        );
        await tx.query(
          'SELECT token_hash FROM whaleu_identity.access_tokens WHERE token_hash=$1 FOR SHARE',
          [hashToken(old.tokens.access)],
        );
        assert.equal(
          (
            await tx.query<{ valid: boolean }>(
              'SELECT whaleu_profile.self_edit_identity_current($1,$2,$3) valid',
              [old.account, old.session, hashToken(old.tokens.access)],
            )
          ).rows[0]!.valid,
          true,
        );
        await timetable.lock(old.account, tx);
        receipt = await timetable.save(
          old.account,
          await timetable.apply(old.account, command, tx),
          tx,
        );
        assert.equal(receipt.outcome, 'applied');
      });
      assert.ok(receipt);
      const identityFingerprint = `SELECT whaleu_profile.moderation_hash(whaleu_profile.moderation_identity_facts($1,$2,$3)) hash`;
      const oldHash = (
        await pool.query<{ hash: string }>(identityFingerprint, [
          old.account,
          old.session,
          hashToken(old.tokens.access),
        ])
      ).rows[0]!.hash;
      const receiptBefore = (
        await pool.query(
          'SELECT to_jsonb(c) value FROM whaleu_timetable.commands c WHERE account_id=$1 AND request_id=$2',
          [old.account, command.requestId],
        )
      ).rows;

      for (const drift of [
        'signature',
        'default',
        'metadata',
        'overload',
      ] as const)
        await t.test(
          'migration rolls back on exact predecessor ' + drift + ' drift',
          async () => {
            await assert.rejects(
              inTransaction(pool, async (tx) => {
                if (drift === 'signature') {
                  const body = (
                    await tx.query<{ definition: string }>(
                      "SELECT pg_get_functiondef('whaleu_authorization.school_admin_management_identity(uuid,uuid,text)'::regprocedure) definition",
                    )
                  ).rows[0]!.definition;
                  await tx.query(
                    'ALTER FUNCTION whaleu_authorization.school_admin_management_identity(uuid,uuid,text) RENAME TO epoch_prior_test_identity',
                  );
                  assert.ok(body.includes('token text'));
                  await tx.query(
                    body.replace('token text', 'token character varying'),
                  );
                } else if (drift === 'default') {
                  const body = (
                    await tx.query<{ definition: string }>(
                      "SELECT pg_get_functiondef('whaleu_authorization.require_errand_management_authority(uuid,uuid,uuid,uuid)'::regprocedure) definition",
                    )
                  ).rows[0]!.definition;
                  assert.ok(body.includes('DEFAULT NULL::uuid'));
                  await tx.query(
                    body.replace(
                      'DEFAULT NULL::uuid',
                      "DEFAULT '00000000-0000-4000-8000-000000000000'::uuid",
                    ),
                  );
                } else if (drift === 'metadata')
                  await tx.query(
                    'ALTER FUNCTION whaleu_identity.course_comment_session(uuid,uuid,timestamptz) SET search_path=public',
                  );
                else
                  await tx.query(
                    "CREATE FUNCTION whaleu_identity.course_comment_session(text) RETURNS boolean LANGUAGE sql AS 'SELECT true'",
                  );
                await tx.query(candidate.sql);
              }),
              sqlCode('23514'),
            );
            assert.equal(
              (
                await pool.query(
                  "SELECT 1 FROM pg_attribute WHERE attrelid='whaleu_identity.accounts'::regclass AND attname='session_revocation_epoch' AND NOT attisdropped",
                )
              ).rowCount,
              0,
            );
          },
        );
      await runMigrations(pool, migrations, { mode: 'up' });
      await t.test(
        'actual installed schema qualifies and old zero-epoch credentials remain valid',
        async () => {
          await inTransaction(pool, inspectSessionEpochSchema);
          assert.equal(
            (await repository.authenticate(hashToken(old.tokens.access)))
              .accountId,
            old.account,
          );
          assert.deepEqual(
            (
              await pool.query(
                'SELECT a.session_revocation_epoch,s.issued_revocation_epoch FROM whaleu_identity.accounts a JOIN whaleu_identity.sessions s ON s.account_id=a.id WHERE s.id=$1',
                [old.session],
              )
            ).rows[0],
            { session_revocation_epoch: '0', issued_revocation_epoch: '0' },
          );
        },
      );
      await t.test(
        'old identity fingerprint changes without rewriting terminal receipt; new-session replay recovers exact old receipt',
        async () => {
          const currentHash = (
            await pool.query<{ hash: string }>(identityFingerprint, [
              old.account,
              old.session,
              hashToken(old.tokens.access),
            ])
          ).rows[0]!.hash;
          assert.notEqual(currentHash, oldHash);
          assert.deepEqual(
            (
              await pool.query(
                'SELECT to_jsonb(c) value FROM whaleu_timetable.commands c WHERE account_id=$1 AND request_id=$2',
                [old.account, command.requestId],
              )
            ).rows,
            receiptBefore,
          );
          await assert.rejects(
            inTransaction(pool, (tx) =>
              tx.query(
                'INSERT INTO whaleu_profile.self_edit_causes(id,actor_id,session_id,token_hash,expected_revision,patch,identity_hash) VALUES($1,$2,$3,$4,0,\'{"bio":"synthetic-pending"}\'::jsonb,$5)',
                [
                  randomUUID(),
                  old.account,
                  old.session,
                  hashToken(old.tokens.access),
                  oldHash,
                ],
              ),
            ),
            sqlCode('23514'),
          );
          const tokens = credentials();
          await repository.createSession(
            { provider: 'wechat', appId, subject: old.subject },
            hashes(tokens),
          );
          const identity = new IdentityService(
            {
              exchange: async () => {
                throw new Error('No provider dispatch');
              },
            },
            repository,
          );
          const service = new PersonalTimetableService(db, identity, timetable);
          assert.deepEqual(
            await service.execute(tokens.access, command),
            receipt,
          );
          assert.deepEqual(
            (
              await pool.query(
                'SELECT to_jsonb(c) value FROM whaleu_timetable.commands c WHERE account_id=$1 AND request_id=$2',
                [old.account, command.requestId],
              )
            ).rows,
            receiptBefore,
          );
        },
      );
      for (const statement of [
        'ALTER TABLE whaleu_identity.accounts DISABLE TRIGGER session_epoch_account',
        'ALTER TABLE whaleu_identity.sessions DISABLE TRIGGER session_epoch_issued',
        'ALTER TABLE whaleu_identity.accounts DROP CONSTRAINT session_epoch_account_nonnegative',
        'ALTER TABLE whaleu_identity.sessions DROP CONSTRAINT session_epoch_issued_nonnegative; ALTER TABLE whaleu_identity.sessions ADD CONSTRAINT session_epoch_issued_nonnegative CHECK(issued_revocation_epoch>=0) NOT VALID',
        'ALTER TABLE whaleu_identity.sessions DROP CONSTRAINT session_epoch_issued_nonnegative; ALTER TABLE whaleu_identity.sessions ADD CONSTRAINT session_epoch_issued_nonnegative CHECK(issued_revocation_epoch>=-1)',
        "CREATE FUNCTION whaleu_identity.session_epoch_protocol(text) RETURNS jsonb LANGUAGE sql AS 'SELECT null::jsonb'",
        'DROP TRIGGER session_epoch_account ON whaleu_identity.accounts; CREATE TRIGGER session_epoch_account BEFORE INSERT OR UPDATE OF status ON whaleu_identity.accounts FOR EACH ROW EXECUTE FUNCTION whaleu_identity.session_epoch_account_guard()',
        'DROP TRIGGER session_epoch_issued ON whaleu_identity.sessions; CREATE TRIGGER session_epoch_issued BEFORE INSERT OR UPDATE OF revoked_at ON whaleu_identity.sessions FOR EACH ROW EXECUTE FUNCTION whaleu_identity.session_epoch_issued_guard()',
      ])
        await t.test(
          'actual schema drift is rejected: ' + statement,
          async () => {
            await assert.rejects(
              inTransaction(pool, async (tx) => {
                await tx.query(statement);
                await retainSessionEpochSchema(tx);
              }),
              appCode('AUTH_NOT_CONFIGURED'),
            );
            await inTransaction(pool, inspectSessionEpochSchema);
          },
        );
      for (const statement of [
        'UPDATE whaleu_identity.accounts SET session_revocation_epoch=1 WHERE id=$1',
        'UPDATE whaleu_identity.accounts SET session_revocation_epoch=-1 WHERE id=$1',
        'UPDATE whaleu_identity.sessions SET issued_revocation_epoch=1 WHERE account_id=$1',
        'UPDATE whaleu_identity.sessions SET id=gen_random_uuid() WHERE account_id=$1',
      ])
        await t.test(
          'closed epoch foundation rejects arbitrary authority: ' + statement,
          async () => {
            await assert.rejects(
              pool.query(statement, [old.account]),
              sqlCode('23514'),
            );
          },
        );
      await t.test(
        'new accounts cannot invent nonzero epoch and sessions cannot invent issued epoch',
        async () => {
          await assert.rejects(
            pool.query(
              'INSERT INTO whaleu_identity.accounts(id,session_revocation_epoch) VALUES($1,1)',
              [randomUUID()],
            ),
            sqlCode('23514'),
          );
          await assert.rejects(
            pool.query(
              "INSERT INTO whaleu_identity.sessions(id,account_id,issued_revocation_epoch,access_expires_at,refresh_expires_at,absolute_expires_at) VALUES($1,$2,1,clock_timestamp()+interval '1 minute',clock_timestamp()+interval '1 day',clock_timestamp()+interval '30 days')",
              [randomUUID(), old.account],
            ),
            sqlCode('23514'),
          );
        },
      );
      await t.test(
        'fault-injected stale epoch is rejected by Identity and independent SQL, never a real bump authority',
        async () => {
          const rollback = new Error('rollback-negative-fixture');
          await assert.rejects(
            inTransaction(pool, async (tx) => {
              // Corruption injection solely in this rollback-only test. No real request
              // or completion is invented; production guard remains write-closed.
              await tx.query(
                'ALTER TABLE whaleu_identity.accounts DISABLE TRIGGER session_epoch_account',
              );
              await tx.query(
                'UPDATE whaleu_identity.accounts SET session_revocation_epoch=1 WHERE id=$1',
                [old.account],
              );
              // Run genuine deferred checks before restoring the sole disabled guard.
              // No constraint is skipped, and the sentinel below rolls back all changes.
              await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
              await tx.query(
                'ALTER TABLE whaleu_identity.accounts ENABLE TRIGGER session_epoch_account',
              );
              await assert.rejects(
                repository.authenticate(hashToken(old.tokens.access), tx),
                appCode('SESSION_REVOKED'),
              );
              const result = (
                await tx.query<{ value: boolean }>(
                  'SELECT whaleu_identity.course_comment_session($1,$2,clock_timestamp()) value',
                  [old.account, old.session],
                )
              ).rows[0]!.value;
              assert.equal(result, false);
              throw rollback;
            }),
            (e) => e === rollback,
          );
          assert.equal(
            (
              await pool.query<{ epoch: string }>(
                'SELECT session_revocation_epoch::text epoch FROM whaleu_identity.accounts WHERE id=$1',
                [old.account],
              )
            ).rows[0]!.epoch,
            '0',
          );
          await inTransaction(pool, inspectSessionEpochSchema);
        },
      );
      await t.test(
        'refresh single-use replay commits revocation and never extends absolute lifetime',
        async () => {
          const tokens = credentials();
          const first = await repository.createSession(
            { provider: 'wechat', appId, subject: 'synthetic-epoch-refresh' },
            hashes(tokens),
          );
          const before = (
            await pool.query(
              'SELECT absolute_expires_at FROM whaleu_identity.sessions WHERE id=$1',
              [first.sessionId],
            )
          ).rows[0];
          const next = credentials();
          await repository.rotate(hashToken(tokens.refresh), hashes(next));
          assert.deepEqual(
            (
              await pool.query(
                'SELECT absolute_expires_at FROM whaleu_identity.sessions WHERE id=$1',
                [first.sessionId],
              )
            ).rows[0],
            before,
          );
          await assert.rejects(
            repository.rotate(hashToken(tokens.refresh), hashes(credentials())),
            appCode('REFRESH_TOKEN_REUSED'),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT revoke_reason FROM whaleu_identity.sessions WHERE id=$1',
                [first.sessionId],
              )
            ).rows[0]!.revoke_reason,
            'refresh_replay',
          );
          await assert.rejects(
            repository.authenticate(hashToken(next.access)),
            appCode('SESSION_REVOKED'),
          );
          await repository.revoke(hashToken(tokens.access));
          await repository.revoke(hashToken(tokens.access));
        },
      );
      await t.test(
        'real tentative session writes roll back when final live proof sees same-TX logout',
        async () => {
          const tokens = credentials();
          let tentative = false;
          const failing = {
            transaction: <T>(
              work: (tx: PoolClient) => Promise<T>,
              options?: TransactionOptions,
            ) =>
              db.transaction(async (tx) => {
                const result = await work(tx);
                const session = result as SessionView;
                assert.equal(
                  (
                    await tx.query(
                      'SELECT 1 FROM whaleu_identity.access_tokens WHERE session_id=$1',
                      [session.sessionId],
                    )
                  ).rowCount,
                  1,
                );
                tentative = true;
                await tx.query(
                  "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=$1",
                  [session.sessionId],
                );
                return result;
              }, options),
          } as DatabaseService;
          await assert.rejects(
            new IdentityRepository(failing, config).createSession(
              {
                provider: 'wechat',
                appId,
                subject: 'synthetic-epoch-final-rollback',
              },
              hashes(tokens),
            ),
            appCode('SESSION_REVOKED'),
          );
          assert.equal(tentative, true);
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_identity.access_tokens WHERE token_hash=$1',
                [hashToken(tokens.access)],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_identity.provider_identities WHERE subject=$1',
                ['synthetic-epoch-final-rollback'],
              )
            ).rowCount,
            0,
          );
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
