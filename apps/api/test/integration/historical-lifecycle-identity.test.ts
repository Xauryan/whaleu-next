import { historicalRealRequestPartials } from '../support/historical-real-request-absence.js';
/** Exact 0173/0174 historical Identity only. Real managed transactions, real
 * predecessor SQL and observed PostgreSQL locks; not current epoch acceptance.
 * Requires the centrally coordinated disposable database, with no skip mode. */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';
import type { TestContext } from 'node:test';
import type { Notification, Pool, PoolClient } from 'pg';
import { inTransaction } from '../../src/database/database.js';
import {
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../../src/database/transaction-deadlines.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { hashToken } from '../../src/identity/tokens.js';
import { accountDeletionFixture } from '../support/account-deletion-fixture.js';
import { historicalDeletionSchemaSql } from '../support/historical-lifecycle-identity/deletion.js';
import { inspectHistoricalDeletionPeer174 } from '../support/historical-deletion-peer.js';
import {
  historicalRealDeletionPartials,
  historicalRealDeletionLookalikeSql,
} from '../support/historical-real-deletion-partials.js';

type Fixture = Awaited<ReturnType<typeof accountDeletionFixture>>;
const historicalSchemaFlags = {
  lifecycle_present: true,
  deletion_present: true,
  real_deletion_absent: true,
  real_request_absent: true,
  registration_absent: true,
  epoch_absent: true,
  source_absent: true,
  reading_absent: true,
  home_absent: true,
} as const;
const denied = (error: unknown) =>
  error instanceof ApplicationError && error.code === 'AUTH_NOT_CONFIGURED';
const signal = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function observed(check: () => Promise<boolean>, message: string) {
  const deadline = performance.now() + 10000;
  while (performance.now() < deadline) {
    if (await check()) return;
    await setTimeout(10);
  }
  assert.fail(message);
}
async function pid(tx: PoolClient) {
  return (await tx.query<{ pid: number }>('SELECT pg_backend_pid() pid'))
    .rows[0]!.pid;
}
async function schema(f: Fixture) {
  const result = (
    await f.pool.query<Record<string, boolean>>(historicalDeletionSchemaSql)
  ).rows[0]!;
  assert.deepEqual(result, historicalSchemaFlags);
}
async function realSuccessorAbsenceControls(
  f: Fixture,
  t: TestContext,
  prefix: 173 | 174,
  access: string,
  accountId: string,
) {
  for (const [label, statement, absentFlag] of [
    ...historicalRealDeletionPartials.map(
      ([label, statement]) =>
        [`0181 ${label}`, statement, 'real_deletion_absent'] as const,
    ),
    ...historicalRealRequestPartials.map(
      ([label, statement]) =>
        [label, statement, 'real_request_absent'] as const,
    ),
  ])
    await t.test(`exact${prefix} rejects unledgered ${label}`, async () => {
      await assert.rejects(
        f.repository.transaction(async (tx) => {
          await tx.query(statement);
          const shape = (
            await tx.query<Record<string, boolean>>(historicalDeletionSchemaSql)
          ).rows[0]!;
          assert.deepEqual(shape, {
            ...historicalSchemaFlags,
            [absentFlag]: false,
          });
          await f.identity.authenticate(access, tx);
        }),
        denied,
      );
      if (prefix === 174) {
        await assert.rejects(
          f.repository.transaction(async (tx) => {
            await tx.query(statement);
            await inspectHistoricalDeletionPeer174(tx);
          }),
          /Partial or future schema is not an exact 0174 peer boundary/,
        );
        await f.repository.transaction(inspectHistoricalDeletionPeer174);
      }
      await schema(f);
      assert.equal(
        (await f.identity.authenticate(access)).accountId,
        accountId,
      );
    });
  await t.test(
    `exact${prefix} rejects namespace added after first proof`,
    async () => {
      await assert.rejects(
        f.repository.transaction(async (tx) => {
          await f.identity.authenticate(access, tx);
          await tx.query('CREATE SCHEMA whaleu_real_deletion');
        }),
        denied,
      );
      await schema(f);
      assert.equal(
        (await f.identity.authenticate(access)).accountId,
        accountId,
      );
    },
  );
  await t.test(
    `exact${prefix} preserves similarly named namespace acceptance`,
    async () => {
      const rollback = new Error('Rollback accepted lookalike test objects');
      await assert.rejects(
        f.repository.transaction(async (tx) => {
          await tx.query(historicalRealDeletionLookalikeSql);
          assert.equal(
            (await f.identity.authenticate(access, tx)).accountId,
            accountId,
          );
          if (prefix === 174) await inspectHistoricalDeletionPeer174(tx);
          throw rollback;
        }),
        (error: unknown) => error === rollback,
      );
      await schema(f);
      assert.equal(
        (
          await f.pool.query<{ namespace: string | null }>(
            "SELECT to_regnamespace('whaleu_real_deletion_archive')::text namespace",
          )
        ).rows[0]?.namespace,
        null,
      );
    },
  );
}
async function seals(f: Fixture) {
  return (
    await f.pool.query<{ value: string }>(`SELECT jsonb_build_object(
    'sandboxes',(SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM whaleu_account_deletion.sandboxes s),
    'inventory',(SELECT jsonb_agg(to_jsonb(i) ORDER BY sandbox_id,relation COLLATE "C") FROM whaleu_account_deletion.inventory i))::text value`)
  ).rows[0]!.value;
}
async function sharedFence(f: Fixture, backend: number) {
  return (
    await f.pool.query<{ held: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND classid=$2::oid AND objid=$3::oid AND objsubid=2 AND mode='ShareLock' AND granted) held`,
      [backend, ...MIGRATION_LOCK],
    )
  ).rows[0]!.held;
}

// The original collation suites remain unchanged and run independently. This
// proves the additional Identity owner cannot survive that precise upgrade.
test(
  'retained 0173 Identity rejects the real 0174 upgrade without resealing historical inventory',
  { timeout: 240000 },
  async (t) => {
    const f = await accountDeletionFixture({ throughMigration: 173 });
    t.after(() => f.close());
    const actor = await f.create(),
      before = await seals(f);
    assert.equal(
      (await f.identity.authenticate(hashToken(actor.accessToken))).accountId,
      actor.accountId,
    );
    await realSuccessorAbsenceControls(
      f,
      t,
      173,
      hashToken(actor.accessToken),
      actor.accountId,
    );
    const migrations = (
      await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      )
    ).filter(({ name }) => Number(name.slice(0, 4)) <= 174);
    assert.equal(
      migrations.at(-1)?.name,
      '0174_account_deletion_inventory_collation.sql',
    );
    await runMigrations(f.pool, migrations, { mode: 'up' });
    assert.deepEqual(await seals(f), before);
    await assert.rejects(
      f.identity.authenticate(hashToken(actor.accessToken)),
      denied,
    );
    await assert.rejects(
      f.repository.transaction((tx) =>
        f.identity.activeAccount(actor.accountId, tx),
      ),
      denied,
    );
    assert.deepEqual(await seals(f), before);
  },
);

test(
  'exact 0174 historical managed Identity boundary, partial objects and actual lock contention',
  { timeout: 300000 },
  async (t) => {
    const f = await accountDeletionFixture({ throughMigration: 174 });
    t.after(() => f.close());
    await t.test(
      'exact original 0088 Ratings columns coexist with all nine named true boundary flags',
      async () => {
        await schema(f);
        const columns = (
          await f.pool.query<{
            attname: string;
            type: string;
            attnotnull: boolean;
          }>(
            `SELECT a.attname,a.atttypid::regtype::text type,a.attnotnull FROM pg_attribute a
          WHERE a.attrelid='whaleu_ratings.category_icon_definitions'::regclass
            AND a.attname IN ('text_source_id','text_source_revision') AND NOT a.attisdropped ORDER BY a.attname`,
          )
        ).rows;
        assert.deepEqual(columns, [
          { attname: 'text_source_id', type: 'uuid', attnotnull: false },
          { attname: 'text_source_revision', type: 'uuid', attnotnull: false },
        ]);
      },
    );
    const actor = await f.create(),
      other = await f.create(),
      access = hashToken(actor.accessToken),
      before = await seals(f);
    const migrations = (
      await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      )
    ).filter(({ name }) => Number(name.slice(0, 4)) <= 174);
    await schema(f);

    await t.test(
      'fresh 174 uses actual sessions and keeps runtime peer non-admitted',
      async () => {
        assert.equal(
          (await f.identity.authenticate(access)).accountId,
          actor.accountId,
        );
        const peer = await f.identity.createSession(
          {
            provider: 'wechat',
            appId: 'synthetic-runtime-only',
            subject: randomUUID(),
          },
          { access: hashToken(randomUUID()), refresh: hashToken(randomUUID()) },
        );
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_account_deletion.fixture_accounts WHERE account_id=$1',
              [peer.accountId],
            )
          ).rowCount,
          0,
        );
      },
    );

    await realSuccessorAbsenceControls(f, t, 174, access, actor.accountId);

    // Each unledgered identity is tested independently. No real epoch authority
    // is installed, and every mutation must roll back before baseline recheck.
    const peerEpochPartials = [
      [
        'account epoch column',
        'ALTER TABLE whaleu_identity.accounts ADD COLUMN session_revocation_epoch bigint NOT NULL DEFAULT 0',
      ],
      [
        'session issued epoch column',
        'ALTER TABLE whaleu_identity.sessions ADD COLUMN issued_revocation_epoch bigint NOT NULL DEFAULT 0',
      ],
      [
        'account epoch constraint',
        'ALTER TABLE whaleu_identity.accounts ADD CONSTRAINT session_epoch_account_nonnegative CHECK(true)',
      ],
      [
        'session issued epoch constraint',
        'ALTER TABLE whaleu_identity.sessions ADD CONSTRAINT session_epoch_issued_nonnegative CHECK(true)',
      ],
      [
        'account epoch trigger',
        'CREATE TRIGGER session_epoch_account BEFORE UPDATE ON whaleu_identity.accounts FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.lifecycle_guard()',
      ],
      [
        'session issued epoch trigger',
        'CREATE TRIGGER session_epoch_issued BEFORE UPDATE ON whaleu_identity.sessions FOR EACH ROW EXECUTE FUNCTION whaleu_account_deletion.lifecycle_guard()',
      ],
      [
        'account epoch guard',
        'CREATE FUNCTION whaleu_identity.session_epoch_account_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$',
      ],
      [
        'session issued epoch guard',
        'CREATE FUNCTION whaleu_identity.session_epoch_issued_guard() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$',
      ],
      [
        'epoch protocol',
        "CREATE FUNCTION whaleu_identity.session_epoch_protocol() RETURNS jsonb LANGUAGE sql AS $$SELECT '{}'::jsonb$$",
      ],
    ] as const;
    for (const [label, statement] of peerEpochPartials)
      await t.test(
        `exact174 peer rejects unledgered0180 ${label}`,
        async () => {
          await assert.rejects(
            f.repository.transaction(async (tx) => {
              await tx.query(statement);
              await inspectHistoricalDeletionPeer174(tx);
            }),
            /Partial or future schema is not an exact 0174 peer boundary/,
          );
          await f.repository.transaction(inspectHistoricalDeletionPeer174);
        },
      );

    const partials = [
      [
        'same-named source column on Identity',
        'ALTER TABLE whaleu_identity.accounts ADD COLUMN text_source_id uuid',
      ],
      [
        'same-named source column on another Ratings relation',
        'ALTER TABLE whaleu_ratings.category_icon_appearances ADD COLUMN text_source_revision uuid',
      ],
      [
        'extra source column on the exact legacy relation',
        'ALTER TABLE whaleu_ratings.category_icon_definitions ADD COLUMN text_source_probe uuid',
      ],
      [
        'new Community source column',
        'ALTER TABLE whaleu_community.posts ADD COLUMN text_source_partial uuid',
      ],
      [
        'legacy source column changed default',
        "ALTER TABLE whaleu_ratings.category_icon_definitions ALTER COLUMN text_source_id SET DEFAULT '00000000-0000-0000-0000-000000000000'::uuid",
      ],
      [
        'legacy source column changed nullability',
        'ALTER TABLE whaleu_ratings.category_icon_definitions ALTER COLUMN text_source_revision SET NOT NULL',
      ],
      [
        'lifecycle layout',
        'ALTER TABLE whaleu_identity.accounts ALTER COLUMN lifecycle DROP NOT NULL',
      ],
      [
        'required deletion relation',
        'ALTER TABLE whaleu_account_deletion.follow_scopes RENAME TO historical_missing_scopes',
      ],
      [
        'registration relation',
        'CREATE TABLE whaleu_identity.registration_guard_partial(n integer)',
      ],
      [
        'registration function',
        "CREATE FUNCTION whaleu_identity.registration_guard_partial() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
      ],
      [
        'registration type',
        "CREATE TYPE whaleu_identity.registration_guard_partial AS ENUM ('closed')",
      ],
      [
        'registration constraint',
        'ALTER TABLE whaleu_identity.sessions ADD CONSTRAINT registration_guard_partial CHECK(true)',
      ],
      [
        'account epoch column',
        'ALTER TABLE whaleu_identity.accounts ADD COLUMN session_revocation_epoch bigint',
      ],
      [
        'session epoch column',
        'ALTER TABLE whaleu_identity.sessions ADD COLUMN issued_revocation_epoch bigint',
      ],
      [
        'session epoch function',
        "CREATE FUNCTION whaleu_identity.session_epoch_partial() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
      ],
      [
        'text-source function',
        "CREATE FUNCTION whaleu_community.text_source_partial() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
      ],
      [
        'text-source renamed predecessor function',
        "CREATE FUNCTION whaleu_community.profile_moderation_definition_pre_text_source() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
      ],
      [
        'Reading relation',
        'CREATE TABLE whaleu_community.reading_format_partial(n integer)',
      ],
      [
        'Home renamed predecessor function',
        "CREATE FUNCTION whaleu_community.profile_moderation_definition_pre_home() RETURNS integer LANGUAGE sql AS 'SELECT 1'",
      ],
      [
        'Home type',
        "CREATE TYPE whaleu_community.home_partial AS ENUM ('closed')",
      ],
    ] as const;
    for (const [label, statement] of partials)
      await t.test(
        `unchanged ledger rejects independently installed ${label}`,
        async () => {
          await assert.rejects(
            f.repository.transaction(async (tx) => {
              await tx.query(statement);
              await f.identity.authenticate(access, tx);
            }),
            denied,
          );
          await schema(f);
          assert.equal(
            (await f.identity.authenticate(access)).accountId,
            actor.accountId,
          );
        },
      );

    for (const trigger of [
      'registration_guard_partial',
      'session_epoch_partial',
      'text_source_partial',
      'reading_late_guard',
      'home_partial',
    ])
      await t.test(
        `lone ${trigger} trigger on non-Community Identity is not absence`,
        async () => {
          await assert.rejects(
            f.repository.transaction(async (tx) => {
              await tx.query(
                `CREATE FUNCTION whaleu_identity.historical_boundary_trigger() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$`,
              );
              await tx.query(
                `CREATE TRIGGER ${trigger} BEFORE UPDATE ON whaleu_identity.accounts FOR EACH ROW EXECUTE FUNCTION whaleu_identity.historical_boundary_trigger()`,
              );
              await f.identity.authenticate(access, tx);
            }),
            denied,
          );
          await schema(f);
        },
      );

    for (const mutation of [
      'DELETE FROM whaleu_meta.schema_migrations WHERE name=(SELECT max(name) FROM whaleu_meta.schema_migrations)',
      "UPDATE whaleu_meta.schema_migrations SET checksum=repeat('0',64) WHERE name=(SELECT max(name) FROM whaleu_meta.schema_migrations)",
      "INSERT INTO whaleu_meta.schema_migrations(name,checksum) VALUES('9999_historical_boundary.sql',repeat('0',64))",
    ])
      await t.test(
        'ledger drift rejects and is rolled back: ' + mutation.split(' ')[0],
        async () => {
          await assert.rejects(
            f.repository.transaction(async (tx) => {
              await tx.query(mutation);
              await f.identity.authenticate(access, tx);
            }),
            denied,
          );
          assert.equal(
            (await f.identity.authenticate(access)).accountId,
            actor.accountId,
          );
        },
      );

    await t.test(
      'supplied repeatable-read transaction is rejected, not silently changed',
      async () => {
        await assert.rejects(
          f.repository.transaction(async (tx) => {
            await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
            await f.identity.authenticate(access, tx);
          }),
          denied,
        );
      },
    );

    await t.test(
      'same-TX schema drift after owner return is rejected by final proof and rolls back writes',
      async () => {
        await assert.rejects(
          f.repository.transaction(async (tx) => {
            assert.equal(
              (await f.identity.authenticate(access, tx)).accountId,
              actor.accountId,
            );
            await tx.query(
              'ALTER TABLE whaleu_identity.accounts ADD COLUMN session_revocation_epoch bigint',
            );
          }),
          denied,
        );
        await schema(f);
        assert.equal(
          (await f.identity.authenticate(access)).accountId,
          actor.accountId,
        );
      },
    );

    await t.test(
      'first + final reuse permits tentative same-TX work but late DDL rolls back business and notification before escape',
      async () => {
        const listener = await f.pool.connect(),
          channel = 'historical_local_' + randomUUID().replaceAll('-', '');
        const notices: string[] = [];
        const notification = (message: Notification) => {
          if (message.channel === channel) notices.push(message.payload ?? '');
        };
        listener.on('notification', notification);
        await listener.query(`LISTEN ${channel}`);
        const original = (
          await f.pool.query(
            'SELECT access_expires_at FROM whaleu_identity.sessions WHERE id=$1',
            [actor.sessionId],
          )
        ).rows[0]!.access_expires_at;
        let intermediate = false,
          escaped = false;
        try {
          await assert.rejects(
            f.repository
              .transaction(async (tx) => {
                await f.identity.activeAccount(actor.accountId, tx);
                await tx.query(
                  "UPDATE whaleu_identity.sessions SET access_expires_at=access_expires_at-interval '1 second' WHERE id=$1",
                  [actor.sessionId],
                );
                await tx.query('SELECT pg_notify($1,$2)', [
                  channel,
                  'tentative-only',
                ]);
                await tx.query(
                  'CREATE TABLE whaleu_identity.session_epoch_late_reuse(n integer)',
                );
                intermediate = await f.identity.activeAccount(
                  actor.accountId,
                  tx,
                );
                // Final validation must inherit this real tighter caller setting.
                await tx.query("SET LOCAL statement_timeout='20ms'");
                assert.equal(
                  (
                    await tx.query(
                      "SELECT current_setting('statement_timeout') value",
                    )
                  ).rows[0]!.value,
                  '20ms',
                );
                return 'must not escape';
              })
              .then(() => {
                escaped = true;
              }),
            denied,
          );
          assert.equal(intermediate, true);
          assert.equal(escaped, false);
          assert.deepEqual(
            (
              await f.pool.query(
                'SELECT access_expires_at FROM whaleu_identity.sessions WHERE id=$1',
                [actor.sessionId],
              )
            ).rows[0]!.access_expires_at,
            original,
          );
          assert.equal(
            (
              await f.pool.query(
                "SELECT to_regclass('whaleu_identity.session_epoch_late_reuse') object",
              )
            ).rows[0]!.object,
            null,
          );
          await listener.query('SELECT 1');
          assert.deepEqual(notices, []);
        } finally {
          await listener.query(`UNLISTEN ${channel}`);
          listener.off('notification', notification);
          listener.release();
        }
      },
    );

    await t.test(
      'real savepoint restoration removes first proof/locks and forces fresh admission',
      async () => {
        await f.repository.transaction(async (tx) => {
          const backend = await pid(tx),
            checkpoint = checkpointTransactionDeadlines(tx);
          await tx.query('SAVEPOINT cached_owner');
          await f.identity.activeAccount(actor.accountId, tx);
          assert.equal(await sharedFence(f, backend), true);
          await tx.query('ROLLBACK TO SAVEPOINT cached_owner');
          restoreTransactionDeadlines(tx, checkpoint);
          assert.equal(await sharedFence(f, backend), false);
          await f.identity.activeAccount(actor.accountId, tx);
          assert.equal(await sharedFence(f, backend), true);
        });
        let returned = false;
        await assert.rejects(
          f.repository.transaction(async (tx) => {
            const checkpoint = checkpointTransactionDeadlines(tx);
            await tx.query('SAVEPOINT cached_owner');
            await f.identity.activeAccount(actor.accountId, tx);
            await tx.query('ROLLBACK TO SAVEPOINT cached_owner');
            restoreTransactionDeadlines(tx, checkpoint);
            await tx.query(
              'CREATE TABLE whaleu_identity.home_after_restore(n integer)',
            );
            await f.identity.activeAccount(actor.accountId, tx);
            returned = true;
          }),
          denied,
        );
        assert.equal(returned, false);
        await schema(f);
      },
    );

    await t.test(
      'the same actual PostgreSQL client starts a new lifetime and cannot reuse earlier admission',
      async () => {
        const client = await f.pool.connect();
        const owned = new Proxy(client, {
          get(target, key) {
            if (key === 'release') return () => {};
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        const pool = { connect: async () => owned } as unknown as Pick<
          Pool,
          'connect'
        >;
        try {
          let firstPid = 0;
          await inTransaction(
            pool,
            async (tx) => {
              firstPid = await pid(tx);
              await f.identity.activeAccount(actor.accountId, tx);
            },
            { isolationLevel: 'read committed' },
          );
          assert.equal(await sharedFence(f, firstPid), false);
          let returned = false;
          await assert.rejects(
            inTransaction(
              pool,
              async (tx) => {
                assert.equal(await pid(tx), firstPid);
                await tx.query(
                  'CREATE TABLE whaleu_identity.reading_next_transaction(n integer)',
                );
                await f.identity.activeAccount(actor.accountId, tx);
                returned = true;
              },
              { isolationLevel: 'read committed' },
            ),
            denied,
          );
          assert.equal(returned, false);
          await schema(f);
        } finally {
          client.release();
        }
      },
    );

    await t.test(
      'real final 20 ms statement timeout remains mandatory under explicit final-query fault injection',
      async () => {
        // This is a deliberate test-only latency fault, NOT the normal schema
        // query's performance result. Keep the full original SQL as a subquery;
        // MATERIALIZED and CROSS JOIN require the real pg_sleep to execute.
        const client = await f.pool.connect(),
          statements: string[] = [],
          timeouts: unknown[] = [];
        let final = false,
          injections = 0,
          sqlstate: unknown,
          escaped = false;
        const owned = new Proxy(client, {
          get(target, key) {
            if (key === 'release') return () => {};
            if (key === 'query')
              return async (sql: string, values?: unknown[]) => {
                statements.push(sql);
                if (sql.startsWith("SELECT set_config('statement_timeout'"))
                  timeouts.push(values?.[0]);
                if (final && sql === historicalDeletionSchemaSql) {
                  injections++;
                  try {
                    return await target.query(
                      `WITH forced_final_latency AS MATERIALIZED (SELECT pg_sleep(0.08)) SELECT boundary.* FROM (${sql}) boundary CROSS JOIN forced_final_latency`,
                      values,
                    );
                  } catch (error) {
                    sqlstate = (error as { code?: string }).code;
                    throw error;
                  }
                }
                return target.query(sql, values);
              };
            const value = Reflect.get(target, key);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
        const pool = { connect: async () => owned } as unknown as Pick<
          Pool,
          'connect'
        >;
        try {
          await assert.rejects(
            inTransaction(
              pool,
              async (tx) => {
                await f.identity.activeAccount(actor.accountId, tx);
                assert.equal(
                  injections,
                  0,
                  'first proof uses unmodified normal SQL',
                );
                await tx.query("SET LOCAL statement_timeout='20ms'");
                assert.equal(
                  (
                    await tx.query(
                      "SELECT current_setting('statement_timeout') value",
                    )
                  ).rows[0]!.value,
                  '20ms',
                );
                final = true;
                return 'must not escape';
              },
              { isolationLevel: 'read committed' },
            ).then(() => {
              escaped = true;
            }),
            denied,
          );
          assert.equal(injections, 1);
          assert.equal(sqlstate, '57014');
          assert.equal(escaped, false);
          assert.equal(timeouts.at(-1), '20ms');
          assert.ok(statements.includes('SET CONSTRAINTS ALL IMMEDIATE'));
          assert.ok(
            statements.lastIndexOf(historicalDeletionSchemaSql) >
              statements.indexOf('SET CONSTRAINTS ALL IMMEDIATE'),
          );
          assert.equal(statements.at(-1), 'ROLLBACK');
          assert.ok(!statements.includes('COMMIT'));
        } finally {
          client.release();
        }
        // A fresh ordinary call must still work after the aborted diagnostic TX.
        assert.equal(
          (await f.identity.authenticate(access)).accountId,
          actor.accountId,
        );
      },
    );

    await t.test(
      'actual migration lock and account/session/ledger DDL held elsewhere fail closed then recover',
      async () => {
        const blocker = await f.pool.connect();
        try {
          await blocker.query('SELECT pg_advisory_lock($1,$2)', [
            ...MIGRATION_LOCK,
          ]);
          try {
            await assert.rejects(f.identity.authenticate(access), denied);
          } finally {
            await blocker.query('SELECT pg_advisory_unlock($1,$2)', [
              ...MIGRATION_LOCK,
            ]);
          }
          assert.equal(
            (await f.identity.authenticate(access)).accountId,
            actor.accountId,
          );
          for (const relation of [
            'whaleu_identity.accounts',
            'whaleu_identity.sessions',
            'whaleu_meta.schema_migrations',
          ]) {
            await blocker.query('BEGIN');
            try {
              await blocker.query(
                `LOCK TABLE ${relation} IN ACCESS EXCLUSIVE MODE NOWAIT`,
              );
              await assert.rejects(f.identity.authenticate(access), denied);
            } finally {
              await blocker.query('ROLLBACK');
            }
            assert.equal(
              (await f.identity.authenticate(access)).accountId,
              actor.accountId,
            );
          }
        } finally {
          blocker.release();
        }
      },
    );

    for (const relation of [
      'whaleu_identity.accounts',
      'whaleu_identity.sessions',
      'whaleu_meta.schema_migrations',
    ])
      await t.test(
        `held owner TX excludes real migration runner and observed ${relation} DDL until commit`,
        async () => {
          const ready = signal(),
            release = signal();
          let backend = 0;
          const held = f.repository.transaction(async (tx) => {
            backend = await pid(tx);
            assert.equal(
              await f.identity.activeAccount(actor.accountId, tx),
              true,
            );
            ready.resolve();
            await release.promise;
          });
          void held.catch(() => {});
          const ddl = await f.pool.connect();
          let ddlTask: Promise<unknown> | undefined;
          try {
            await Promise.race([ready.promise, held]);
            assert.equal(await sharedFence(f, backend), true);
            // This is the REAL runner and the same actual lock keys, not a private
            // test fence. Its observed refusal is independent of elapsed sleep.
            await assert.rejects(
              runMigrations(f.pool, migrations, {
                mode: 'status',
                lockTimeoutMs: 50,
              }),
              /Timed out waiting for the migration lock/,
            );
            // ACCESS SHARE fences still allow unrelated normal account/session DML.
            await f.pool.query(
              'UPDATE whaleu_identity.accounts SET status=status WHERE id=$1',
              [other.accountId],
            );
            await f.pool.query(
              'UPDATE whaleu_identity.sessions SET access_expires_at=access_expires_at WHERE id=$1',
              [other.sessionId],
            );
            await ddl.query('BEGIN');
            await ddl.query("SET LOCAL lock_timeout='15000ms'");
            const ddlPid = await pid(ddl);
            ddlTask = ddl.query(
              `ALTER TABLE ${relation} ADD COLUMN historical_boundary_probe integer`,
            );
            void ddlTask.catch(() => {});
            await observed(
              async () =>
                (
                  await f.pool.query<{ waiting: boolean }>(
                    `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND relation=$2::regclass AND mode='AccessExclusiveLock' AND NOT granted) waiting`,
                    [ddlPid, relation],
                  )
                ).rows[0]!.waiting,
              'DDL did not enter a real PostgreSQL lock wait',
            );
            release.resolve();
            await held;
            await ddlTask;
            await ddl.query('ROLLBACK');
            assert.equal(await sharedFence(f, backend), false);
            await runMigrations(f.pool, migrations, {
              mode: 'status',
              lockTimeoutMs: 1000,
            });
            assert.equal(
              (await f.identity.authenticate(access)).accountId,
              actor.accountId,
            );
          } finally {
            release.resolve();
            await held.catch(() => {});
            await ddlTask?.catch(() => {});
            await ddl.query('ROLLBACK');
            ddl.release();
          }
        },
      );

    await t.test(
      'savepoint-released schema fence must be reacquired by final required proof',
      async () => {
        const ready = signal(),
          release = signal();
        let backend = 0;
        const held = f.repository.transaction(async (tx) => {
          backend = await pid(tx);
          await tx.query('SAVEPOINT owner_read');
          await f.identity.authenticate(access, tx);
          assert.equal(await sharedFence(f, backend), true);
          await tx.query('ROLLBACK TO SAVEPOINT owner_read');
          // Retain the read/result and its mandatory fact, just as a retained
          // negative result can outlive work rollback. Do not prune its proof.
          assert.equal(await sharedFence(f, backend), false);
          ready.resolve();
          await release.promise;
        });
        void held.catch(() => {});
        const blocker = await f.pool.connect();
        let locked = false;
        try {
          await Promise.race([ready.promise, held]);
          locked = (
            await blocker.query<{ locked: boolean }>(
              'SELECT pg_try_advisory_lock($1,$2) locked',
              [...MIGRATION_LOCK],
            )
          ).rows[0]!.locked;
          assert.equal(
            locked,
            true,
            'Rollback actually released the earlier schema fence',
          );
          release.resolve();
          await assert.rejects(held, denied);
        } finally {
          release.resolve();
          await held.catch(() => {});
          if (locked)
            await blocker.query('SELECT pg_advisory_unlock($1,$2)', [
              ...MIGRATION_LOCK,
            ]);
          blocker.release();
        }
        assert.equal(
          (await f.identity.authenticate(access)).accountId,
          actor.accountId,
        );
      },
    );

    await t.test(
      'real deferred constraint wait finishes before final schema validation rejects drift',
      async () => {
        const blocker = await f.pool.connect(),
          key = [MIGRATION_LOCK[0], 91];
        let backend = 0;
        await blocker.query('SELECT pg_advisory_lock($1,$2)', key);
        let held: Promise<unknown> | undefined;
        try {
          held = f.repository.transaction(async (tx) => {
            backend = await pid(tx);
            await f.identity.authenticate(access, tx);
            await tx.query(
              'CREATE TEMP TABLE historical_boundary_deferred(n integer) ON COMMIT DROP',
            );
            await tx.query(`CREATE FUNCTION pg_temp.historical_boundary_wait() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN
          PERFORM pg_advisory_xact_lock(${key[0]},${key[1]});
          CREATE TABLE whaleu_identity.session_epoch_deferred_probe(n integer);
          RETURN NEW;
        END$$`);
            await tx.query(
              'CREATE CONSTRAINT TRIGGER historical_boundary_wait AFTER INSERT ON pg_temp.historical_boundary_deferred DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pg_temp.historical_boundary_wait()',
            );
            await tx.query(
              'INSERT INTO pg_temp.historical_boundary_deferred VALUES(1)',
            );
          });
          void held.catch(() => {});
          await observed(
            async () =>
              backend !== 0 &&
              (
                await f.pool.query<{ waiting: boolean }>(
                  `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND classid=$2::oid AND objid=$3::oid AND NOT granted) waiting`,
                  [backend, ...key],
                )
              ).rows[0]!.waiting,
            'Deferred constraint did not enter its actual advisory wait',
          );
          await blocker.query('SELECT pg_advisory_unlock($1,$2)', key);
          await assert.rejects(held, denied);
          assert.equal(
            (
              await f.pool.query<{ relation: string | null }>(
                "SELECT to_regclass('whaleu_identity.session_epoch_deferred_probe')::text relation",
              )
            ).rows[0]!.relation,
            null,
          );
          await schema(f);
          assert.equal(
            (await f.identity.authenticate(access)).accountId,
            actor.accountId,
          );
        } finally {
          await blocker.query('SELECT pg_advisory_unlock($1,$2)', key);
          await held?.catch(() => {});
          blocker.release();
        }
      },
    );

    assert.deepEqual(
      await seals(f),
      before,
      'No acceptance check rewrites historical inventory',
    );
  },
);
