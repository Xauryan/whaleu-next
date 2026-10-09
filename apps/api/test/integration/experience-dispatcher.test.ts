import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { AppModule } from '../../src/app.module.js';
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
import { CommunityRepository } from '../../src/community/community.repository.js';
import { ExperienceSourceRouter } from '../../src/experience/source-router.js';
import { ExperienceDispatcher } from '../../src/experience/dispatcher.js';
import { ExperienceWorker } from '../../src/experience/worker.js';
import { ExperienceRepository } from '../../src/experience/repository.js';
import { ExperienceSettlementService } from '../../src/experience/settlement.js';
import { initializeNativeExperienceAccount } from '../../src/experience/lifecycle.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

function running(dispatcher: ExperienceDispatcher) {
  // Observe the scheduler's actual promise; do not call private cycle methods.
  return (dispatcher as unknown as { inflight: Promise<void> | null }).inflight;
}
const cycleStarts = new WeakMap<ExperienceDispatcher, () => void>();
function nextCycle(dispatcher: ExperienceDispatcher) {
  return new Promise<void>((resolve) => cycleStarts.set(dispatcher, resolve));
}
async function tick(dispatcher: ExperienceDispatcher) {
  const started = nextCycle(dispatcher);
  await dispatcher.start();
  await started;
  const task = running(dispatcher);
  assert.ok(task, 'The timer starts exactly one actual dispatcher cycle');
  await task;
  // Freeze the measured boundary before inspecting SQL; the next explicit tick
  // restarts the real timer. PostgreSQL and its connection timers stay real.
  await dispatcher.stop();
}

