import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import type { PoolClient, QueryResult } from 'pg';
import { campusCountProofOwner } from '../../src/campus/count-epochs.js';
import { CountProofCollector } from '../../src/database/count-proof.js';
import { inTransaction } from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { requiredOwnerEpoch } from '../../src/database/required-owner-proof.js';
import {
  checkTransactionDeadlines,
  clearTransactionDeadlines,
  registerOptionalTransactionProof,
  startTransactionDeadlines,
} from '../../src/database/transaction-deadlines.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { safetyCountProofOwner } from '../../src/safety/count-epochs.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

const owners = [
  {
    name: 'safety',
    owner: safetyCountProofOwner,
    code: 'SAFETY_UNAVAILABLE',
    table: 'whaleu_safety.account_heads',
    key: 'account_id',
    flag: 'actions_allowed',
    zeroRowSources: [
      ['account_heads', 'account_id'],
      ['blocks', 'id'],
    ],
  },
  {
    name: 'campus',
    owner: campusCountProofOwner,
    code: 'IDENTITY_CAMPUS_UNAVAILABLE',
    table: 'whaleu_campus.operating_regions',
    key: 'id',
    flag: 'is_active',
    zeroRowSources: [
      ['operating_regions', 'id'],
      ['institutions', 'id'],
      ['campuses', 'id'],
      ['campus_region_assignments', 'campus_id'],
      ['community_topology_heads', 'scope_key'],
      ['community_topology_snapshots', 'id'],
      ['community_identity_heads', 'account_id'],
      ['community_identity_selections', 'id'],
    ],
  },
] as const;
const errorIs = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
const sqlCode = (code: string) => (error: unknown) =>
  error !== null &&
  typeof error === 'object' &&
  'code' in error &&
  error.code === code;

