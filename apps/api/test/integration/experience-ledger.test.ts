import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.js';
import {
  inTransaction,
  poolOptions,
  supportedPostgresVersion,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { configureHttp } from '../../src/http/http.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import { SavedRepository } from '../../src/community/saved/repository.js';
import { CommunityRepository } from '../../src/community/community.repository.js';
import { ExperienceClock } from '../../src/experience/repository.js';
import { ExperienceService } from '../../src/experience/service.js';
import { ExperienceWorker } from '../../src/experience/worker.js';
import { initializeNativeExperienceAccount } from '../../src/experience/lifecycle.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';
import {
  establishSyntheticExperienceBaseline,
  grantSyntheticTitle,
  recordSyntheticHistory,
} from '../support/experience-fixtures.js';
const hasCode = (code: string) => (e: unknown) =>
  e instanceof ApplicationError && e.code === code;
test(
  'real PostgreSQL owner experience ledger, fresh-source settlement, receipts and unknown coverage',
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
        LOG_LEVEL: 'silent',
        PG_POOL_MAX: '12',
        PG_STATEMENT_TIMEOUT_MS: '10000',
      }),
      pool = new Pool(poolOptions(config));
    let suite: PoolClient | undefined,
      app: INestApplication | undefined,
      owns = false,
      locked = false;
    let now = new Date('2026-10-08T01:00:00.000Z');
    class FixtureClock extends ExperienceClock {
      override async now(_tx: PoolClient) {
        return {
          at: new Date(now),
          day: new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10),
        };
      }
    }
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
      const module = await Test.createTestingModule({
        imports: [AppModule.register(config)],
      })
        .overrideProvider(ExperienceClock)
        .useClass(FixtureClock)
        .compile();
      app = module.createNestApplication({ logger: false });
      configureHttp(app);
      await app.init();
      const service = app.get(ExperienceService),
        worker = app.get(ExperienceWorker),
        community = app.get(CommunityRepository),
        identity = app.get(IdentityRepository);
      const space = randomUUID();
      await pool.query('CREATE SCHEMA whaleu_experience_test');
      await pool.query(
        "INSERT INTO whaleu_community.spaces(id,kind,name,is_active) VALUES($1,'global','Synthetic experience fixture',true)",
        [space],
      );
      async function actor(
        balance?: bigint,
        unknown = false,
        lastDay?: string,
        streak = 0,
      ) {
        const subject = randomUUID(),
          accessToken = mintToken('access'),
          refreshToken = mintToken('refresh');
        let accountId: string | undefined;
        if (balance !== undefined || unknown) {
          accountId = randomUUID();
          await inTransaction(pool, async (tx) => {
            await tx.query(
              'INSERT INTO whaleu_identity.accounts(id) VALUES($1)',
              [accountId],
            );
            await tx.query(
              "INSERT INTO whaleu_identity.provider_identities(provider,app_id,subject,account_id) VALUES('wechat','synthetic-experience-only',$1,$2)",
              [subject, accountId],
            );
            if (balance !== undefined)
              await establishSyntheticExperienceBaseline(tx, accountId!, {
                balance,
                lastDay: lastDay ?? null,
                streak,
              });
          });
        }
        const session = await identity.createSession(
          { provider: 'wechat', appId: 'synthetic-experience-only', subject },
          { access: hashToken(accessToken), refresh: hashToken(refreshToken) },
        );
        return { ...session, accessToken };
      }
      async function post(owner: string, enroll = true) {
        const id = randomUUID();
        await inTransaction(pool, async (tx) => {
          await tx.query(
            "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'discussion','Synthetic experience fixture','named','open')",
            [id, space, owner],
          );
          if (enroll)
            await community.event(
              `post:${id}:created`,
              'post_created',
              id,
              tx,
              {
                experienceSourceVersion: 1,
                actorAccountId: owner,
                actorAuthorMode: 'named',
                resourceAuthorMode: 'named',
              },
            );
        });
        return id;
      }
      async function remove(owner: string, id: string) {
        await inTransaction(pool, async (tx) => {
          await tx.query(
            "UPDATE whaleu_community.posts SET deleted_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=$1",
            [id],
          );
          await community.event(`post:${id}:deleted`, 'post_deleted', id, tx, {
            experienceSourceVersion: 1,
            actorAccountId: owner,
            actorAuthorMode: 'named',
            resourceAuthorMode: 'named',
          });
        });
      }
      async function like(owner: string, id: string, author: string) {
        let group = '';
        await inTransaction(pool, async (tx) => {
          const m = (
            await tx.query<{ like_id: string }>(
              'INSERT INTO whaleu_community.post_likes(post_id,account_id) VALUES($1,$2) RETURNING like_id',
              [id, owner],
            )
          ).rows[0]!;
          const event = await community.event(
            `post:like:${m.like_id}`,
            'post_liked',
            id,
            tx,
            {
              experienceSourceVersion: 1,
              actorAccountId: owner,
              actorAuthorMode: null,
              resourceAuthorMode: 'named',
              recipientAccountId: author,
              likeId: m.like_id,
            },
          );
          group = (
            await tx.query<{ id: string }>(
              'SELECT id FROM whaleu_community.reward_source_groups WHERE event_id=$1',
              [event],
            )
          ).rows[0]!.id;
        });
        return group;
      }
      async function units(owner: string) {
        return (
          await pool.query<{ unit_id: string }>(
            "SELECT unit_id FROM whaleu_experience.work WHERE beneficiary_id=$1 AND state<>'completed' ORDER BY enrollment_order,unit_id",
            [owner],
          )
        ).rows.map((r) => r.unit_id);
      }
      async function settle(owner: string) {
        const ids = await units(owner);
        const result = await worker.run({ mode: 'apply', unitIds: ids });
        assert.equal(result.failed, 0, JSON.stringify(result));
        return result;
      }
      const fresh = await actor(),
        unknown = await actor(undefined, true);
      await t.test(
        'native same-transaction baseline and ownership; existing account remains unknown',
        async () => {
          const summary = await service.summary(fresh.accessToken);
          assert.equal(summary.balance, '0');
          assert.equal(summary.level, 1);
          assert.equal(summary.stateRevision, '0');
          const appearance = await service.appearance(fresh.accessToken);
          assert.deepEqual(
            appearance.titles.map((x) => x.key),
            ['default_jingxiaoyu', 'level_1'],
          );
          assert.equal(appearance.titleKey, null);
          assert.equal(appearance.colorId, null);
          const before = (
            await pool.query('SELECT * FROM whaleu_experience.baselines')
          ).rowCount;
          assert.equal(
            (await service.summary(unknown.accessToken)).balance,
            null,
          );
          assert.equal(
            (await service.summary(unknown.accessToken)).signIn.streak,
            null,
          );
          await assert.rejects(
            service.signIn(unknown.accessToken, randomUUID()),
            hasCode('EXPERIENCE_BASELINE_UNAVAILABLE'),
          );
          await assert.rejects(
            inTransaction(pool, (tx) =>
              initializeNativeExperienceAccount(unknown.accountId, tx),
            ),
          );
          assert.equal(
            (await pool.query('SELECT * FROM whaleu_experience.baselines'))
              .rowCount,
            before,
          );
        },
      );
      await t.test(
        'unknown historical owned records and titles remain selectable without invented dates',
        async () => {
          const ids = await inTransaction(pool, async (tx) => {
            await grantSyntheticTitle(tx, unknown.accountId, 'level_29');
            return [
              await recordSyntheticHistory(tx, unknown.accountId, {
                action: 'publish',
                nominalDelta: 10n,
              }),
              await recordSyntheticHistory(tx, unknown.accountId, {
                action: 'comment',
              }),
            ];
          });
          const page = await service.recordsPage(unknown.accessToken, {
            limit: 1,
          });
          assert.equal(page.items[0]!.recordId, ids[1]);
          assert.equal(page.items[0]!.occurredAt, null);
          assert.equal(page.items[0]!.appliedDelta, null);
          assert.equal(page.coverage, 'partial');
          assert.ok(page.nextCursor);
          assert.equal(
            (
              await service.recordsPage(unknown.accessToken, {
                limit: 1,
                cursor: page.nextCursor,
              })
            ).items[0]!.recordId,
            ids[0],
          );
          await assert.rejects(
            service.recordsPage(fresh.accessToken, {
              limit: 1,
              cursor: page.nextCursor,
            }),
          );
          const chosen = await service.selectAppearance(unknown.accessToken, {
            requestId: randomUUID(),
            expectedRevision: '0',
            titleKey: 'level_29',
            colorId: 0,
          });
          assert.equal(chosen.outcome, 'applied');
          assert.equal(
            (await service.summary(unknown.accessToken)).balance,
            null,
          );
          const invalid = await service.selectAppearance(unknown.accessToken, {
            requestId: randomUUID(),
            expectedRevision: '1',
            titleKey: 'level_29',
            colorId: 25,
          });
          assert.equal(invalid.outcome, 'rejected');
        },
      );
      await t.test(
        'known actor settles independently of unknown recipient; dry-run changes nothing',
        async () => {
          const target = await post(unknown.accountId, false),
            group = await like(fresh.accountId, target, unknown.accountId);
          const before = JSON.stringify(
            (
              await pool.query(
                'SELECT * FROM whaleu_experience.work ORDER BY unit_id',
              )
            ).rows,
          );
          const dry = await worker.run({ groupIds: [group] });
          assert.equal(dry.failed, 0);
          assert.equal(
            JSON.stringify(
              (
                await pool.query(
                  'SELECT * FROM whaleu_experience.work ORDER BY unit_id',
                )
              ).rows,
            ),
            before,
          );
          const result = await worker.run({ mode: 'apply', groupIds: [group] });
          assert.equal(result.failed, 0, JSON.stringify(result));
          assert.equal(result.settled, 1);
          assert.equal(result.blockedBaseline, 1);
          assert.equal((await service.summary(fresh.accessToken)).balance, '1');
          assert.equal(
            (await service.summary(unknown.accessToken)).balance,
            null,
          );
          assert.equal(
            (await worker.run({ mode: 'apply', groupIds: [group] })).completed,
            1,
          );
          assert.equal(
            (await service.signIn(fresh.accessToken, randomUUID())).outcome,
            'awarded',
          );
          const reverseTarget = await post(fresh.accountId, false);
          const reverse = await like(
            unknown.accountId,
            reverseTarget,
            fresh.accountId,
          );
          const reverseResult = await worker.run({
            mode: 'apply',
            groupIds: [reverse],
          });
          assert.equal(reverseResult.failed, 0);
          assert.equal(reverseResult.settled, 1);
          assert.equal((await service.summary(fresh.accessToken)).balance, '5');
          assert.equal(
            (await service.summary(unknown.accessToken)).balance,
            null,
          );
        },
      );
      await t.test(
        'source predecessor ordering, quota refund and nominal floor conservation',
        async () => {
          const owner = await actor(2n),
            first = await post(owner.accountId);
          await remove(owner.accountId, first);
          await post(owner.accountId);
          const queued = await units(owner.accountId);
          assert.equal(queued.length, 3);
          assert.equal(
            (await worker.run({ mode: 'apply', unitIds: [queued[1]!] }))
              .blockedPredecessor,
            1,
          );
          await assert.rejects(
            service.signIn(owner.accessToken, randomUUID()),
            hasCode('EXPERIENCE_PENDING'),
          );
          const result = await settle(owner.accountId);
          assert.equal(result.settled, 3);
          assert.equal(
            (await service.summary(owner.accessToken)).balance,
            '12',
          );
          const bucket = (await service.summary(owner.accessToken)).tasks.find(
            (x) => x.action === 'publish',
          )!;
          assert.equal(bucket.rewardedCount, 1);
          assert.equal(bucket.refundCount, 1);
          assert.equal(bucket.grossPositiveAwarded, '20');
          const records = await service.recordsPage(owner.accessToken, {
            limit: 20,
          });
          assert.deepEqual(
            records.items.map((r) => r.appliedDelta),
            ['10', '-10', '10'],
          );
          for (const balance of [20n, 2n, 0n]) {
            const who = await actor(balance),
              old = await post(who.accountId, false);
            await remove(who.accountId, old);
            await settle(who.accountId);
            const record = (
              await service.recordsPage(who.accessToken, { limit: 20 })
            ).items[0]!;
            assert.equal(record.nominalDelta, '-10');
            assert.equal(
              record.appliedDelta,
              (balance < 10n ? -balance : -10n).toString(),
            );
          }
        },
      );
      await t.test(
        'parallel duplicate workers preserve final slot and capped terminal day',
        async () => {
          const who = await actor();
          for (let i = 0; i < 11; i++)
            await like(
              who.accountId,
              await post(unknown.accountId, false),
              unknown.accountId,
            );
          const selected = await units(who.accountId);
          const outcomes = await Promise.all([
            worker.run({ mode: 'apply', unitIds: selected }),
            worker.run({ mode: 'apply', unitIds: selected }),
          ]);
          assert.equal(
            outcomes.reduce((n, r) => n + r.failed, 0),
            0,
          );
          assert.equal((await service.summary(who.accessToken)).balance, '10');
          const rows = (
            await pool.query<{
              outcome: string;
              reward_day: string;
              applied_delta: string;
            }>(
              'SELECT outcome,reward_day::text,applied_delta::text FROM whaleu_experience.settlements WHERE owner_id=$1 ORDER BY state_revision',
              [who.accountId],
            )
          ).rows;
          assert.equal(rows.length, 11);
          assert.equal(rows.filter((r) => r.outcome === 'capped').length, 1);
          now = new Date('2026-10-08T16:00:00.000Z');
          assert.equal(
            (await worker.run({ mode: 'apply', unitIds: [selected.at(-1)!] }))
              .completed,
            1,
          );
          assert.deepEqual(
            (
              await pool.query(
                'SELECT outcome,reward_day::text,applied_delta::text FROM whaleu_experience.settlements WHERE owner_id=$1 ORDER BY state_revision',
                [who.accountId],
              )
            ).rows,
            rows,
          );
          now = new Date('2026-10-08T01:00:00.000Z');
        },
      );
      await t.test(
        'failure after Saved acknowledgement rolls back every beneficiary effect; retry is exact',
        async () => {
          const who = await actor(14n),
            target = await post(unknown.accountId, false),
            saved = app!.get(SavedRepository);
          let obligation = '';
          await inTransaction(pool, async (tx) => {
            const changed = await saved.setSaved(
              who.accountId,
              target,
              true,
              tx,
            );
            assert.ok(changed);
            const ids = await saved.obligations(
              changed.epochId,
              who.accountId,
              unknown.accountId,
              true,
              tx,
            );
            obligation = (
              await tx.query<{ id: string }>(
                "SELECT id FROM whaleu_community.saved_obligations WHERE epoch_id=$1 AND action='saver_reward'",
                [changed.epochId],
              )
            ).rows[0]!.id;
            await community.event(
              `save:${changed.epochId}:started`,
              'post_saved',
              changed.epochId,
              tx,
              {
                experienceSourceVersion: 1,
                actorAccountId: who.accountId,
                actorAuthorMode: null,
                resourceAuthorMode: 'named',
                rewardObligationIds: ids,
                postId: target,
                saveEpochId: changed.epochId,
                sequence: changed.sequence,
                occurredAt: changed.at.toISOString(),
                desired: true,
              },
            );
          });
          const selected = await units(who.accountId);
          await pool.query(
            "CREATE FUNCTION whaleu_experience_test.fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic rollback injection'; END $$",
          );
          await pool.query(
            `CREATE CONSTRAINT TRIGGER synthetic_settlement_failure AFTER UPDATE ON whaleu_experience.work DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.beneficiary_id='${who.accountId}'::uuid AND NEW.state='completed') EXECUTE FUNCTION whaleu_experience_test.fail_commit()`,
          );
          const failed = await worker.run({ mode: 'apply', unitIds: selected });
          assert.equal(failed.failed, 1);
          assert.equal((await service.summary(who.accessToken)).balance, '14');
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_experience.settlements WHERE owner_id=$1',
                [who.accountId],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_experience.daily_buckets WHERE owner_id=$1',
                [who.accountId],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (await service.appearance(who.accessToken)).titles.length,
            0,
          );
          assert.equal(
            (await service.unlocks(who.accessToken)).items.length,
            0,
          );
          assert.equal(
            (
              await pool.query<{ status: string }>(
                'SELECT status FROM whaleu_community.saved_obligations WHERE id=$1',
                [obligation],
              )
            ).rows[0]!.status,
            'pending',
          );
          await pool.query(
            'DROP TRIGGER synthetic_settlement_failure ON whaleu_experience.work',
          );
          assert.equal(
            (await worker.run({ mode: 'apply', unitIds: selected })).settled,
            1,
          );
          assert.equal((await service.summary(who.accessToken)).balance, '15');
          assert.equal(
            (
              await pool.query<{ status: string }>(
                'SELECT status FROM whaleu_community.saved_obligations WHERE id=$1',
                [obligation],
              )
            ).rows[0]!.status,
            'completed',
          );
          assert.equal(
            (await service.unlocks(who.accessToken)).items.length,
            1,
          );
          assert.equal(
            (await worker.run({ mode: 'apply', unitIds: selected })).completed,
            1,
          );
        },
      );
      await t.test(
        'SQL independently protects baseline state, quota and strict receipt projections',
        async () => {
          await assert.rejects(
            pool.query(
              'DELETE FROM whaleu_experience.account_states WHERE owner_id=$1',
              [fresh.accountId],
            ),
          );
          await assert.rejects(
            pool.query(
              "UPDATE whaleu_experience.daily_buckets SET rewarded_count=0 WHERE owner_id=$1 AND action='like_save'",
              [fresh.accountId],
            ),
          );
          const id = randomUUID();
          await assert.rejects(
            pool.query(
              "INSERT INTO whaleu_experience.requests(owner_id,request_id,operation,intent_hash,receipt) VALUES($1,$2,'sign_in',$3,$4::jsonb)",
              [
                fresh.accountId,
                id,
                'a'.repeat(64),
                JSON.stringify({
                  requestId: id,
                  operation: 'sign_in',
                  outcome: 'awarded',
                  appliedDelta: 2,
                  balance: 2,
                  stateRevision: 1,
                }),
              ],
            ),
          );
        },
      );
      await t.test(
        'equipped high color survives an actual below-threshold downgrade and title edit',
        async () => {
          const who = await actor(14n),
            id = await post(who.accountId);
          await settle(who.accountId);
          await service.selectAppearance(who.accessToken, {
            requestId: randomUUID(),
            expectedRevision: '0',
            titleKey: 'level_1',
            colorId: 11,
          });
          await remove(who.accountId, id);
          await settle(who.accountId);
          const view = await service.appearance(who.accessToken);
          assert.equal(view.colorId, 11);
          assert.ok(!view.eligibleColorIds.includes(11));
          const retained = await service.selectAppearance(who.accessToken, {
            requestId: randomUUID(),
            expectedRevision: '1',
            titleKey: null,
            colorId: 11,
          });
          assert.equal(retained.outcome, 'applied');
          const locked = await service.selectAppearance(who.accessToken, {
            requestId: randomUUID(),
            expectedRevision: '2',
            titleKey: null,
            colorId: 12,
          });
          assert.equal(locked.outcome, 'rejected');
        },
      );
      await t.test(
        'daily sign-in concurrency and request replay across Shanghai midnight',
        async () => {
          const who = await actor(),
            id = randomUUID();
          const concurrent = await Promise.all([
            service.signIn(who.accessToken, id),
            service.signIn(who.accessToken, randomUUID()),
          ]);
          assert.deepEqual(concurrent.map((x) => x.outcome).sort(), [
            'already_signed_in',
            'awarded',
          ]);
          assert.equal((await service.summary(who.accessToken)).balance, '2');
          const receipt = await service.receipt(who.accessToken, id);
          now = new Date('2026-10-08T16:00:00.000Z');
          assert.deepEqual(await service.signIn(who.accessToken, id), receipt);
          const next = await service.signIn(who.accessToken, randomUUID());
          assert.equal(next.operation, 'sign_in');
          if (next.operation === 'sign_in') {
            assert.equal(next.rewardDay, '2026-10-09');
            assert.equal(next.appliedDelta, '4');
          }
          const locked = await pool.connect();
          await locked.query('BEGIN');
          await locked.query(
            'SELECT owner_id FROM whaleu_experience.owners WHERE owner_id=$1 FOR UPDATE',
            [who.accountId],
          );
          const waiting = service.signIn(who.accessToken, randomUUID());
          await sleep(20);
          now = new Date('2026-10-09T16:00:00.000Z');
          await locked.query('COMMIT');
          locked.release();
          const result = await waiting;
          assert.equal(result.operation, 'sign_in');
          if (result.operation === 'sign_in') {
            assert.equal(result.rewardDay, '2026-10-10');
            assert.equal(result.appliedDelta, '6');
          }
          now = new Date('2026-10-08T01:00:00.000Z');
        },
      );
      await t.test(
        'earned title progression, downgrade retention and durable unlock acknowledgement',
        async () => {
          const who = await actor(39n),
            p = await post(who.accountId);
          await settle(who.accountId);
          const a = await service.appearance(who.accessToken);
          assert.ok(a.titles.some((x) => x.key === 'level_1'));
          assert.ok(a.titles.some((x) => x.key === 'level_3'));
          const intent = {
            requestId: randomUUID(),
            expectedRevision: '0',
            titleKey: 'level_3',
            colorId: 11,
          };
          const selected = await service.selectAppearance(
            who.accessToken,
            intent,
          );
          assert.equal(selected.outcome, 'applied');
          assert.deepEqual(
            await service.selectAppearance(who.accessToken, intent),
            selected,
          );
          const notices = await service.unlocks(who.accessToken);
          assert.equal(notices.items.length, 1);
          await service.acknowledge(
            who.accessToken,
            notices.items[0]!.noticeId,
          );
          assert.equal(
            (await service.unlocks(who.accessToken)).items.length,
            0,
          );
          await service.acknowledge(
            who.accessToken,
            notices.items[0]!.noticeId,
          );
          await remove(who.accountId, p);
          await settle(who.accountId);
          assert.equal(
            (await service.appearance(who.accessToken)).titleKey,
            'level_3',
          );
          assert.equal((await service.appearance(who.accessToken)).colorId, 11);
          const stale = await service.selectAppearance(who.accessToken, {
            requestId: randomUUID(),
            expectedRevision: '0',
            titleKey: null,
            colorId: null,
          });
          assert.equal(stale.outcome, 'rejected');
          const req = randomUUID();
          const rejection = await service.selectAppearance(who.accessToken, {
            requestId: req,
            expectedRevision: '1',
            titleKey: 'level_29',
            colorId: null,
          });
          assert.equal(rejection.outcome, 'rejected');
          assert.deepEqual(
            await service.receipt(who.accessToken, req),
            rejection,
          );
        },
      );
      await t.test(
        'strict HTTP owner authorization and terminal rejection receipts',
        async () => {
          await request(app!.getHttpServer())
            .get('/v1/me/experience')
            .expect(401);
          await request(app!.getHttpServer())
            .post('/v1/me/experience/sign-in')
            .set('Authorization', `Bearer ${fresh.accessToken}`)
            .send({ requestId: randomUUID(), points: 100 })
            .expect(400);
          const response = await request(app!.getHttpServer())
            .put('/v1/me/experience/appearance')
            .set('Authorization', `Bearer ${fresh.accessToken}`)
            .send({
              requestId: randomUUID(),
              expectedRevision: '0',
              titleKey: 'level_29',
              colorId: null,
            })
            .expect(200);
          assert.equal(response.body.outcome, 'rejected');
        },
      );
    } finally {
      await app?.close();
      if (owns)
        for (const schema of [
          'whaleu_experience_test',
          ...migrationSchemaNames,
        ])
          await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      if (locked)
        await suite?.query('SELECT pg_advisory_unlock($1,$2)', [
          MIGRATION_LOCK[0],
          2,
        ]);
      suite?.release();
      await pool.end();
    }
  },
);
