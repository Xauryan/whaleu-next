import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { inTransaction } from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { captureCountProof } from '../../src/community/count-proof.js';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
  checkTransactionDeadlines,
  registerOptionalTransactionProof,
  registerTransactionDeadline,
} from '../../src/database/transaction-deadlines.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

const namespaces = {
  community: 1464356101,
  safety: 1464356102,
  campus: 1464356103,
} as const;
const sqlCode = (code: string) => (error: unknown) =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  error.code === code;
const owners = ['community', 'safety', 'campus'] as const;

test(
  'exact count fixed epochs, writer ordering and final transaction proof',
  { timeout: 120000 },
  async (t) => {
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(database, 'Use the isolated disposable loopback whaleu_test');
    const url = new URL(database);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const pool = new Pool({
      connectionString: database,
      max: 12,
      statement_timeout: 3000,
    });
    let suite: PoolClient | undefined,
      owns = false,
      locked = false;
    const tx = <T>(work: (client: PoolClient) => Promise<T>) =>
      inTransaction(pool, work, { isolationLevel: 'read committed' });
    const epoch = async (
      owner: (typeof owners)[number],
      client: Pick<PoolClient, 'query'> = pool,
    ) =>
      (
        await client.query<{ total: string }>(
          `SELECT sum(epoch)::text total FROM whaleu_${owner}.discovery_count_epochs`,
        )
      ).rows[0]!.total;
    const slotLocks = async (client: PoolClient, namespace: number) =>
      (
        await client.query<{ n: number }>(
          `SELECT count(*)::integer n FROM pg_locks WHERE pid=pg_backend_pid()
      AND locktype='advisory' AND classid=$1::oid AND objsubid=2`,
          [namespace],
        )
      ).rows[0]!.n;
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert.equal(locked, true);
      assert.equal(
        (
          await pool.query<{ n: number }>(
            "SELECT count(*)::integer n FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
          )
        ).rows[0]!.n,
        0,
      );
      owns = true;
      const migrations = await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      );
      assert.equal(
        migrations.filter(
          (migration) =>
            migration.name === '0021_exact_discovery_count_proofs.sql',
        ).length,
        1,
        'The count-proof migration must be present; later feature migrations also run',
      );
      await runMigrations(pool, migrations, { mode: 'up' });
      await runMigrations(pool, migrations, { mode: 'up' });

      await t.test(
        'fixed128 owner metadata, guarded reset and complete direct SQL statement coverage',
        async () => {
          for (const owner of owners) {
            const rows = (
              await pool.query(
                `SELECT slot,version,epoch::text FROM whaleu_${owner}.discovery_count_epochs ORDER BY slot`,
              )
            ).rows;
            assert.equal(rows.length, 128);
            assert.deepEqual(
              rows.map((row) => row.slot),
              Array.from({ length: 128 }, (_, i) => i),
            );
            for (const sql of [
              `UPDATE whaleu_${owner}.discovery_count_epochs SET epoch=epoch+1 WHERE slot=0`,
              `DELETE FROM whaleu_${owner}.discovery_count_epochs WHERE slot=0`,
              `TRUNCATE whaleu_${owner}.discovery_count_epochs`,
              `INSERT INTO whaleu_${owner}.discovery_count_epochs VALUES(0,1,0)`,
            ])
              await assert.rejects(pool.query(sql), sqlCode('23514'));
          }
          const tables = (
            await pool.query<{
              schema: string;
              table: string;
              column: string;
            }>(`
        SELECT n.nspname schema,c.relname "table",a.attname "column"
        FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=1
        WHERE t.tgname='a_discovery_count_epoch' ORDER BY n.nspname,c.relname`)
          ).rows;
          assert.equal(tables.length, 23);
          for (const table of tables) {
            const owner = table.schema.replace(
              'whaleu_',
              '',
            ) as (typeof owners)[number];
            const before = BigInt(await epoch(owner));
            await pool.query(
              `UPDATE ${table.schema}.${table.table} SET ${table.column}=${table.column} WHERE false`,
            );
            assert.equal(BigInt(await epoch(owner)), before + 1n, table.table);
          }
        },
      );

      await t.test(
        'source/epoch rollback and savepoint rollback release claimed writer slots',
        async () => {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const before = await epoch('community', client);
            await client.query('SAVEPOINT source_write');
            await client.query(
              "INSERT INTO whaleu_community.spaces VALUES($1,'global',NULL,'test',true)",
              [randomUUID()],
            );
            assert.equal(
              BigInt(await epoch('community', client)),
              BigInt(before) + 1n,
            );
            assert.equal(await slotLocks(client, namespaces.community), 1);
            await client.query('ROLLBACK TO SAVEPOINT source_write');
            assert.equal(await epoch('community', client), before);
            assert.equal(await slotLocks(client, namespaces.community), 0);
          } finally {
            await client.query('ROLLBACK');
            client.release();
          }
        },
      );

      await t.test(
        'all target statements reuse one exclusive slot without history-sized locks',
        async () => {
          await tx(async (client) => {
            const before = BigInt(await epoch('community', client));
            for (let i = 0; i < 80; i++)
              await client.query(
                "INSERT INTO whaleu_community.spaces VALUES($1,'global',NULL,'test',true)",
                [randomUUID()],
              );
            assert.equal(
              BigInt(await epoch('community', client)),
              before + 80n,
            );
            assert.equal(await slotLocks(client, namespaces.community), 1);
          });
        },
      );

      await t.test(
        'empty scan first insert and committed mutation invalidate a durable proof',
        async () => {
          const result = await tx(async (client) => {
            const proof = await captureCountProof(client);
            assert.ok(proof);
            const result = { value: 0 as number | null };
            await pool.query(
              "INSERT INTO whaleu_community.spaces VALUES($1,'global',NULL,'new',true)",
              [randomUUID()],
            );
            registerOptionalTransactionProof(client, {
              validate: () => proof.validate(client),
              invalidate: () => {
                result.value = null;
              },
            });
            return result;
          });
          assert.equal(result.value, null);
        },
      );

      await t.test(
        'writer beginning before capture retains fence even after session advisory unlock',
        async () => {
          const writer = await pool.connect();
          try {
            await writer.query('SELECT pg_advisory_lock($1,0)', [
              namespaces.community,
            ]);
            await writer.query('BEGIN');
            await writer.query(
              "INSERT INTO whaleu_community.spaces VALUES($1,'global',NULL,'uncommitted',true)",
              [randomUUID()],
            );
            await writer.query('SELECT pg_advisory_unlock($1,0)', [
              namespaces.community,
            ]);
            const result = await tx(async (client) => {
              const proof = await captureCountProof(client);
              assert.ok(proof);
              const result = { value: 1 as number | null };
              registerOptionalTransactionProof(client, {
                validate: () => proof.validate(client),
                invalidate: () => {
                  result.value = null;
                },
              });
              return result;
            });
            assert.equal(result.value, null);
          } finally {
            await writer.query('ROLLBACK');
            await writer.query('SELECT pg_advisory_unlock_all()');
            writer.release();
          }
        },
      );

      await t.test(
        'partial owner fence failure releases acquired earlier-owner locks',
        async () => {
          const writer = await pool.connect(),
            reader = await pool.connect();
          try {
            await writer.query('BEGIN');
            await writer.query(
              'UPDATE whaleu_safety.account_heads SET actions_allowed=actions_allowed WHERE false',
            );
            await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED');
            startTransactionDeadlines(reader);
            const proof = await captureCountProof(reader);
            assert.ok(proof);
            let invalidated = false;
            registerOptionalTransactionProof(reader, {
              validate: () => proof.validate(reader),
              invalidate: () => {
                invalidated = true;
              },
            });
            await checkTransactionDeadlines(reader);
            assert.equal(invalidated, true);
            for (const owner of owners)
              assert.equal(await slotLocks(reader, namespaces[owner]), 0);
          } finally {
            clearTransactionDeadlines(reader);
            await reader.query('ROLLBACK');
            await writer.query('ROLLBACK');
            reader.release();
            writer.release();
          }
        },
      );

      await t.test(
        'successful final fences make a new writer wait only until reader commit',
        async () => {
          const writer = await pool.connect();
          let mutation: Promise<unknown> | undefined;
          try {
            const pid = (
              await writer.query<{ pid: number }>('SELECT pg_backend_pid() pid')
            ).rows[0]!.pid;
            await tx(async (client) => {
              const proof = await captureCountProof(client);
              assert.ok(proof);
              registerOptionalTransactionProof(client, {
                validate: async () => {
                  assert.equal(await proof.validate(client), true);
                  for (const owner of owners)
                    assert.equal(
                      await slotLocks(client, namespaces[owner]),
                      129,
                    );
                  mutation = writer.query(
                    "INSERT INTO whaleu_community.spaces VALUES($1,'global',NULL,'fenced',true)",
                    [randomUUID()],
                  );
                  let waiting = false;
                  for (let attempt = 0; attempt < 100; attempt++) {
                    waiting =
                      (
                        await pool.query<{ waiting: boolean }>(
                          "SELECT wait_event='advisory' waiting FROM pg_stat_activity WHERE pid=$1",
                          [pid],
                        )
                      ).rows[0]?.waiting === true;
                    if (waiting) break;
                    await sleep(2);
                  }
                  assert.equal(waiting, true);
                  return true;
                },
                invalidate: () =>
                  assert.fail('Unchanged final-fenced proof should survive'),
              });
            });
            await mutation;
          } finally {
            await mutation;
            writer.release();
          }
        },
      );

      await t.test(
        '65 simultaneous real post writers retain progress and invalidate only a count',
        async () => {
          const writers = new Pool({
            connectionString: database,
            max: 70,
            statement_timeout: 3000,
          });
          const clients: PoolClient[] = [];
          const account = randomUUID(),
            space = randomUUID();
          await pool.query(
            'INSERT INTO whaleu_identity.accounts(id) VALUES($1)',
            [account],
          );
          await pool.query(
            "INSERT INTO whaleu_community.spaces VALUES($1,'global',NULL,'many writers',true)",
            [space],
          );
          let invalidated = false;
          try {
            await tx(async (reader) => {
              const proof = await captureCountProof(reader);
              assert.ok(proof);
              for (let i = 0; i < 65; i++) {
                const writer = await writers.connect();
                clients.push(writer);
                await writer.query('BEGIN');
                await writer.query(
                  `INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy)
                VALUES($1,$2,$3,'discussion','writer proof','named','open')`,
                  [randomUUID(), space, account],
                );
                assert.equal(await slotLocks(writer, namespaces.community), 1);
              }
              // The extra65th source mutation and epoch commit normally, while the
              // first64 retain actual exclusive slots. No optional-count cap leak.
              await clients[64]!.query('COMMIT');
              registerOptionalTransactionProof(reader, {
                validate: () => proof.validate(reader),
                invalidate: () => {
                  invalidated = true;
                },
              });
            });
            assert.equal(invalidated, true);
            assert.equal(
              (
                await pool.query<{ n: number }>(
                  'SELECT count(*)::integer n FROM whaleu_community.posts WHERE account_id=$1',
                  [account],
                )
              ).rows[0]!.n,
              1,
            );
          } finally {
            for (const writer of clients) {
              await writer.query('ROLLBACK');
              writer.release();
            }
            await writers.end();
          }
        },
      );

      await t.test(
        'raw head expiry/provenance, space activity and region activity invalidate',
        async () => {
          const account = randomUUID(),
            space = randomUUID(),
            region = randomUUID();
          await pool.query(
            'INSERT INTO whaleu_identity.accounts(id) VALUES($1)',
            [account],
          );
          await pool.query(
            "INSERT INTO whaleu_safety.account_heads(account_id,block_coverage,restriction_coverage,provenance,actions_allowed) VALUES($1,'complete','complete','native_account_creation',true)",
            [account],
          );
          await pool.query(
            "INSERT INTO whaleu_community.spaces VALUES($1,'global',NULL,'scope',true)",
            [space],
          );
          await pool.query(
            "INSERT INTO whaleu_campus.operating_regions VALUES($1,'region',true)",
            [region],
          );
          for (const [sql, id] of [
            [
              'UPDATE whaleu_safety.account_heads SET valid_until=clock_timestamp() WHERE account_id=$1',
              account,
            ],
            [
              "UPDATE whaleu_safety.account_heads SET block_coverage='missing',restriction_coverage='missing',provenance='unknown' WHERE account_id=$1",
              account,
            ],
            [
              'UPDATE whaleu_community.spaces SET is_active=false WHERE id=$1',
              space,
            ],
            [
              'UPDATE whaleu_campus.operating_regions SET is_active=false WHERE id=$1',
              region,
            ],
          ] as const) {
            let invalidated = false;
            await tx(async (client) => {
              const proof = await captureCountProof(client);
              assert.ok(proof);
              await pool.query(sql, [id]);
              registerOptionalTransactionProof(client, {
                validate: () => proof.validate(client),
                invalidate: () => {
                  invalidated = true;
                },
              });
            });
            assert.equal(invalidated, true, sql);
          }
        },
      );

      await t.test(
        'deferred constraint waits precede every final fence and final authority clock',
        async () => {
          for (const mandatory of [false, true]) {
            const blocker = await pool.connect(),
              reader = await pool.connect();
            let invalidated = false;
            try {
              await reader.query(`CREATE TEMP TABLE proof_wait(id integer);
              CREATE OR REPLACE FUNCTION pg_temp.proof_wait() RETURNS trigger LANGUAGE plpgsql AS $$
              BEGIN PERFORM pg_advisory_xact_lock(1464356104,1); RETURN NEW; END $$;
              CREATE CONSTRAINT TRIGGER proof_wait AFTER INSERT ON proof_wait
              DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pg_temp.proof_wait()`);
              await blocker.query('BEGIN');
              await blocker.query('SELECT pg_advisory_xact_lock(1464356104,1)');
              await reader.query('BEGIN ISOLATION LEVEL READ COMMITTED');
              startTransactionDeadlines(reader);
              const proof = await captureCountProof(reader);
              assert.ok(proof);
              const until = (
                await reader.query<{ until: Date }>(
                  "SELECT clock_timestamp()+interval '100 milliseconds' AS until",
                )
              ).rows[0]!.until.getTime();
              if (mandatory)
                registerTransactionDeadline(
                  reader,
                  until,
                  'ACCESS_TOKEN_EXPIRED',
                );
              registerOptionalTransactionProof(reader, {
                validate: () => proof.validate(reader),
                until,
                invalidate: () => {
                  invalidated = true;
                },
              });
              await reader.query('INSERT INTO proof_wait VALUES(1)');
              const pid = (
                await reader.query<{ pid: number }>(
                  'SELECT pg_backend_pid() pid',
                )
              ).rows[0]!.pid;
              const finish = checkTransactionDeadlines(reader);
              const checked = mandatory
                ? assert.rejects(
                    finish,
                    (error) =>
                      error instanceof ApplicationError &&
                      error.code === 'ACCESS_TOKEN_EXPIRED',
                  )
                : finish;
              let waiting = false;
              for (let attempt = 0; attempt < 100; attempt++) {
                waiting =
                  (
                    await pool.query<{ waiting: boolean }>(
                      "SELECT wait_event='advisory' waiting FROM pg_stat_activity WHERE pid=$1",
                      [pid],
                    )
                  ).rows[0]?.waiting === true;
                if (waiting) break;
                await sleep(5);
              }
              assert.equal(
                waiting,
                true,
                'Deterministic deferred-constraint barrier',
              );
              const countLocks = (
                await pool.query<{ n: number }>(
                  `SELECT count(*)::integer n FROM pg_locks WHERE pid=$1 AND locktype='advisory'
              AND classid=ANY($2::oid[])`,
                  [pid, Object.values(namespaces)],
                )
              ).rows[0]!.n;
              assert.equal(
                countLocks,
                0,
                'No final count fence before deferred constraint finishes',
              );
              await pool.query(
                'SELECT pg_sleep_until(to_timestamp($1::double precision/1000))',
                [until + 2],
              );
              await blocker.query('COMMIT');
              await checked;
              assert.equal(
                invalidated,
                !mandatory,
                'Mandatory expiry wins over optional invalidation',
              );
            } finally {
              clearTransactionDeadlines(reader);
              await blocker.query('ROLLBACK');
              await reader.query('ROLLBACK');
              await reader.query('DROP TABLE IF EXISTS pg_temp.proof_wait');
              blocker.release();
              reader.release();
            }
          }
        },
      );

      await t.test(
        'explicit mode survives a REPEATABLE READ server default; unproven mode rejects',
        async () => {
          const custom = new Pool({ connectionString: database, max: 1 });
          try {
            await custom.query(
              "SET default_transaction_isolation='repeatable read'",
            );
            await assert.rejects(
              inTransaction(custom, async (client) =>
                captureCountProof(client),
              ),
              (error) =>
                error instanceof ApplicationError &&
                error.code === 'COMMUNITY_UNAVAILABLE',
            );
            await inTransaction(
              custom,
              async (client) => {
                const proof = await captureCountProof(client);
                assert.ok(proof);
                registerOptionalTransactionProof(client, {
                  validate: () => proof.validate(client),
                  invalidate: () => assert.fail('explicit RC proof'),
                });
              },
              { isolationLevel: 'read committed' },
            );
          } finally {
            await custom.end();
          }
        },
      );
    } finally {
      try {
        if (owns)
          for (const schema of migrationSchemaNames)
            await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        if (locked)
          await suite?.query('SELECT pg_advisory_unlock($1,$2)', [
            MIGRATION_LOCK[0],
            2,
          ]);
        suite?.release();
        await pool.end();
      }
    }
  },
);
