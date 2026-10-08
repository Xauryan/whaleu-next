import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.js';
import { inTransaction, poolOptions } from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { configureHttp } from '../../src/http/http.js';
import { initializeNativeSafetyAccount } from '../../src/safety/lifecycle.js';
import { hashToken } from '../../src/identity/tokens.js';
import { ExperienceRepository } from '../../src/experience/repository.js';
import { ExperienceSettlementService } from '../../src/experience/settlement.js';
import { lockExperienceOwner } from '../../src/experience/ingress.js';
import { levelFor } from '../../src/experience/catalog.js';
import { createRuntimeActor } from '../support/community-runtime-fixtures.js';
import { establishSyntheticExperienceBaseline } from '../support/experience-fixtures.js';
import { observeExactQueries } from '../support/exact-discovery-counts.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

// Disposable synthetic opening balances are explicit local evidence. All route,
// identity, visibility, final proof and settlement providers are the real owners.
test(
  'bounded experience ranking on real PostgreSQL',
  { timeout: 120000 },
  async (t) => {
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(
      database,
      'Requires isolated local PostgreSQL, never silently skip',
    );
    const url = new URL(database);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: database,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '20',
      EXPERIENCE_PROCESSING: 'manual_only',
      COMMUNITY_UPDATES_PROCESSING: 'manual_only',
    });
    const pool = new Pool(poolOptions(config));
    let app: INestApplication | undefined,
      suite: PoolClient | undefined,
      owns = false,
      locked = false;
    let observer: ReturnType<typeof observeExactQueries> | undefined;
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
      app = await NestFactory.create(AppModule.register(config), {
        logger: false,
      });
      configureHttp(app);
      await app.init();
      observer = observeExactQueries(app);
      const read = (limit?: string, token?: string) => {
        const call = request(app!.getHttpServer()).get(
          '/v1/experience/ranking' +
            (limit === undefined ? '' : `?limit=${limit}`),
        );
        return token === undefined
          ? call
          : call.set('Authorization', `Bearer ${token}`);
      };
      const seed = async (balance: bigint | null, profile = true) => {
        const accountId = randomUUID(),
          profileId = randomUUID();
        await inTransaction(pool, async (tx) => {
          await tx.query(
            'INSERT INTO whaleu_identity.accounts(id) VALUES($1)',
            [accountId],
          );
          await initializeNativeSafetyAccount(accountId, tx);
          if (balance !== null)
            await establishSyntheticExperienceBaseline(tx, accountId, {
              balance,
            });
          if (profile)
            await tx.query(
              "INSERT INTO whaleu_profile.profiles(account_id,public_id,nickname) VALUES($1,$2,'RankFixture')",
              [accountId, profileId],
            );
        });
        return { accountId, profileId, balance };
      };
      const exact = (value: object, keys: string[]) =>
        assert.deepEqual(Object.keys(value).sort(), keys.sort());
      const success = (response: request.Response) => {
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.match(response.headers['vary'] ?? '', /Authorization/i);
        exact(response.body, [
          'scope',
          'population',
          'populationCompleteness',
          'selectionStatus',
          'items',
        ]);
        assert.equal(response.body.scope, 'global');
        assert.equal(response.body.population, 'known_participants');
        assert.equal(response.body.populationCompleteness, 'incomplete');
        for (const item of response.body.items) {
          exact(item, ['profileId', 'displayName', 'experienceDisplay']);
          exact(item.experienceDisplay, ['title', 'color', 'level']);
          for (const field of Object.values(item.experienceDisplay))
            exact(field as object, ['status', 'value']);
          assert.equal(item.experienceDisplay.level.status, 'known');
        }
      };
      const writeBlock = async (
        blocker: string,
        blocked: string,
        source: string,
        active: boolean,
        id?: string,
      ) => {
        const relation = id ?? randomUUID();
        await inTransaction(pool, async (tx) => {
          if (id)
            await tx.query(
              'UPDATE whaleu_safety.blocks SET active=$2,revision=revision+1 WHERE id=$1',
              [id, active],
            );
          else
            await tx.query(
              "INSERT INTO whaleu_safety.blocks(id,blocker_id,blocked_id,active,revision,display_snapshot,source_kind,source_id) VALUES($1,$2,$3,$4,1,'Synthetic','profile',$5)",
              [relation, blocker, blocked, active, source],
            );
          await tx.query(
            'INSERT INTO whaleu_safety.events(id,account_id,relationship_id,kind,revision) SELECT $1,blocker_id,id,$2,revision FROM whaleu_safety.blocks WHERE id=$3',
            [randomUUID(), active ? 'blocked' : 'unblocked', relation],
          );
        });
        return relation;
      };
      const noLeak = (response: request.Response) => {
        assert.equal(response.status, 503, JSON.stringify(response.body));
        assert.equal(
          JSON.stringify(response.body).includes('experienceDisplay'),
          false,
        );
        assert.equal('items' in response.body, false);
      };
      const zero = await seed(0n),
        unknown = await seed(null),
        missing = await seed(1000n, false);
      await t.test(
        'guest strict route, known zero and absent histories; reads never initialize anything',
        async () => {
          const snapshot = async () => {
            const tables = (
              await pool.query<{ schema: string; name: string }>(
                'SELECT schemaname AS schema,tablename AS name FROM pg_tables WHERE schemaname=ANY($1::text[]) ORDER BY 1,2',
                [
                  [
                    'whaleu_experience',
                    'whaleu_profile',
                    'whaleu_notifications',
                    'whaleu_community',
                    'whaleu_identity',
                    'whaleu_safety',
                  ],
                ],
              )
            ).rows;
            const result: Record<string, unknown> = {};
            for (const table of tables)
              result[`${table.schema}.${table.name}`] = (
                await pool.query(
                  `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') data FROM ${table.schema}.${table.name} t`,
                )
              ).rows[0].data;
            return result;
          };
          const viewer = await createRuntimeActor(app!);
          const before = await snapshot(),
            response = await read();
          success(response);
          assert.equal(
            response.body.selectionStatus,
            'available_candidates_exhausted',
          );
          assert.deepEqual(
            response.body.items.map((x: { profileId: string }) => x.profileId),
            [zero.profileId],
          );
          assert.deepEqual(response.body.items[0].experienceDisplay.level, {
            status: 'known',
            value: 1,
          });
          assert.equal(
            JSON.stringify(response.body).includes(unknown.accountId),
            false,
          );
          assert.equal(
            JSON.stringify(response.body).includes(missing.accountId),
            false,
          );
          for (const query of [
            '0',
            '51',
            '01',
            '-1',
            '+1',
            '1.5',
            '',
            '1&limit=2',
            '1&cursor=x',
            '1&campus=x',
          ])
            assert.equal((await read(query)).status, 400, query);
          assert.equal(
            (
              await request(app!.getHttpServer())
                .get('/v1/experience/ranking')
                .send({ x: 1 })
            ).status,
            400,
          );
          assert.equal((await read('1', 'invalid')).status, 401);
          assert.equal(
            (
              await request(app!.getHttpServer())
                .get('/v1/experience/ranking')
                .set('Authorization', 'Basic x')
            ).status,
            401,
          );
          success(await read('1', viewer.accessToken));
          assert.deepEqual(await snapshot(), before);
        },
      );
      const high = await seed(139n),
        second = await seed(138n);
      await t.test(
        'one candidate SELECT retains order and levels across legitimate concurrent sign-in settlement',
        async () => {
          let sources = 0;
          observer!.setHook(async (event) => {
            if (/FROM whaleu_experience.account_states/.test(event.sql)) {
              sources++;
              await inTransaction(pool, async (tx) => {
                await lockExperienceOwner(tx, second.accountId);
                const state = await app!
                  .get(ExperienceRepository)
                  .state(second.accountId, tx);
                assert.ok(state);
                await app!.get(ExperienceSettlementService).signIn(state, tx);
              });
            }
          });
          try {
            const response = await read('2');
            success(response);
            assert.equal(sources, 1);
            assert.deepEqual(
              response.body.items.map(
                (x: { profileId: string }) => x.profileId,
              ),
              [high.profileId, second.profileId],
            );
            assert.equal(
              response.body.items[1].experienceDisplay.level.value,
              levelFor(138n),
            );
          } finally {
            observer!.setHook(null);
          }
          const response = await read('2');
          success(response);
          assert.equal(response.body.items[0].profileId, second.profileId);
        },
      );
      const top = await seed(9007199254740993n),
        lower = await seed(9007199254740992n),
        max = await seed(9223372036854775807n),
        tie = await seed(9007199254740993n);
      await t.test(
        'bigint and UUID ties use database order, with exact public projection and hidden-post preference',
        async () => {
          await pool.query(
            "UPDATE whaleu_profile.profiles SET preferences=jsonb_set(preferences,'{hideProfilePosts}','true') WHERE account_id=$1",
            [max.accountId],
          );
          const response = await read('4');
          success(response);
          assert.deepEqual(
            response.body.items.map((x: { profileId: string }) => x.profileId),
            [
              max.profileId,
              ...[top, tie]
                .sort((a, b) => a.accountId.localeCompare(b.accountId))
                .map((x) => x.profileId),
              lower.profileId,
            ],
          );
          assert.equal(response.body.selectionStatus, 'limit_reached');
          for (const actor of [top, lower, max, tie])
            assert.equal(
              JSON.stringify(response.body).includes(actor.accountId),
              false,
            );
        },
      );
      for (const stage of ['scalar', 'deferred'] as const)
        for (const direction of ['incoming', 'outgoing'] as const)
          for (const mutation of ['insert', 'reactivate'] as const)
            await t.test(
              `${stage} ${direction} raw ${mutation} fails whole result closed`,
              async () => {
                const viewer = await createRuntimeActor(app!);
                const blocker =
                    direction === 'incoming' ? max.accountId : viewer.accountId,
                  blocked =
                    direction === 'incoming' ? viewer.accountId : max.accountId;
                let relation =
                  mutation === 'reactivate'
                    ? await writeBlock(blocker, blocked, max.profileId, false)
                    : undefined;
                let fired = false;
                observer!.setHook(async (event) => {
                  if (
                    !fired &&
                    (stage === 'deferred'
                      ? event.sql === 'SET CONSTRAINTS ALL IMMEDIATE'
                      : event.sql.startsWith(
                          'SELECT EXISTS(SELECT 1 FROM whaleu_safety.blocks',
                        ) && event.values[1] === max.accountId)
                  ) {
                    fired = true;
                    relation = await writeBlock(
                      blocker,
                      blocked,
                      max.profileId,
                      true,
                      relation,
                    );
                  }
                });
                try {
                  noLeak(await read('1', viewer.accessToken));
                  assert.equal(fired, true);
                } finally {
                  observer!.setHook(null);
                  if (relation)
                    await writeBlock(
                      blocker,
                      blocked,
                      max.profileId,
                      false,
                      relation,
                    );
                }
              },
            );
      await t.test(
        'accepted proof survives rejected-candidate rollback and rejected account lock is released',
        async () => {
          const viewer = await createRuntimeActor(app!),
            denied = [top, tie].sort((a, b) =>
              a.accountId.localeCompare(b.accountId),
            )[0]!;
          const denial = await writeBlock(
            viewer.accountId,
            denied.accountId,
            denied.profileId,
            true,
          );
          let rolled = false,
            relation: string | undefined;
          observer!.setHook(async (event) => {
            if (!rolled && event.sql.startsWith('ROLLBACK TO SAVEPOINT')) {
              rolled = true;
              await inTransaction(pool, async (tx) => {
                await tx.query("SET LOCAL lock_timeout='100ms'");
                await tx.query(
                  "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
                  [denied.accountId],
                );
              });
              relation = await writeBlock(
                max.accountId,
                viewer.accountId,
                max.profileId,
                true,
              );
            }
          });
          try {
            noLeak(await read('2', viewer.accessToken));
            assert.equal(rolled, true);
          } finally {
            observer!.setHook(null);
            await pool.query(
              "UPDATE whaleu_identity.accounts SET status='active' WHERE id=$1",
              [denied.accountId],
            );
            await writeBlock(
              viewer.accountId,
              denied.accountId,
              denied.profileId,
              false,
              denial,
            );
            if (relation)
              await writeBlock(
                max.accountId,
                viewer.accountId,
                max.profileId,
                false,
                relation,
              );
          }
        },
      );
      await t.test(
        'valid blocked, revoked and expired sessions never downgrade to guest',
        async () => {
          for (const state of ['blocked', 'revoked', 'expired'] as const) {
            const viewer = await createRuntimeActor(app!);
            if (state === 'blocked')
              await pool.query(
                "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
                [viewer.accountId],
              );
            if (state === 'revoked')
              await pool.query(
                "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=$1",
                [viewer.sessionId],
              );
            if (state === 'expired')
              await pool.query(
                "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",
                [hashToken(viewer.accessToken)],
              );
            const response = await read('1', viewer.accessToken);
            assert.ok(
              [401, 403].includes(response.status),
              JSON.stringify(response.body),
            );
            assert.equal('items' in response.body, false);
          }
        },
      );
      await t.test(
        'status committed before canonical acquisition is excluded and refilled',
        async () => {
          let fired = false;
          observer!.setHook(async (event) => {
            if (
              !fired &&
              event.sql.includes(
                'FROM whaleu_profile.profiles WHERE account_id=$1',
              ) &&
              event.values[0] === max.accountId
            ) {
              fired = true;
              await pool.query(
                "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
                [max.accountId],
              );
            }
          });
          try {
            const response = await read('1');
            success(response);
            assert.equal(fired, true);
            assert.notEqual(response.body.items[0].profileId, max.profileId);
          } finally {
            observer!.setHook(null);
            await pool.query(
              "UPDATE whaleu_identity.accounts SET status='active' WHERE id=$1",
              [max.accountId],
            );
          }
        },
      );
      await t.test(
        'a genuine deferred SQL wait precedes the final bilateral proof',
        async () => {
          await pool.query('CREATE SCHEMA ranking_wait_fixture');
          await pool.query(
            'CREATE TABLE ranking_wait_fixture.waits(id integer PRIMARY KEY)',
          );
          await pool.query(
            `CREATE FUNCTION ranking_wait_fixture.wait_for_writer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(884122,1); RETURN NEW; END $$`,
          );
          await pool.query(
            'CREATE CONSTRAINT TRIGGER wait_for_writer AFTER INSERT ON ranking_wait_fixture.waits DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ranking_wait_fixture.wait_for_writer()',
          );
          const viewer = await createRuntimeActor(app!),
            blocker = await pool.connect();
          let armed = false,
            pid = 0,
            relation: string | undefined;
          let pending: Promise<request.Response> | undefined;
          await blocker.query('SELECT pg_advisory_lock(884122,1)');
          observer!.setHook(async (event, tx) => {
            if (
              !armed &&
              /FROM whaleu_experience.account_states/.test(event.sql)
            ) {
              armed = true;
              pid = (
                await tx.query<{ pid: number }>('SELECT pg_backend_pid() pid')
              ).rows[0]!.pid;
              await tx.query(
                'INSERT INTO ranking_wait_fixture.waits VALUES(1)',
              );
            }
          });
          try {
            pending = read('1', viewer.accessToken).then((x) => x);
            let waiting = false;
            for (let i = 0; i < 100; i++) {
              if (pid)
                waiting = (
                  await pool.query<{ waiting: boolean }>(
                    "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event='advisory' AND query='SET CONSTRAINTS ALL IMMEDIATE') waiting",
                    [pid],
                  )
                ).rows[0]!.waiting;
              if (waiting) break;
              await delay(5);
            }
            assert.equal(
              waiting,
              true,
              'Actual deferred trigger blocks final flush',
            );
            relation = await writeBlock(
              max.accountId,
              viewer.accountId,
              max.profileId,
              true,
            );
            await blocker.query('SELECT pg_advisory_unlock(884122,1)');
            noLeak(await pending);
          } finally {
            observer!.setHook(null);
            await blocker.query('SELECT pg_advisory_unlock_all()');
            blocker.release();
            if (pending) await pending;
            if (relation)
              await writeBlock(
                max.accountId,
                viewer.accountId,
                max.profileId,
                false,
                relation,
              );
            await pool.query('DROP SCHEMA ranking_wait_fixture CASCADE');
          }
        },
      );
      await t.test(
        'accepted guest account lock is retained until commit',
        async () => {
          let checked = false;
          observer!.setHook(async (event) => {
            if (!checked && event.sql === 'SET CONSTRAINTS ALL IMMEDIATE') {
              checked = true;
              await assert.rejects(
                inTransaction(pool, async (tx) => {
                  await tx.query("SET LOCAL lock_timeout='50ms'");
                  await tx.query(
                    "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
                    [max.accountId],
                  );
                }),
                (error: unknown) =>
                  (error as { code: string }).code === '55P03',
              );
            }
          });
          try {
            success(await read('1'));
            assert.equal(checked, true);
          } finally {
            observer!.setHook(null);
          }
        },
      );
      await t.test(
        'signed token expiry during deferred final wait never falls back to guest',
        async () => {
          const viewer = await createRuntimeActor(app!),
            expiry = new Date(Date.now() + 500);
          await pool.query(
            'UPDATE whaleu_identity.access_tokens SET expires_at=$2 WHERE token_hash=$1',
            [hashToken(viewer.accessToken), expiry],
          );
          let fired = false;
          observer!.setHook(async (event) => {
            if (!fired && event.sql === 'SET CONSTRAINTS ALL IMMEDIATE') {
              fired = true;
              await delay(Math.max(0, expiry.getTime() - Date.now()) + 25);
            }
          });
          try {
            const response = await read('1', viewer.accessToken);
            assert.equal(fired, true);
            assert.equal(response.status, 401, JSON.stringify(response.body));
            assert.equal(response.body.error.code, 'ACCESS_TOKEN_EXPIRED');
          } finally {
            observer!.setHook(null);
          }
          success(await read('1'));
        },
      );
      await t.test(
        'refills beyond 50 missing profiles and stops at the requested accepted limit',
        async () => {
          await pool.query(
            "UPDATE whaleu_identity.accounts SET status='blocked'",
          );
          for (let i = 0; i < 55; i++) await seed(10000n + BigInt(i), false);
          const visible = [];
          for (let i = 0; i < 51; i++)
            visible.push(await seed(5000n + BigInt(i)));
          const result = await observer!.measure('refill', () => read());
          success(result.value);
          assert.equal(result.value.body.items.length, 50);
          assert.equal(result.value.body.selectionStatus, 'limit_reached');
          assert.deepEqual(
            result.value.body.items.map(
              (x: { profileId: string }) => x.profileId,
            ),
            visible
              .reverse()
              .slice(0, 50)
              .map((x) => x.profileId),
          );
          t.diagnostic(
            JSON.stringify({
              refillQueries: result.measurement.queries,
              refillMs: result.measurement.durationMs,
            }),
          );
        },
      );
      await t.test(
        '257-row source cap distinguishes scan-limited from exhausted and never invents a cursor',
        async () => {
          await pool.query(
            "UPDATE whaleu_identity.accounts SET status='blocked'",
          );
          const count = (
            await pool.query<{ n: number }>(
              'SELECT count(*)::integer n FROM whaleu_experience.account_states',
            )
          ).rows[0]!.n;
          assert.ok(count < 256);
          for (let i = count; i < 256; i++) await seed(1n, false);
          const exhausted = await read('50');
          success(exhausted);
          assert.equal(
            exhausted.body.selectionStatus,
            'available_candidates_exhausted',
          );
          assert.deepEqual(exhausted.body.items, []);
          // These higher balances make the captured first 256 entirely profileless;
          // the 257th row is only a sentinel and must not be authorized or emitted.
          for (let i = 0; i < 257; i++)
            await seed(100000000000000000n + BigInt(i), false);
          // Earlier maximum remains first but is inactive, so no accepted prefix.
          const response = await read('50');
          success(response);
          assert.equal(response.body.selectionStatus, 'scan_limited');
          assert.deepEqual(response.body.items, []);
        },
      );
      await t.test(
        'migration supplies ordered indexed access at synthetic cardinality',
        async () => {
          for (let i = 0; i < 2500; i++) await seed(BigInt(i), false);
          await pool.query('ANALYZE whaleu_experience.account_states');
          await pool.query('ANALYZE whaleu_experience.baselines');
          let sql = '',
            values: unknown[] = [];
          observer!.setHook(async (event) => {
            if (/FROM whaleu_experience.account_states/.test(event.sql)) {
              sql = event.sql;
              values = event.values;
            }
          });
          try {
            success(await read('1'));
          } finally {
            observer!.setHook(null);
          }
          assert.ok(sql);
          const plan = (
            await pool.query(
              'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + sql,
              values,
            )
          ).rows[0]['QUERY PLAN'];
          assert.ok(
            JSON.stringify(plan).includes('account_states_ranking_idx'),
            JSON.stringify(plan),
          );
          t.diagnostic(
            JSON.stringify({
              syntheticCandidates: (
                await pool.query(
                  'SELECT count(*)::integer n FROM whaleu_experience.account_states',
                )
              ).rows[0].n,
              sourceRows: plan[0].Plan['Actual Rows'],
              sourceExecutionMs: plan[0]['Execution Time'],
              orderingIndex: 'account_states_ranking_idx',
            }),
          );
        },
      );
    } finally {
      observer?.restore();
      await app?.close();
      if (owns)
        for (const schema of migrationSchemaNames)
          await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      if (locked)
        await suite?.query('SELECT pg_advisory_unlock($1,$2)', [
          MIGRATION_LOCK[0],
          2,
        ]);
      suite?.release();
      if (owns)
        assert.equal(
          (
            await pool.query<{ n: number }>(
              "SELECT count(*)::integer n FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
            )
          ).rows[0]!.n,
          0,
        );
      await pool.end();
    }
  },
);
