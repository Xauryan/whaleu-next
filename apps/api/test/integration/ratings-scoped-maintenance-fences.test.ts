import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import request from 'supertest';
import { ratingScopedFixture } from '../support/rating-scoped-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { observeDirectoryQueries } from '../support/directory-query-observer.js';

const tables = ['scoped_source_epoch', 'scope_protocol_epoch'] as const;
const qualify = (table: string) => `whaleu_ratings.${table}`;
const sqlCode = (code: string) => (error: unknown) =>
  !!error &&
  typeof error === 'object' &&
  'code' in error &&
  error.code === code;

// These tests use real PostgreSQL locks, real owner final proofs and disposable
// metadata corruption rolled back with the failed request. No runtime guards,
// product defaults, proof deadlines or source authority are weakened.
test(
  'scoped epoch row fences admit real maintenance and preserve retained writer boundaries',
  { timeout: 120000 },
  async (t) => {
    const f = await ratingScopedFixture();
    t.after(() => f.close());
    await f.seedScopedCatalogs({ different: false });
    await f.publish({ activate: true });
    const waitFor = async (
      condition: () => Promise<boolean>,
      label: string,
    ) => {
      const until = performance.now() + 2000;
      while (performance.now() < until) {
        if (await condition()) return;
        await delay(2);
      }
      assert.fail(label);
    };
    const epochs = async () =>
      (
        await f.pool
          .query(`SELECT 'source' kind,singleton,version,epoch::text FROM whaleu_ratings.scoped_source_epoch
      UNION ALL SELECT 'protocol',singleton,version,epoch::text FROM whaleu_ratings.scope_protocol_epoch ORDER BY kind`)
      ).rows;
    const get = async (context: Awaited<ReturnType<typeof f.scopedContext>>) =>
      f
        .auth(request(f.http).get('/v2/ratings/categories'), f.creator)
        .query({ contextId: context.id, contextToken: context.token });
    const assertUnavailable = (response: Awaited<ReturnType<typeof get>>) => {
      assert.equal(response.status, 403, JSON.stringify(response.body));
      assert.equal(response.body.error.code, 'RATING_SCOPE_UNAVAILABLE');
    };
    // Capture the exact production final SQL through the genuine HTTP path;
    // reader-first protocol tests below replay this observed fence, not a mock.
    const observer = observeDirectoryQueries(f.app),
      observed: string[] = [];
    try {
      observer.setHook(async ({ sql }) => {
        observed.push(sql);
      });
      const context = await f.scopedContext(f.creator);
      assert.equal((await get(context)).status, 200);
    } finally {
      observer.restore();
    }
    const relationFence = observed.find(
      (sql) =>
        sql ===
        'LOCK TABLE whaleu_ratings.scoped_source_epoch,whaleu_ratings.scope_protocol_epoch IN ROW SHARE MODE NOWAIT',
    );
    assert.ok(relationFence);
    const rowFences = tables.map((table) => {
      const sql = observed.find(
        (value) =>
          value ===
          `SELECT singleton,version,epoch FROM ${qualify(table)} FOR SHARE NOWAIT`,
      );
      assert.ok(sql, table);
      return sql;
    });
    assert.ok(
      observed.includes(
        'LOCK TABLE whaleu_ratings.scoped_catalog_heads,whaleu_ratings.scope_protocol_heads IN SHARE MODE NOWAIT',
      ),
    );

    for (const table of tables) {
      await t.test(
        `${table}: actual VACUUM holds ShareUpdateExclusive while the same context stays readable`,
        async () => {
          // Ordinary registered zero-row source writes create real dead epoch
          // versions. The CI admission-controlled service may pause automatic
          // maintenance; this actual VACUUM still runs. TRUNCATE is excluded
          // because truncation legitimately needs AccessExclusive.
          await withCommunityScopeWriter(f.pool, async (tx) => {
            const readSetupEpochs = async () =>
              (
                await tx.query<{ kind: string; epoch: string }>(
                  `SELECT 'source' kind,epoch::text FROM whaleu_ratings.scoped_source_epoch
                 UNION ALL SELECT 'protocol',epoch::text FROM whaleu_ratings.scope_protocol_epoch ORDER BY kind`,
                )
              ).rows;
            const beforeSetup = await readSetupEpochs();
            assert.deepEqual(
              beforeSetup.map((row) => row.kind),
              ['protocol', 'source'],
            );
            const transaction = (
              await tx.query<{ xid: string; statement_timeout: string }>(
                "SELECT pg_current_xact_id()::text xid,current_setting('statement_timeout') statement_timeout",
              )
            ).rows[0]!;
            const started = performance.now();
            // Fixture work, not a larger production statement allowance. Keep
            // all 5000 genuine writes in the original transaction with one
            // final commit; no trigger, source guard or timeout is changed.
            // Four Ratings epoch triggers now also invalidate linked Community
            // proofs, so one monolithic DO needlessly shares one 15s timeout.
            for (let batch = 0; batch < 50; batch++) {
              const batchStarted = performance.now();
              await tx.query(
                `DO $$BEGIN FOR i IN 1..100 LOOP UPDATE whaleu_ratings.scope_protocol_versions SET id=id WHERE false; END LOOP;END$$`,
              );
              t.diagnostic(
                JSON.stringify({
                  phase: 'real-maintenance-fixture-batch',
                  table,
                  batch: batch + 1,
                  writes: 100,
                  elapsedMs: performance.now() - batchStarted,
                }),
              );
            }
            const afterSetup = await readSetupEpochs();
            assert.deepEqual(
              afterSetup.map((row) => row.kind),
              ['protocol', 'source'],
            );
            for (let index = 0; index < beforeSetup.length; index++)
              assert.equal(
                BigInt(afterSetup[index]!.epoch) -
                  BigInt(beforeSetup[index]!.epoch),
                5000n,
              );
            const afterTransaction = (
              await tx.query<{ xid: string; statement_timeout: string }>(
                "SELECT pg_current_xact_id()::text xid,current_setting('statement_timeout') statement_timeout",
              )
            ).rows[0]!;
            assert.deepEqual(afterTransaction, transaction);
            t.diagnostic(
              JSON.stringify({
                phase: 'real-maintenance-fixture-complete',
                table,
                batches: 50,
                writes: 5000,
                beforeSetup,
                afterSetup,
                transaction,
                elapsedMs: performance.now() - started,
              }),
            );
          });
          const context = await f.scopedContext(f.creator),
            before = await epochs();
          const maintenance = await f.pool.connect();
          const pid = (
            await maintenance.query<{ pid: number }>(
              'SELECT pg_backend_pid() pid',
            )
          ).rows[0]!.pid;
          let finished = false;
          let vacuum: Promise<{ error: unknown }> | undefined;
          try {
            const automatic = (
              await maintenance.query<{ setting: string; source: string }>(
                "SELECT setting,source FROM pg_settings WHERE name='autovacuum'",
              )
            ).rows[0]!;
            if (process.env['WHALEU_TEST_MAINTENANCE'] === 'controlled') {
              // The CI/local wrapper already ran fresh-loopback admission before
              // this fixture. Only its explicit process-level mode allows off.
              assert.equal(automatic.setting, 'off');
              assert.equal(automatic.source, 'command line');
            } else {
              assert.equal(automatic.setting, 'on');
            }
            await maintenance.query(
              "SET vacuum_cost_delay='2ms'; SET vacuum_cost_limit=1",
            );
            const proofObserver = observeDirectoryQueries(f.app);
            let overlappedFinal = false;
            let businessTransaction: symbol | undefined;
            let maintenanceStarted = false;
            let overlapError: unknown;
            let result: Awaited<ReturnType<typeof get>>;
            try {
              proofObserver.setHook(async ({ sql, transactionId }) => {
                if (
                  sql ===
                  'SELECT * FROM whaleu_ratings.scoped_contexts WHERE id=$1 AND token_digest=$2'
                )
                  businessTransaction = transactionId;
                if (
                  !maintenanceStarted &&
                  transactionId === businessTransaction &&
                  sql === 'SET CONSTRAINTS ALL IMMEDIATE'
                ) {
                  maintenanceStarted = true;
                  vacuum = maintenance
                    .query(`VACUUM (TRUNCATE FALSE) ${qualify(table)}`)
                    .then(
                      () => {
                        finished = true;
                        return { error: null };
                      },
                      (error: unknown) => {
                        finished = true;
                        return { error };
                      },
                    );
                  await waitFor(
                    async () =>
                      !finished &&
                      (
                        await f.pool.query(
                          `SELECT 1 FROM pg_locks WHERE pid=$1 AND relation=$2::regclass AND mode='ShareUpdateExclusiveLock' AND granted`,
                          [pid, qualify(table)],
                        )
                      ).rowCount === 1,
                    'The real VACUUM must hold its granted maintenance lock',
                  );
                }

                if (sql !== rowFences[tables.indexOf(table)]) return;
                try {
                  assert.equal(transactionId, businessTransaction);
                  assert.equal(
                    (
                      await f.pool.query(
                        `SELECT 1 FROM pg_locks WHERE pid=$1 AND relation=$2::regclass AND mode='ShareUpdateExclusiveLock' AND granted`,
                        [pid, qualify(table)],
                      )
                    ).rowCount,
                    1,
                    'Real maintenance still holds its lock after the actual final row fence',
                  );
                } catch (error) {
                  // Retain the original test error outside the owner's error mapper.
                  overlapError = error;
                  throw error;
                }
                overlappedFinal = true;
              });
              result = await get(context);
            } finally {
              proofObserver.restore();
            }
            if (overlapError) throw overlapError;
            assert.equal(maintenanceStarted, true);
            assert.equal(result.status, 200, JSON.stringify(result.body));
            assert.equal(overlappedFinal, true);
            assert.equal(
              finished,
              false,
              'The successful final proof must overlap actual maintenance',
            );
            assert.equal(
              (
                await f.pool.query(
                  `SELECT 1 FROM pg_locks WHERE pid=$1 AND relation=$2::regclass AND mode='ShareUpdateExclusiveLock' AND granted`,
                  [pid, qualify(table)],
                )
              ).rowCount,
              1,
            );
            t.diagnostic(
              `${table}: GET 200 while VACUUM still held ShareUpdateExclusive; epochs unchanged`,
            );
            assert.ok(vacuum, 'The actual maintenance operation must exist');
            const done = await vacuum;
            if (done.error) throw done.error;
            assert.deepEqual(await epochs(), before);
            assert.equal((await get(context)).status, 200);
          } finally {
            if (vacuum) await vacuum;
            maintenance.release();
          }
        },
      );

      for (const mode of ['FOR NO KEY UPDATE', 'EXCLUSIVE'] as const)
        await t.test(
          `${table}: ${mode} holder fails the actual HTTP final proof without waiting`,
          async () => {
            const context = await f.scopedContext(f.creator),
              holder = await f.pool.connect();
            const before = await epochs();
            try {
              await holder.query('BEGIN');
              await holder.query(
                mode === 'EXCLUSIVE'
                  ? `LOCK TABLE ${qualify(table)} IN EXCLUSIVE MODE`
                  : `SELECT * FROM ${qualify(table)} FOR NO KEY UPDATE`,
              );
              const started = performance.now();
              assertUnavailable(await get(context));
              assert.ok(performance.now() - started < 1000);
              assert.deepEqual(await epochs(), before);
            } finally {
              await holder.query('ROLLBACK');
              holder.release();
            }
          },
        );

      await t.test(
        `${table}: reader-first retained row fence makes the real zero-row writer wait then finish`,
        async () => {
          const reader = await f.pool.connect(),
            writer = await f.pool.connect();
          const before = await epochs();
          const writerPid = (
            await writer.query<{ pid: number }>('SELECT pg_backend_pid() pid')
          ).rows[0]!.pid;
          const readerPid = (
            await reader.query<{ pid: number }>('SELECT pg_backend_pid() pid')
          ).rows[0]!.pid;
          let pending:
            Promise<{ error: unknown; rowCount?: number | null }> | undefined;
          try {
            await reader.query('BEGIN');
            await reader.query(relationFence);
            // Lock only the selected retained row so protocol's ordinary UPDATE
            // is reached after its source UPDATE, rather than blocked by source.
            await reader.query(rowFences[tables.indexOf(table)]!);
            await writer.query('BEGIN');
            pending = writer
              .query(
                'UPDATE whaleu_ratings.scope_protocol_versions SET id=id WHERE false',
              )
              .then(
                (value) => ({ error: null, rowCount: value.rowCount }),
                (error: unknown) => ({ error }),
              );
            await waitFor(
              async () =>
                (
                  await f.pool.query(
                    `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock' AND wait_event='transactionid' AND $2=ANY(pg_blocking_pids(pid))) waiting`,
                    [writerPid, readerPid],
                  )
                ).rows[0]!.waiting === true,
              'Actual BEFORE STATEMENT epoch UPDATE must wait on the retained row',
            );
            assert.deepEqual(
              await epochs(),
              before,
              'No uncommitted epoch is visible',
            );
            await reader.query('COMMIT');
            const result = await pending;
            if (result.error) throw result.error;
            assert.equal(result.rowCount, 0);
            await writer.query('COMMIT');
            const after = await epochs();
            for (let i = 0; i < before.length; i++)
              assert.equal(
                BigInt(after[i]!.epoch),
                BigInt(before[i]!.epoch) + 1n,
              );
          } finally {
            await reader.query('ROLLBACK');
            if (pending) await pending;
            await writer.query('ROLLBACK');
            reader.release();
            writer.release();
          }
        },
      );

      for (const corruption of ['missing', 'extra'] as const)
        await t.test(
          `${table}: ${corruption} retained metadata cannot pass a previously captured final snapshot`,
          async () => {
            const context = await f.scopedContext(f.creator),
              before = await epochs();
            const hook = observeDirectoryQueries(f.app);
            let changed = false;
            let businessTransaction: symbol | undefined;
            try {
              hook.setHook(async ({ sql, transactionId }, tx) => {
                if (
                  sql ===
                  'SELECT * FROM whaleu_ratings.scoped_contexts WHERE id=$1 AND token_digest=$2'
                )
                  businessTransaction = transactionId;
                if (
                  !businessTransaction ||
                  transactionId !== businessTransaction ||
                  changed ||
                  sql !== 'SET CONSTRAINTS ALL IMMEDIATE'
                )
                  return;
                changed = true;
                // Corrupt only this failed disposable transaction. All DDL and
                // original guards return on rollback; never fabricate authority.
                await tx.query(
                  `ALTER TABLE ${qualify(table)} DISABLE TRIGGER USER`,
                );
                if (corruption === 'missing')
                  await tx.query(`DELETE FROM ${qualify(table)}`);
                else {
                  const checks = (
                    await tx.query<{ conname: string }>(
                      `SELECT conname FROM pg_constraint WHERE conrelid=$1::regclass AND contype='c' AND pg_get_constraintdef(oid)='CHECK (singleton)'`,
                      [qualify(table)],
                    )
                  ).rows;
                  assert.equal(checks.length, 1);
                  await tx.query(
                    `ALTER TABLE ${qualify(table)} DROP CONSTRAINT "${checks[0]!.conname}"`,
                  );
                  await tx.query(
                    `INSERT INTO ${qualify(table)} VALUES(false,1,0)`,
                  );
                }
                await tx.query(
                  `ALTER TABLE ${qualify(table)} ENABLE TRIGGER USER`,
                );
              });
              assertUnavailable(await get(context));
              assert.equal(changed, true);
            } finally {
              hook.restore();
            }
            assert.deepEqual(await epochs(), before);
            await assert.rejects(
              f.pool.query(`DELETE FROM ${qualify(table)}`),
              sqlCode('23514'),
            );
            assert.equal((await get(context)).status, 200);
          },
        );
    }
  },
);
