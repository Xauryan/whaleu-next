import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
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
import type { SessionView } from '../../src/identity/contracts.js';
import type { TransactionOptions } from '../../src/database/database.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { assertRegistrationAllowed } from '../../src/identity/registration/guard.js';
import { inspectRegistrationSchema } from '../../src/identity/registration/readiness.js';
import {
  registrationGuardTablePrivileges,
  registrationGuardColumnPrivileges,
  registrationGuardFunctionPrivileges,
} from '../../src/identity/registration/role-contract.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { AppLogger } from '../../src/observability/logger.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';
const denied = (e: unknown) =>
  e instanceof ApplicationError && e.code === 'AUTH_NOT_CONFIGURED';
const identity = {
  provider: 'wechat' as const,
  appId: 'wx0123456789abcdef',
  subject: 'synthetic-registration-guard-pg',
};

test(
  '0179 real registration gate, partial schemas, final fences and least-privilege role',
  { timeout: 180000 },
  async (t) => {
    const connection = process.env['TEST_DATABASE_URL'];
    assert.ok(
      connection,
      'Disposable loopback whaleu_test is required; never skip',
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
    const database = new DatabaseService(config, new AppLogger(config));
    const role = 'registration_guard_' + randomUUID().replaceAll('-', '');
    let suite: PoolClient | undefined,
      locked = false,
      owns = false,
      ownsRole = false;
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert.equal(
        locked,
        true,
        'Another integration suite owns this disposable database',
      );
      const version = (
        await suite.query<{ version: number }>(
          "SELECT current_setting('server_version_num')::integer version",
        )
      ).rows[0]!.version;
      assert.ok(supportedPostgresVersion(version));
      const existing = (
        await suite.query<{ count: number }>(
          'SELECT count(*)::integer count FROM pg_namespace WHERE nspname=ANY($1::text[])',
          [migrationSchemaNames],
        )
      ).rows[0]!.count;
      assert.equal(existing, 0, 'Never touch an existing application schema');
      const migrations = await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      );
      assert.ok(
        migrations.some((m) => m.name === '0178_home_publication_protocol.sql'),
        'Integrate reviewed Home predecessors; never bypass 0179 prerequisite',
      );
      owns = true;
      const candidate = migrations.find(
        (m) => m.name === '0179_identity_registration_guard.sql',
      );
      assert.ok(candidate);
      await runMigrations(
        pool,
        migrations.filter((m) => m.name < candidate.name),
        { mode: 'up' },
      );
      for (const statement of [
        'CREATE TABLE whaleu_identity.registration_guard_unexpected(payload text)',
        "CREATE FUNCTION whaleu_identity.registration_guard_unexpected() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
      ])
        await t.test(
          '0179 refuses to bless pre-existing unknown objects: ' + statement,
          async () => {
            await assert.rejects(
              inTransaction(pool, async (tx) => {
                await tx.query(statement);
                await tx.query(candidate.sql);
              }),
              (e: unknown) =>
                e instanceof Error && 'code' in e && e.code === '23514',
            );
            assert.deepEqual(
              (
                await pool.query(
                  `SELECT to_regclass('whaleu_identity.registration_guard_unexpected') relation, to_regprocedure('whaleu_identity.registration_guard_unexpected()') function`,
                )
              ).rows[0],
              { relation: null, function: null },
            );
          },
        );
      await runMigrations(pool, migrations, { mode: 'up' });

      await t.test(
        'default first registration and existing login use actual Identity transaction',
        async () => {
          const repo = new IdentityRepository(database, config);
          const first = await repo.createSession(identity, {
            access: 'a'.repeat(64),
            refresh: 'b'.repeat(64),
          });
          const next = await repo.createSession(identity, {
            access: 'c'.repeat(64),
            refresh: 'd'.repeat(64),
          });
          assert.equal(first.accountId, next.accountId);
          assert.notEqual(first.sessionId, next.sessionId);
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_identity.registration_guards',
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'required mode rejects new registration without real completion authority',
        async () => {
          await assert.rejects(
            inTransaction(pool, (tx) =>
              assertRegistrationAllowed(tx, identity, {
                IDENTITY_REGISTRATION_GUARD: 'required',
              }),
            ),
            denied,
          );
        },
      );
      const before = await inTransaction(pool, inspectRegistrationSchema);
      for (const statement of [
        'ALTER TABLE whaleu_identity.registration_guards DROP COLUMN reregister_after',
        'ALTER TABLE whaleu_identity.registration_guard_policy DISABLE TRIGGER registration_guard_policy_closed',
        'ALTER TABLE whaleu_identity.registration_guards DROP CONSTRAINT registration_guards_pkey',
        'DROP INDEX whaleu_identity.registration_guards_identity',
        'ALTER TABLE whaleu_identity.registration_guard_policy ALTER CONSTRAINT registration_guard_active_epoch NOT ENFORCED',
        "CREATE FUNCTION whaleu_identity.registration_guard_protocol(text) RETURNS jsonb LANGUAGE sql AS 'SELECT null::jsonb'",
        'CREATE TABLE whaleu_identity.registration_guard_unexpected(payload text)',
      ])
        await t.test(
          'partial schema cannot pass empty-table admission: ' + statement,
          async () => {
            await assert.rejects(
              inTransaction(pool, async (tx) => {
                await tx.query(statement);
                await assertRegistrationAllowed(tx, identity);
              }),
              denied,
            );
            assert.equal(
              await inTransaction(pool, inspectRegistrationSchema),
              before,
              'Failed proof rolls back schema mutation',
            );
          },
        );
      await t.test(
        'disabled internal FK trigger cannot pass the unchanged-constraint seal',
        async () => {
          await assert.rejects(
            inTransaction(pool, async (tx) => {
              const trigger = (
                await tx.query<{ tgname: string }>(
                  `SELECT tgname FROM pg_trigger WHERE tgrelid='whaleu_identity.registration_guard_policy'::regclass AND tgisinternal ORDER BY tgname LIMIT 1`,
                )
              ).rows[0]!.tgname;
              assert.match(trigger, /^[A-Za-z0-9_]+$/);
              await tx.query(
                `ALTER TABLE whaleu_identity.registration_guard_policy DISABLE TRIGGER "${trigger}"`,
              );
              await assertRegistrationAllowed(tx, identity);
            }),
            denied,
          );
          assert.equal(
            await inTransaction(pool, inspectRegistrationSchema),
            before,
          );
        },
      );
      for (const budget of [
        'facts',
        'source-bytes',
        'table-options',
        'index-options',
        'index-expression',
        'item-bytes',
        'total-bytes',
      ] as const)
        await t.test(
          'catalog hard budget rejects ' +
            budget +
            ' before aggregate admission',
          async () => {
            await assert.rejects(
              inTransaction(pool, async (tx) => {
                if (budget === 'facts')
                  for (let i = 0; i < 65; i++)
                    await tx.query(
                      `ALTER TABLE whaleu_identity.registration_guards ADD CONSTRAINT registration_guard_extra_${i} CHECK(generation>0)`,
                    );
                if (budget === 'source-bytes')
                  await tx.query(
                    `ALTER TABLE whaleu_identity.registration_guard_policy ALTER COLUMN active_epoch SET DEFAULT '${'x'.repeat(20000)}'`,
                  );
                if (budget === 'table-options' || budget === 'index-options') {
                  const relation =
                    budget === 'table-options'
                      ? 'whaleu_identity.registration_guard_policy'
                      : 'whaleu_identity.registration_guards_pkey';
                  const kind = budget === 'table-options' ? 'TABLE' : 'INDEX';
                  await tx.query(
                    `ALTER ${kind} ${relation} SET(fillfactor='${'0'.repeat(20000)}70')`,
                  );
                  const bytes = (
                    await tx.query<{ bytes: number }>(
                      'SELECT octet_length(reloptions::text) bytes FROM pg_class WHERE oid=$1::regclass',
                      [relation],
                    )
                  ).rows[0]!.bytes;
                  assert.ok(
                    bytes > 16384,
                    'The actual catalog must retain an oversized option; normalized DDL is not a valid overflow test',
                  );
                }
                if (budget === 'index-expression')
                  await tx.query(
                    `CREATE INDEX registration_guard_large_expression ON whaleu_identity.registration_guards((identity_digest||'${'x'.repeat(20000)}'))`,
                  );
                if (budget === 'item-bytes') {
                  const body =
                    'BEGIN /*' +
                    '\\'.repeat(16000) +
                    "*/ RAISE EXCEPTION 'closed'; END";
                  await tx.query(
                    `CREATE OR REPLACE FUNCTION whaleu_identity.registration_guard_unavailable() RETURNS trigger LANGUAGE plpgsql SET registration_guard.synthetic TO '${'x'.repeat(2000)}' AS $oversize$${body}$oversize$`,
                  );
                }
                if (budget === 'total-bytes')
                  for (let i = 0; i < 24; i++)
                    await tx.query(
                      `CREATE TRIGGER registration_guard_extra_${i} BEFORE UPDATE ON whaleu_identity.registration_guards FOR EACH STATEMENT EXECUTE FUNCTION whaleu_identity.registration_guard_unavailable('${'x'.repeat(12000)}')`,
                    );
                assert.equal(
                  (
                    await tx.query<{ catalog: string | null }>(
                      'SELECT whaleu_identity.registration_guard_catalog() catalog',
                    )
                  ).rows[0]!.catalog,
                  null,
                );
                await assertRegistrationAllowed(tx, identity);
              }),
              denied,
            );
            assert.equal(
              await inTransaction(pool, inspectRegistrationSchema),
              before,
            );
          },
        );
      for (const terminal of ['commit', 'rollback'] as const)
        await t.test(
          'shared schema fence survives until ' +
            terminal +
            ' then releases the migrator',
          async () => {
            const rollback = new Error('synthetic intentional rollback');
            const work = inTransaction(pool, async (tx) => {
              await assertRegistrationAllowed(tx, identity);
              const locked = (
                await suite!.query<{ locked: boolean }>(
                  'SELECT pg_try_advisory_lock($1,$2) locked',
                  [...MIGRATION_LOCK],
                )
              ).rows[0]!.locked;
              if (locked)
                await suite!.query('SELECT pg_advisory_unlock($1,$2)', [
                  ...MIGRATION_LOCK,
                ]);
              assert.equal(
                locked,
                false,
                'Shared registration fence must retain through transaction',
              );
              if (terminal === 'rollback') throw rollback;
            });
            if (terminal === 'rollback')
              await assert.rejects(work, (e: unknown) => e === rollback);
            else await work;
            const locked = (
              await suite!.query<{ locked: boolean }>(
                'SELECT pg_try_advisory_lock($1,$2) locked',
                [...MIGRATION_LOCK],
              )
            ).rows[0]!.locked;
            try {
              assert.equal(locked, true);
            } finally {
              if (locked)
                await suite!.query('SELECT pg_advisory_unlock($1,$2)', [
                  ...MIGRATION_LOCK,
                ]);
            }
          },
        );
      await t.test(
        'actual createSession tentative identity, tokens and baselines all roll back on final schema failure',
        async () => {
          const tables = [
            'whaleu_identity.accounts',
            'whaleu_identity.provider_identities',
            'whaleu_identity.sessions',
            'whaleu_identity.access_tokens',
            'whaleu_identity.refresh_tokens',
            'whaleu_experience.owners',
            'whaleu_experience.baselines',
            'whaleu_experience.account_states',
            'whaleu_experience.entitlements',
            'whaleu_experience.appearance',
            'whaleu_safety.account_heads',
            'whaleu_safety.events',
          ];
          const counts =
            tables
              .map(
                (table) =>
                  `SELECT '${table}' relation,count(*)::integer rows FROM ${table}`,
              )
              .join(' UNION ALL ') + ' ORDER BY relation';
          const original = (await pool.query(counts)).rows;
          let tentative = false;
          const failing = {
            transaction: <T>(
              operation: (tx: PoolClient) => Promise<T>,
              options?: TransactionOptions,
            ) =>
              database.transaction(async (tx) => {
                const result = await operation(tx);
                const session = result as SessionView;
                assert.equal(
                  (
                    await tx.query(
                      'SELECT 1 FROM whaleu_identity.accounts WHERE id=$1',
                      [session.accountId],
                    )
                  ).rowCount,
                  1,
                );
                assert.equal(
                  (
                    await tx.query(
                      'SELECT 1 FROM whaleu_identity.sessions WHERE id=$1',
                      [session.sessionId],
                    )
                  ).rowCount,
                  1,
                );
                assert.equal(
                  (
                    await tx.query(
                      'SELECT 1 FROM whaleu_identity.access_tokens WHERE session_id=$1',
                      [session.sessionId],
                    )
                  ).rowCount,
                  1,
                );
                assert.equal(
                  (
                    await tx.query(
                      'SELECT 1 FROM whaleu_identity.refresh_tokens WHERE session_id=$1',
                      [session.sessionId],
                    )
                  ).rowCount,
                  1,
                );
                assert.notDeepEqual((await tx.query(counts)).rows, original);
                tentative = true;
                await tx.query(
                  'ALTER TABLE whaleu_identity.registration_guards DISABLE TRIGGER registration_guards_closed',
                );
                return result;
              }, options),
          } as unknown as DatabaseService;
          await assert.rejects(
            new IdentityRepository(failing, config).createSession(
              { ...identity, subject: 'synthetic-final-rollback' },
              { access: 'e'.repeat(64), refresh: 'f'.repeat(64) },
            ),
            denied,
          );
          assert.equal(
            tentative,
            true,
            'Must reach real writes before the final failure',
          );
          assert.deepEqual((await pool.query(counts)).rows, original);
          assert.equal(
            await inTransaction(pool, inspectRegistrationSchema),
            before,
          );
        },
      );
      await t.test(
        'schema changed after successful check is rejected at final proof and rolled back',
        async () => {
          await assert.rejects(
            inTransaction(pool, async (tx) => {
              await assertRegistrationAllowed(tx, identity);
              await tx.query(
                'ALTER TABLE whaleu_identity.registration_guards DISABLE TRIGGER registration_guards_closed',
              );
            }),
            denied,
          );
          assert.equal(
            await inTransaction(pool, inspectRegistrationSchema),
            before,
          );
        },
      );

      await suite.query(
        `CREATE ROLE "${role}" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
      );
      ownsRole = true;
      await suite.query(`GRANT USAGE ON SCHEMA whaleu_identity TO "${role}"`);
      for (const grant of registrationGuardTablePrivileges)
        await suite.query(
          `GRANT ${grant.privilege} ON ${grant.relation} TO "${role}"`,
        );
      for (const grant of registrationGuardColumnPrivileges)
        await suite.query(
          `GRANT ${grant.privilege}(${grant.column}) ON ${grant.relation} TO "${role}"`,
        );
      for (const fn of registrationGuardFunctionPrivileges)
        await suite.query(`GRANT EXECUTE ON FUNCTION ${fn} TO "${role}"`);
      const withRole = (work: (tx: PoolClient) => Promise<void>) =>
        inTransaction(pool, async (tx) => {
          await tx.query(`SET LOCAL ROLE "${role}"`);
          assert.equal(
            (await tx.query<{ current_user: string }>('SELECT current_user'))
              .rows[0]!.current_user,
            role,
          );
          await work(tx);
        });
      await t.test(
        'non-owner role admits default registration with exact named row-lock rights and no broad table UPDATE',
        async () => {
          await withRole((tx) => assertRegistrationAllowed(tx, identity));
          const privileges = (
            await pool.query<{
              relation: string;
              privilege: string;
              allowed: boolean;
            }>(
              `SELECT relation, privilege, has_table_privilege($1,relation,privilege) allowed
               FROM unnest($2::text[]) relation CROSS JOIN unnest($3::text[]) privilege`,
              [
                role,
                registrationGuardTablePrivileges.map((g) => g.relation),
                [
                  'UPDATE',
                  'INSERT',
                  'DELETE',
                  'TRUNCATE',
                  'TRIGGER',
                  'REFERENCES',
                  'MAINTAIN',
                ],
              ],
            )
          ).rows;
          assert.equal(privileges.length, 21);
          for (const privilege of privileges)
            assert.equal(
              privilege.allowed,
              false,
              `${privilege.relation} ${privilege.privilege} is forbidden`,
            );
          for (const grant of registrationGuardColumnPrivileges)
            assert.equal(
              (
                await pool.query<{ allowed: boolean }>(
                  'SELECT has_column_privilege($1,$2,$3,$4) allowed',
                  [role, grant.relation, grant.column, grant.privilege],
                )
              ).rows[0]!.allowed,
              true,
            );
        },
      );
      await t.test(
        'removing named UPDATE(slot) breaks FOR SHARE rather than silently bypassing it',
        async () => {
          await suite!.query(
            `REVOKE UPDATE(slot) ON whaleu_identity.registration_guard_policy FROM "${role}"`,
          );
          try {
            await assert.rejects(
              withRole((tx) => assertRegistrationAllowed(tx, identity)),
              denied,
            );
          } finally {
            await suite!.query(
              `GRANT UPDATE(slot) ON whaleu_identity.registration_guard_policy TO "${role}"`,
            );
          }
        },
      );
      await t.test(
        'epoch FOR SHARE requires only its named UPDATE(epoch), even on an empty registry',
        async () => {
          const readEpochs = (tx: PoolClient) =>
            tx
              .query(
                'SELECT epoch FROM whaleu_identity.registration_guard_key_epochs FOR SHARE',
              )
              .then(() => undefined);
          await withRole(readEpochs);
          await suite!.query(
            `REVOKE UPDATE(epoch) ON whaleu_identity.registration_guard_key_epochs FROM "${role}"`,
          );
          try {
            await assert.rejects(
              withRole(readEpochs),
              (e: unknown) =>
                e instanceof Error && 'code' in e && e.code === '42501',
            );
          } finally {
            await suite!.query(
              `GRANT UPDATE(epoch) ON whaleu_identity.registration_guard_key_epochs TO "${role}"`,
            );
          }
        },
      );
      await t.test(
        'official exclusive migration gate rejects registration without table-lock privileges',
        async () => {
          await suite!.query('SELECT pg_advisory_lock($1,$2)', [
            ...MIGRATION_LOCK,
          ]);
          try {
            await assert.rejects(
              withRole((tx) => assertRegistrationAllowed(tx, identity)),
              denied,
            );
          } finally {
            await suite!.query('SELECT pg_advisory_unlock($1,$2)', [
              ...MIGRATION_LOCK,
            ]);
          }
        },
      );
      await t.test(
        'even named UPDATE authority cannot mutate the closed policy',
        async () => {
          await assert.rejects(
            withRole(async (tx) => {
              await tx.query(
                'UPDATE whaleu_identity.registration_guard_policy SET slot=slot',
              );
            }),
            (e: unknown) =>
              e instanceof Error && 'code' in e && e.code === '23514',
          );
        },
      );
      await t.test(
        'completion insertion remains unavailable even to the test schema owner',
        async () => {
          await assert.rejects(
            pool.query(
              `INSERT INTO whaleu_identity.registration_guard_key_epochs(epoch,key_check) VALUES('synthetic-key',$1)`,
              ['a'.repeat(64)],
            ),
            (e: unknown) =>
              e instanceof Error && 'code' in e && e.code === '23514',
          );
        },
      );
      await t.test(
        'PostgreSQL preserves microsecond inequality and exact expiry equality',
        async () => {
          const row = (
            await pool.query<{
              before: boolean;
              equal: boolean;
              exact_period: boolean;
            }>(
              `SELECT '2028-03-29 23:59:59.999122+00'::timestamptz < '2028-03-29 23:59:59.999123+00'::timestamptz before,
         NOT ('2028-03-29 23:59:59.999123+00'::timestamptz > '2028-03-29 23:59:59.999123+00'::timestamptz) equal,
         '2028-02-28 23:59:59.999123+00'::timestamptz + interval '2592000 seconds' = '2028-03-29 23:59:59.999123+00'::timestamptz exact_period`,
            )
          ).rows[0]!;
          assert.deepEqual(row, {
            before: true,
            equal: true,
            exact_period: true,
          });
        },
      );
    } finally {
      await database.onApplicationShutdown();
      if (ownsRole && suite) {
        await suite.query(`DROP OWNED BY "${role}"`);
        await suite.query(`DROP ROLE "${role}"`);
      }
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