test(
  'real PostgreSQL bounded experience dispatcher frontier draining',
  { timeout: 120000 },
  async (t) => {
    const urlString = process.env['TEST_DATABASE_URL'];
    assert.ok(urlString);
    const url = new URL(urlString);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const config = loadConfig({
        NODE_ENV: 'test',
        DATABASE_URL: urlString,
        PG_SSL_MODE: 'disable',
        PG_POOL_MAX: '12',
        LOG_LEVEL: 'silent',
      }),
      pool = new Pool(poolOptions(config));
    let suite: PoolClient | undefined,
      app: INestApplication | undefined,
      owns = false,
      locked = false;
    const dispatchers: ExperienceDispatcher[] = [];
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) AS locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert.ok(locked);
      assert.ok(
        supportedPostgresVersion(
          (
            await pool.query<{ version: number }>(
              "SELECT current_setting('server_version_num')::integer AS version",
            )
          ).rows[0]!.version,
        ),
      );
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM pg_namespace WHERE nspname=ANY($1::text[])',
            [migrationSchemaNames],
          )
        ).rowCount,
        0,
        'Refusing existing schemas',
      );
      owns = true;
      await runMigrations(
        pool,
        await readMigrations(
          fileURLToPath(new URL('../../migrations', import.meta.url)),
        ),
        { mode: 'up' },
      );
      // Every reward, source, repository and policy provider remains the real app
      // provider. Fixtures only create disposable local accounts/content/events.
      const module = await Test.createTestingModule({
        imports: [AppModule.register(config)],
      }).compile();
      app = module.createNestApplication({ logger: false });
      await app.init();
      assert.equal(config.EXPERIENCE_PROCESSING, 'manual_only');
      assert.equal(config.EXPERIENCE_BATCH_SIZE, 20);
      assert.equal(config.PG_STATEMENT_TIMEOUT_MS, 10000);
      const community = app.get(CommunityRepository),
        space = randomUUID();
      await pool.query(
        "INSERT INTO whaleu_community.spaces(id,kind,name,is_active) VALUES($1,'global','Synthetic dispatcher fixture',true)",
        [space],
      );
      async function owner(known = true) {
        const id = randomUUID();
        await inTransaction(pool, async (tx) => {
          await tx.query(
            'INSERT INTO whaleu_identity.accounts(id) VALUES($1)',
            [id],
          );
          if (known) await initializeNativeExperienceAccount(id, tx);
        });
        return id;
      }
      async function post(account: string, enroll = true) {
        const id = randomUUID();
        await inTransaction(pool, async (tx) => {
          await tx.query(
            "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'discussion','Synthetic dispatcher content','named','open')",
            [id, space, account],
          );
          if (enroll)
            await community.event(
              `post:${id}:created`,
              'post_created',
              id,
              tx,
              {
                experienceSourceVersion: 1,
                actorAccountId: account,
                actorAuthorMode: 'named',
                resourceAuthorMode: 'named',
              },
            );
        });
        return id;
      }
      async function remove(account: string, id: string) {
        await inTransaction(pool, async (tx) => {
          await tx.query(
            "UPDATE whaleu_community.posts SET deleted_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=$1",
            [id],
          );
          await community.event(`post:${id}:deleted`, 'post_deleted', id, tx, {
            experienceSourceVersion: 1,
            actorAccountId: account,
            actorAuthorMode: 'named',
            resourceAuthorMode: 'named',
          });
        });
      }
      async function units(account: string) {
        return (
          await pool.query<{ unit_id: string }>(
            'SELECT unit_id FROM whaleu_experience.work WHERE beneficiary_id=$1 ORDER BY enrollment_order,unit_id',
            [account],
          )
        ).rows.map((r) => r.unit_id);
      }
      async function completed(account: string) {
        return (
          await pool.query<{ unit_id: string }>(
            "SELECT unit_id FROM whaleu_experience.work WHERE beneficiary_id=$1 AND state='completed' ORDER BY enrollment_order,unit_id",
            [account],
          )
        ).rows.map((r) => r.unit_id);
      }
      async function settlements(account: string) {
        return (
          await pool.query<{
            unit_id: string;
            outcome: string;
            applied_delta: string;
            balance_after: string;
            state_revision: string;
          }>(
            'SELECT unit_id,outcome,applied_delta::text,balance_after::text,state_revision::text FROM whaleu_experience.settlements WHERE owner_id=$1 ORDER BY whaleu_experience.settlements.state_revision',
            [account],
          )
        ).rows;
      }
      function dispatcher(t: TestContext, batch = 20) {
        const local = { ...config, EXPERIENCE_BATCH_SIZE: batch };
        const worker = new ExperienceWorker(
          local,
          app!.get(DatabaseService),
          app!.get(ExperienceSourceRouter),
          app!.get(ExperienceRepository),
          app!.get(ExperienceSettlementService),
        );
        const run = worker.run.bind(worker),
          due = worker.due.bind(worker),
          attempts: string[] = [],
          frontiers: { attempted: readonly string[]; returned: string[] }[] =
            [];
        // Pass-through observers preserve the full real worker/SQL behavior.
        t.mock.method(
          worker,
          'run',
          async (input: Parameters<ExperienceWorker['run']>[0]) => {
            attempts.push(...(input?.unitIds ?? []));
            return run(input);
          },
        );
        t.mock.method(worker, 'due', async (attempted = []) => {
          if (!attempted.length) {
            cycleStarts.get(dispatcher)?.();
            cycleStarts.delete(dispatcher);
          }
          const returned = await due(attempted);
          frontiers.push({ attempted: [...attempted], returned });
          return returned;
        });
        const dispatcher = new ExperienceDispatcher(
          {
            ...local,
            EXPERIENCE_PROCESSING: 'automatic',
            EXPERIENCE_INTERVAL_MS: 10,
          },
          worker,
        );
        dispatchers.push(dispatcher);
        t.after(() => dispatcher.stop());
        return { dispatcher, worker, attempts, frontiers };
      }

      await t.test(
        'default manual mode leaves enrolled work pending and automatic discovery never adopts unenrolled history',
        async (t) => {
          const account = await owner();
          const historical = await post(account, false);
          await post(account);
          await post(account);
          const expected = await units(account);
          assert.equal(expected.length, 2);
          await app!.get(ExperienceDispatcher).start();
          await sleep(25);
          assert.deepEqual(await completed(account), []);
          const f = dispatcher(t);
          await f.dispatcher.start();
          await tick(f.dispatcher);
          assert.deepEqual(await completed(account), expected);
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.reward_source_groups WHERE post_id=$1',
                [historical],
              )
            ).rowCount,
            0,
          );
          assert.equal((await settlements(account)).length, 2);
        },
      );

      await t.test(
        'a single hot owner settles twenty sequential units in one default batch and only the remaining four on the next tick',
        async (t) => {
          const account = await owner();
          for (let i = 0; i < 24; i++) await post(account);
          const expected = await units(account);
          const f = dispatcher(t);
          await f.dispatcher.start();
          await tick(f.dispatcher);
          assert.deepEqual(f.attempts, expected.slice(0, 20));
          assert.deepEqual(await completed(account), expected.slice(0, 20));
          assert.equal(f.frontiers.length, 20);
          assert.equal(
            f.frontiers.reduce((n, f) => n + f.returned.length, 0),
            20,
          );
          for (const frontier of f.frontiers)
            assert.ok(
              frontier.returned.length <= 20 - frontier.attempted.length,
            );
          const first = await settlements(account);
          assert.deepEqual(
            first.map((s) => s.unit_id),
            expected.slice(0, 20),
          );
          assert.deepEqual(
            first.map((s) => s.outcome),
            ['awarded', ...Array<string>(19).fill('capped')],
          );
          assert.equal(first.at(-1)!.balance_after, '10');
          await tick(f.dispatcher);
          assert.deepEqual(f.attempts, expected);
          assert.deepEqual(await completed(account), expected);
          assert.equal(
            (await settlements(account)).at(-1)!.state_revision,
            '24',
          );
          assert.equal(
            f.frontiers.length,
            25,
            'Second cycle performs four attempts plus one empty frontier read',
          );
        },
      );

      await t.test(
        'round fairness preserves independent owners and causal create/cap/delete/refund order under one total budget',
        async (t) => {
          const hot = await owner(),
            peer = await owner();
          const first = await post(hot);
          await post(hot);
          await remove(hot, first);
          await post(hot);
          await post(peer);
          const hotUnits = await units(hot),
            peerUnits = await units(peer);
          const f = dispatcher(t, 4);
          await f.dispatcher.start();
          await tick(f.dispatcher);
          assert.deepEqual(f.attempts, [
            hotUnits[0],
            peerUnits[0],
            hotUnits[1],
            hotUnits[2],
          ]);
          assert.equal(f.attempts.length, 4);
          assert.deepEqual(await completed(hot), hotUnits.slice(0, 3));
          assert.deepEqual(await completed(peer), peerUnits);
          assert.deepEqual(
            (await settlements(hot)).map((s) => [s.outcome, s.applied_delta]),
            [
              ['awarded', '10'],
              ['capped', '0'],
              ['deducted', '-10'],
            ],
          );
          await tick(f.dispatcher);
          assert.deepEqual(
            (await settlements(hot)).map((s) => s.unit_id),
            hotUnits,
          );
          assert.equal((await settlements(hot)).at(-1)!.balance_after, '10');
          assert.deepEqual(
            (
              await pool.query(
                'SELECT rewarded_count,refund_count,gross_positive_awarded::text FROM whaleu_experience.daily_buckets WHERE owner_id=$1',
                [hot],
              )
            ).rows,
            [
              {
                rewarded_count: 1,
                refund_count: 1,
                gross_positive_awarded: '20',
              },
            ],
          );
        },
      );

      await t.test(
        'unknown and failing heads remain blockers while independent work drains; restart respects actual persisted backoff',
        async (t) => {
          const unknown = await owner(false),
            bad = await owner(),
            good = await owner();
          for (let i = 0; i < 2; i++) await post(unknown);
          for (let i = 0; i < 2; i++) await post(bad);
          for (let i = 0; i < 4; i++) await post(good);
          const unknownUnits = await units(unknown),
            badUnits = await units(bad),
            goodUnits = await units(good);
          // Real storage failure after settlement/state writes verifies rollback;
          // neither the source authority nor the reward calculation is replaced.
          await pool.query(
            `CREATE FUNCTION whaleu_experience.synthetic_dispatch_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.owner_id='${bad}'::uuid THEN RAISE EXCEPTION 'Synthetic dispatcher record interruption'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_dispatch_failure BEFORE INSERT ON whaleu_experience.records FOR EACH ROW EXECUTE FUNCTION whaleu_experience.synthetic_dispatch_failure()`,
          );
          const f = dispatcher(t, 5);
          try {
            await f.dispatcher.start();
            await tick(f.dispatcher);
            assert.deepEqual(f.attempts, [
              unknownUnits[0],
              badUnits[0],
              ...goodUnits.slice(0, 3),
            ]);
            assert.deepEqual(await completed(unknown), []);
            assert.deepEqual(await completed(bad), []);
            assert.deepEqual(await completed(good), goodUnits.slice(0, 3));
            assert.deepEqual(await settlements(bad), []);
            assert.equal(
              (
                await pool.query<{ balance: string }>(
                  'SELECT balance::text FROM whaleu_experience.account_states WHERE owner_id=$1',
                  [bad],
                )
              ).rows[0]!.balance,
              '0',
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_experience.account_states WHERE owner_id=$1',
                  [unknown],
                )
              ).rowCount,
              0,
            );
            assert.deepEqual(
              (
                await pool.query(
                  'SELECT state,attempts,error_code,next_attempt_at>clock_timestamp() AS deferred FROM whaleu_experience.work WHERE unit_id=$1',
                  [badUnits[0]],
                )
              ).rows,
              [
                {
                  state: 'pending',
                  attempts: 1,
                  error_code: 'local_processing_failed',
                  deferred: true,
                },
              ],
            );
            assert.deepEqual(
              (
                await pool.query(
                  'SELECT state,error_code FROM whaleu_experience.work WHERE unit_id=$1',
                  [unknownUnits[0]],
                )
              ).rows,
              [{ state: 'blocked_baseline', error_code: 'baseline_unknown' }],
            );
            assert.deepEqual(
              await f.worker.due([unknownUnits[0]!, badUnits[0]!]),
              [goodUnits[3]],
            );
            await f.dispatcher.stop();
            await f.dispatcher.start();
            await tick(f.dispatcher);
            assert.deepEqual(await completed(good), goodUnits);
            assert.equal(
              f.attempts.filter((id) => id === badUnits[0]).length,
              1,
            );
            assert.ok(!f.attempts.includes(badUnits[1]!));
            assert.ok(!f.attempts.includes(unknownUnits[1]!));
          } finally {
            await pool.query(
              'DROP TRIGGER synthetic_dispatch_failure ON whaleu_experience.records; DROP FUNCTION whaleu_experience.synthetic_dispatch_failure()',
            );
          }
          // Let PostgreSQL's real backoff elapse; do not rewrite retry timestamps or
          // replace the reward clock. The normal 10-second statement cap is intact.
          await pool.query(
            'SELECT pg_sleep(greatest(0,extract(epoch FROM (next_attempt_at-clock_timestamp())))::double precision + 0.02) FROM whaleu_experience.work WHERE unit_id=$1',
            [badUnits[0]],
          );
          await tick(f.dispatcher);
          assert.deepEqual(await completed(bad), badUnits);
          assert.deepEqual(
            (await settlements(bad)).map((s) => s.unit_id),
            badUnits,
          );
          assert.equal((await settlements(bad)).at(-1)!.balance_after, '10');
          assert.equal(f.attempts.filter((id) => id === badUnits[0]).length, 2);
          assert.equal(
            (
              await pool.query<{ attempts: number }>(
                'SELECT attempts FROM whaleu_experience.work WHERE unit_id=$1',
                [badUnits[0]],
              )
            ).rows[0]!.attempts,
            1,
          );
          assert.deepEqual(await completed(unknown), []);
        },
      );

      await t.test(
        'an unavailable retry write cannot spin on the same head or expose its successor within one cycle',
        async (t) => {
          const bad = await owner(),
            good = await owner();
          for (let i = 0; i < 2; i++) await post(bad);
          for (let i = 0; i < 3; i++) await post(good);
          const badUnits = await units(bad),
            goodUnits = await units(good);
          await pool.query(`CREATE FUNCTION whaleu_experience.synthetic_dispatch_stuck() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN
              IF TG_TABLE_NAME='records' THEN
                IF NEW.owner_id='${bad}'::uuid THEN RAISE EXCEPTION 'Synthetic record failure'; END IF;
              ELSE
                IF NEW.beneficiary_id='${bad}'::uuid THEN RAISE EXCEPTION 'Synthetic retry storage failure'; END IF;
              END IF;
              RETURN NEW;
            END $$;
            CREATE TRIGGER synthetic_dispatch_stuck BEFORE INSERT ON whaleu_experience.records FOR EACH ROW EXECUTE FUNCTION whaleu_experience.synthetic_dispatch_stuck();
            CREATE TRIGGER synthetic_dispatch_stuck BEFORE UPDATE ON whaleu_experience.work FOR EACH ROW EXECUTE FUNCTION whaleu_experience.synthetic_dispatch_stuck()`);
          const f = dispatcher(t, 5);
          try {
            await tick(f.dispatcher);
            assert.deepEqual(f.attempts, [badUnits[0], ...goodUnits]);
            assert.equal(
              f.frontiers.length,
              4,
              'Three productive rounds and one empty refresh',
            );
            assert.deepEqual(await completed(bad), []);
            assert.deepEqual(await completed(good), goodUnits);
            assert.deepEqual(await settlements(bad), []);
            assert.deepEqual(
              (
                await pool.query(
                  'SELECT state,attempts,error_code,next_attempt_at<=clock_timestamp() AS due FROM whaleu_experience.work WHERE unit_id=$1',
                  [badUnits[0]],
                )
              ).rows,
              [{ state: 'pending', attempts: 0, error_code: null, due: true }],
            );
            assert.deepEqual(
              await f.worker.due([badUnits[0]!]),
              [],
              'Excluded unresolved head continues blocking its own successor',
            );
          } finally {
            await pool.query(
              'DROP TRIGGER synthetic_dispatch_stuck ON whaleu_experience.records; DROP TRIGGER synthetic_dispatch_stuck ON whaleu_experience.work; DROP FUNCTION whaleu_experience.synthetic_dispatch_stuck()',
            );
          }
          await tick(f.dispatcher);
          assert.deepEqual(await completed(bad), badUnits);
          assert.deepEqual(
            (await settlements(bad)).map((s) => s.unit_id),
            badUnits,
          );
          assert.equal(f.attempts.filter((id) => id === badUnits[0]).length, 2);
        },
      );

      await t.test(
        'duplicate dispatchers and manual competition settle once; stop/restart waits for a real owner lock without overlapping cycles',
        async (t) => {
          const account = await owner();
          for (let i = 0; i < 8; i++) await post(account);
          const expected = await units(account);
          const a = dispatcher(t),
            b = dispatcher(t),
            manual = dispatcher(t);
          const blocker = await pool.connect();
          let released = false;
          try {
            await blocker.query('BEGIN');
            await blocker.query(
              'SELECT owner_id FROM whaleu_experience.owners WHERE owner_id=$1 FOR UPDATE',
              [account],
            );
            const beganA = nextCycle(a.dispatcher),
              beganB = nextCycle(b.dispatcher);
            await Promise.all([
              a.dispatcher.start(),
              a.dispatcher.start(),
              b.dispatcher.start(),
            ]);
            await Promise.all([beganA, beganB]);
            const cycleA = running(a.dispatcher),
              cycleB = running(b.dispatcher);
            assert.ok(cycleA && cycleB);
            const manualRun = manual.worker.run({
              mode: 'apply',
              unitIds: expected,
            });
            const deadline = Date.now() + 3000;
            let waiting = 0;
            while (waiting < 3 && Date.now() < deadline) {
              waiting = (
                await pool.query<{ count: number }>(
                  "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT owner_id FROM whaleu_experience.owners WHERE owner_id=%'",
                )
              ).rows[0]!.count;
              if (waiting < 3) await pool.query('SELECT pg_sleep(0.01)');
            }
            assert.equal(
              waiting,
              3,
              'Two real dispatcher workers and manual worker wait on one owner guard',
            );
            let stopped = false,
              restarted = false;
            const stop = a.dispatcher.stop().then(() => {
              stopped = true;
            });
            const restart = Promise.all([
              a.dispatcher.start(),
              a.dispatcher.start(),
            ]).then(async () => {
              restarted = true;
              // Freeze the fresh generation while the other workers finish.
              // Its legitimate next timer must not be mistaken for stale work.
              await a.dispatcher.stop();
            });
            await sleep(30);
            assert.equal(stopped, false);
            assert.equal(restarted, false);
            assert.equal(a.attempts.length, 1);
            assert.equal(b.attempts.length, 1);
            await blocker.query('COMMIT');
            released = true;
            await Promise.all([cycleA, cycleB, manualRun, stop, restart]);
            assert.equal(
              a.attempts.length,
              1,
              'Stopped cycle cannot refresh or take another unit',
            );
            assert.ok(b.attempts.length <= 20);
            assert.equal(new Set(b.attempts).size, b.attempts.length);
            assert.deepEqual(await completed(account), expected);
            const rows = await settlements(account);
            assert.deepEqual(
              rows.map((r) => r.unit_id),
              expected,
            );
            assert.equal(rows.at(-1)!.state_revision, '8');
            assert.equal(rows.at(-1)!.balance_after, '10');
            assert.deepEqual(
              (
                await pool.query(
                  'SELECT count(*)::integer AS records,count(DISTINCT settlement_id)::integer AS settlements FROM whaleu_experience.records WHERE owner_id=$1',
                  [account],
                )
              ).rows,
              [{ records: 8, settlements: 8 }],
            );
            await b.dispatcher.stop();
            await tick(a.dispatcher);
            assert.equal(
              a.attempts.length,
              1,
              'Restart cannot replay completed work',
            );
            assert.deepEqual(await settlements(account), rows);
          } finally {
            if (!released) await blocker.query('ROLLBACK');
            blocker.release();
          }
        },
      );
      // All stopped dispatcher instances remain quiescent before schema cleanup.
      await sleep(20);
    } finally {
      try {
        await Promise.all(dispatchers.map((d) => d.stop()));
        await app?.close();
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
    }
  },
);