test(
  'Safety and Campus final epoch fences admit concurrent readers and preserve original writers',
  { timeout: 120000 },
  async (t) => {
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(database, 'Use the isolated disposable loopback whaleu_test');
    const url = new URL(database);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const pool = new Pool({
      connectionString: database,
      max: 8,
      statement_timeout: 3000,
    });
    let suite: PoolClient | undefined,
      owns = false,
      locked = false;
    const begin = async (client: PoolClient) => {
      await client.query('BEGIN ISOLATION LEVEL READ COMMITTED');
      startTransactionDeadlines(client);
    };
    const release = async (client: PoolClient) => {
      clearTransactionDeadlines(client);
      await client.query('ROLLBACK');
      client.release();
    };
    const pidOf = async (client: PoolClient) =>
      (await client.query<{ pid: number }>('SELECT pg_backend_pid() pid'))
        .rows[0]!.pid;
    const transaction = <T>(run: (client: PoolClient) => Promise<T>) =>
      inTransaction(pool, run, { isolationLevel: 'read committed' });
    // A positive pg_locks observation is the barrier. Polling merely waits for
    // that state; elapsed time or an unresolved promise never proves ordering.
    const waitFor = async (
      condition: () => Promise<boolean>,
      label: string,
    ) => {
      const expires = performance.now() + 2000;
      while (performance.now() < expires) {
        if (await condition()) return;
        await sleep(2);
      }
      assert.fail(label);
    };
    const epochLock = async (
      pid: number,
      table: string,
      mode: string,
      granted: boolean,
    ) =>
      (
        await pool.query<{ held: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1
         AND locktype='relation' AND relation=$2::regclass
         AND mode=$3 AND granted=$4) held`,
          [pid, table, mode, granted],
        )
      ).rows[0]!.held;
    const advisoryLocks = async (pid: number, namespace: number) =>
      (
        await pool.query<{ slot: number; mode: string; granted: boolean }>(
          `SELECT objid::integer slot,mode,granted FROM pg_locks
         WHERE pid=$1 AND locktype='advisory' AND classid=$2::oid AND objsubid=2
         ORDER BY objid,mode`,
          [pid, namespace],
        )
      ).rows;
    // Observe failures immediately so a deliberately blocked query never creates
    // an unhandled rejection while the inspection connection checks lock state.
    const launch = (client: PoolClient, sql: string, values: unknown[]) =>
      client.query(sql, values).then(
        (result) => ({ result, error: undefined }),
        (error: unknown) => ({ result: undefined, error }),
      );
    const completed = async (
      pending: Promise<{
        result: QueryResult | undefined;
        error: unknown;
      }>,
    ) => {
      const outcome = await pending;
      if (outcome.error) throw outcome.error;
      assert.ok(outcome.result);
      return outcome.result;
    };
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
      await runMigrations(
        pool,
        await readMigrations(
          fileURLToPath(new URL('../../migrations', import.meta.url)),
        ),
        { mode: 'up' },
      );
      const capacity = (
        await pool.query<{ n: number }>(
          `SELECT current_setting('max_connections')::integer +
         current_setting('max_prepared_transactions')::integer +
         current_setting('max_worker_processes')::integer +
         current_setting('max_wal_senders')::integer n`,
        )
      ).rows[0]!.n;
      assert.ok(capacity > 0 && capacity < 128, 'Fixed128 writer admission');

      for (const spec of owners) {
        const table = `whaleu_${spec.name}.discovery_count_epochs`,
          namespace = spec.owner.order,
          captureRequired = requiredOwnerEpoch(spec.owner, spec.code);
        const captureOptional = async (client: PoolClient) => {
          const proof = await CountProofCollector.capture(client, [spec.owner]);
          assert.ok(proof);
          return proof;
        };
        const epochs = (client: PoolClient) => spec.owner.capture(client);
        const total = async (client: PoolClient) =>
          (await epochs(client)).reduce((n, row) => n + BigInt(row.epoch), 0n);
        const seed = async () => {
          const id = randomUUID();
          if (spec.name === 'safety') {
            await pool.query(
              'INSERT INTO whaleu_identity.accounts(id) VALUES($1)',
              [id],
            );
            await pool.query(
              `INSERT INTO whaleu_safety.account_heads
             (account_id,block_coverage,restriction_coverage,provenance,actions_allowed)
             VALUES($1,'complete','complete','native_account_creation',true)`,
              [id],
            );
          } else {
            await pool.query(
              "INSERT INTO whaleu_campus.operating_regions VALUES($1,'Reader fence fixture',true)",
              [id],
            );
          }
          return id;
        };
        const mutation = `UPDATE ${spec.table} SET ${spec.flag}=false WHERE ${spec.key}=$1`,
          zero = `UPDATE ${spec.table} SET ${spec.flag}=${spec.flag} WHERE false`;

        await t.test(
          `${spec.name}: two registered final readers hold compatible fences`,
          async () => {
            const first = await pool.connect(),
              second = await pool.connect();
            try {
              await begin(first);
              await begin(second);
              for (const client of [first, second]) {
                await captureRequired(client);
                const proof = await captureOptional(client);
                registerOptionalTransactionProof(client, {
                  validate: () => proof.validate(client),
                  invalidate: () =>
                    assert.fail(
                      'An unchanged overlapping reader must remain valid',
                    ),
                });
              }
              await checkTransactionDeadlines(first);
              const firstPid = await pidOf(first),
                secondPid = await pidOf(second);
              assert.equal(
                await epochLock(firstPid, table, 'ShareLock', true),
                true,
              );
              // The first transaction remains open throughout the second's real
              // required and optional final validation, including fresh vectors.
              await checkTransactionDeadlines(second);
              for (const pid of [firstPid, secondPid]) {
                assert.equal(
                  await epochLock(pid, table, 'ShareLock', true),
                  true,
                );
                assert.deepEqual(await advisoryLocks(pid, namespace), []);
              }
              assert.equal((await epochs(first)).length, 128);
              assert.deepEqual(await epochs(first), await epochs(second));
              await first.query('COMMIT');
              await second.query('COMMIT');
            } finally {
              await release(first);
              await release(second);
            }
          },
        );

        await t.test(
          `${spec.name}: real and zero-row writers make required NOWAIT fail and roll back`,
          async () => {
            const id = await seed();
            const statements: [string, unknown[]][] = [
              [mutation, [id]],
              ...spec.zeroRowSources.map(
                ([source, key]): [string, unknown[]] => [
                  `UPDATE whaleu_${spec.name}.${source} SET ${key}=${key} WHERE false`,
                  [],
                ],
              ),
            ];
            for (const [sql, values] of statements) {
              const writer = await pool.connect();
              try {
                await writer.query('BEGIN');
                await writer.query(sql, values);
                assert.equal(
                  await epochLock(
                    await pidOf(writer),
                    table,
                    'RowExclusiveLock',
                    true,
                  ),
                  true,
                  sql,
                );
                const tentativeId = randomUUID();
                await assert.rejects(
                  transaction(async (reader) => {
                    await captureRequired(reader);
                    await reader.query(
                      'INSERT INTO whaleu_identity.accounts(id) VALUES($1)',
                      [tentativeId],
                    );
                    await reader.query('SAVEPOINT observe_nowait');
                    await assert.rejects(
                      spec.owner.fence(reader),
                      sqlCode('55P03'),
                    );
                    await reader.query('ROLLBACK TO SAVEPOINT observe_nowait');
                    await reader.query('RELEASE SAVEPOINT observe_nowait');
                  }),
                  errorIs(spec.code),
                  sql,
                );
                assert.equal(
                  (
                    await pool.query(
                      'SELECT id FROM whaleu_identity.accounts WHERE id=$1',
                      [tentativeId],
                    )
                  ).rowCount,
                  0,
                );
              } finally {
                await release(writer);
              }
            }
          },
        );

        await t.test(
          `${spec.name}: reader-first writer waits at epoch UPDATE before touching the business row`,
          async () => {
            const id = await seed(),
              reader = await pool.connect(),
              writer = await pool.connect();
            let pending: ReturnType<typeof launch> | undefined;
            try {
              await begin(reader);
              await captureRequired(reader);
              const before = await total(reader);
              await checkTransactionDeadlines(reader);
              await writer.query('BEGIN');
              const writerPid = await pidOf(writer);
              pending = launch(writer, mutation, [id]);
              await waitFor(
                () => epochLock(writerPid, table, 'RowExclusiveLock', false),
                'Writer must wait on the epoch relation, not reject slot admission',
              );
              assert.equal(
                await epochLock(writerPid, table, 'RowShareLock', true),
                true,
              );
              const slots = await advisoryLocks(writerPid, namespace);
              assert.equal(slots.length, 1);
              assert.ok(slots[0]!.slot >= 0 && slots[0]!.slot < 128);
              assert.equal(slots[0]!.mode, 'ExclusiveLock');
              assert.equal(slots[0]!.granted, true);
              assert.equal(await total(reader), before);
              // MVCC alone could show an old row after a mutation. Taking the real
              // row lock NOWAIT additionally proves the writer has not touched it.
              await transaction(async (inspector) => {
                const result = await inspector.query<{ value: boolean }>(
                  `SELECT ${spec.flag} value FROM ${spec.table} WHERE ${spec.key}=$1 FOR UPDATE NOWAIT`,
                  [id],
                );
                assert.equal(result.rows[0]!.value, true);
              });
              await reader.query('COMMIT');
              assert.equal((await completed(pending)).rowCount, 1);
              assert.equal(await total(writer), before + 1n);
              await writer.query('COMMIT');
              assert.equal(
                (
                  await pool.query<{ value: boolean }>(
                    `SELECT ${spec.flag} value FROM ${spec.table} WHERE ${spec.key}=$1`,
                    [id],
                  )
                ).rows[0]!.value,
                false,
              );
            } finally {
              await release(reader);
              if (pending) await pending;
              await release(writer);
            }
          },
        );

        await t.test(
          `${spec.name}: old-reader overflow waits then retries through the new reader fence`,
          async () => {
            const id = await seed(),
              legacy = await pool.connect(),
              reader = await pool.connect(),
              writer = await pool.connect();
            let pending: ReturnType<typeof launch> | undefined;
            try {
              await legacy.query('BEGIN');
              // The previous release's exact wire protocol, held by real PostgreSQL
              // locks, forces the original writer's saturated-slot fallback.
              await legacy.query('SELECT pg_advisory_xact_lock($1,128)', [
                namespace,
              ]);
              await legacy.query(
                `SELECT pg_advisory_xact_lock_shared($1,slot)
             FROM (SELECT generate_series(0,127) slot ORDER BY slot) slots`,
                [namespace],
              );
              assert.equal(
                (await advisoryLocks(await pidOf(legacy), namespace)).length,
                129,
              );
              await begin(reader);
              await captureRequired(reader);
              await checkTransactionDeadlines(reader);
              assert.equal(
                await epochLock(await pidOf(reader), table, 'ShareLock', true),
                true,
              );
              await writer.query('BEGIN');
              const writerPid = await pidOf(writer);
              pending = launch(writer, mutation, [id]);
              await waitFor(
                async () =>
                  (await advisoryLocks(writerPid, namespace)).some(
                    (lock) =>
                      lock.slot === 128 &&
                      lock.mode === 'ShareLock' &&
                      !lock.granted,
                  ),
                'The saturated writer must wait on the original shared overflow gate',
              );
              assert.equal(
                await epochLock(writerPid, table, 'RowExclusiveLock', true),
                false,
              );
              await legacy.query('COMMIT');
              await waitFor(
                () => epochLock(writerPid, table, 'RowExclusiveLock', false),
                'After legacy-reader release, writer must claim a slot and wait on the new epoch fence',
              );
              const locks = await advisoryLocks(writerPid, namespace);
              assert.ok(
                locks.some(
                  (lock) =>
                    lock.slot === 128 &&
                    lock.mode === 'ShareLock' &&
                    lock.granted,
                ),
              );
              assert.equal(
                locks.filter(
                  (lock) =>
                    lock.slot < 128 &&
                    lock.mode === 'ExclusiveLock' &&
                    lock.granted,
                ).length,
                1,
              );
              await reader.query('COMMIT');
              assert.equal((await completed(pending)).rowCount, 1);
              await writer.query('COMMIT');
            } finally {
              await release(legacy);
              await release(reader);
              if (pending) await pending;
              await release(writer);
            }
          },
        );

        await t.test(
          `${spec.name}: optional invalidation rolls back its new relation fence`,
          async () => {
            const reader = await pool.connect(),
              writer = await pool.connect();
            try {
              await begin(reader);
              const proof = await captureOptional(reader);
              await pool.query(zero);
              let invalidated = false;
              registerOptionalTransactionProof(reader, {
                validate: () => proof.validate(reader),
                invalidate: () => {
                  invalidated = true;
                },
              });
              await checkTransactionDeadlines(reader);
              assert.equal(invalidated, true);
              assert.equal(
                await epochLock(await pidOf(reader), table, 'ShareLock', true),
                false,
              );
              assert.deepEqual(
                await advisoryLocks(await pidOf(reader), namespace),
                [],
              );
              // Reader stays open: writer progress proves rollback released the
              // relation lock, rather than relying on transaction cleanup.
              await writer.query('BEGIN');
              await writer.query("SET LOCAL lock_timeout='100ms'");
              await writer.query(zero);
              await writer.query('COMMIT');
              assert.equal(
                (await reader.query('SELECT 1 value')).rows[0]!.value,
                1,
              );
              await reader.query('COMMIT');
            } finally {
              await release(reader);
              await release(writer);
            }
          },
        );

        await t.test(
          `${spec.name}: a transaction may prove its own prior write but cannot bless a later epoch`,
          async () => {
            const id = await seed();
            await transaction(async (client) => {
              await client.query(mutation, [id]);
              await captureRequired(client);
              const proof = await captureOptional(client);
              registerOptionalTransactionProof(client, {
                validate: () => proof.validate(client),
                invalidate: () =>
                  assert.fail('Own prior write is part of the captured vector'),
              });
              await checkTransactionDeadlines(client);
              const pid = await pidOf(client);
              assert.equal(
                await epochLock(pid, table, 'ShareLock', true),
                true,
              );
              assert.equal(
                await epochLock(pid, table, 'RowExclusiveLock', true),
                true,
              );
              assert.equal((await advisoryLocks(pid, namespace)).length, 1);
            });
            await assert.rejects(
              transaction(async (client) => {
                await captureRequired(client);
                await client.query(
                  `UPDATE ${spec.table} SET ${spec.flag}=true WHERE ${spec.key}=$1`,
                  [id],
                );
              }),
              errorIs(spec.code),
            );
            assert.equal(
              (
                await pool.query<{ value: boolean }>(
                  `SELECT ${spec.flag} value FROM ${spec.table} WHERE ${spec.key}=$1`,
                  [id],
                )
              ).rows[0]!.value,
              false,
            );
          },
        );

        await t.test(
          `${spec.name}: incomplete real metadata cannot become a valid required or optional vector`,
          async () => {
            const reader = await pool.connect();
            try {
              await begin(reader);
              await captureRequired(reader);
              const proof = await captureOptional(reader);
              // Transaction-local corruption of the disposable fixture only. The
              // original immutable metadata guards and all rows return on rollback.
              await reader.query(`ALTER TABLE ${table} DISABLE TRIGGER USER`);
              await reader.query(`DELETE FROM ${table} WHERE slot=127`);
              await reader.query(`ALTER TABLE ${table} ENABLE TRIGGER USER`);
              assert.equal((await epochs(reader)).length, 127);
              await assert.rejects(captureRequired(reader), errorIs(spec.code));
              await assert.rejects(
                captureOptional(reader),
                errorIs('COMMUNITY_UNAVAILABLE'),
              );
              assert.equal(await proof.validate(reader), false);
              await assert.rejects(
                checkTransactionDeadlines(reader),
                errorIs(spec.code),
              );
            } finally {
              await release(reader);
            }
            await assert.rejects(
              transaction(async (client) => {
                assert.equal((await epochs(client)).length, 128);
                await client.query(`DELETE FROM ${table} WHERE slot=127`);
              }),
              sqlCode('23514'),
            );
          },
        );
      }
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
