import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.js';
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
import { configureHttp } from '../../src/http/http.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { IDENTITY_PROVIDER } from '../../src/identity/contracts.js';
import { IdentityService } from '../../src/identity/identity.service.js';
import {
  COMMUNITY_AUTHORIZATION,
  COMMUNITY_BASE_VISIBILITY,
  CONTENT_PUBLICATION_GATE,
  MEDIA_ATTACHMENT,
} from '../../src/community/community-policy.js';
import { PublicationService } from '../../src/community/publication.service.js';
import { ReplyPublicationService } from '../../src/community/discussion/publication.service.js';
import { DeletionService } from '../../src/community/deletion.service.js';
import { CommunityReportTargetFacade } from '../../src/community/report-target.facade.js';
import { ReportingService } from '../../src/safety/reporting/service.js';
import type {
  ReportReceipt,
  ReportTarget,
} from '../../src/safety/reporting/contracts.js';
import { JuryWorker } from '../../src/safety/reporting/worker.js';
import { SystemNoticesService } from '../../src/notifications/system-notices/service.js';
import { NamedBlockService } from '../../src/safety/service.js';
import { hashToken } from '../../src/identity/tokens.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';
import {
  FixtureAuthorization,
  FixtureVisibility,
  FixtureContent,
  FixtureMedia,
  fixtureSchema,
  grant,
  verified,
  approve,
  approveReply,
} from '../support/community-fixtures.js';
import {
  setSyntheticSnapshot,
  syntheticAssertion,
} from '../support/verification-fixtures.js';
const code = (expected: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === expected;
function accepted(result: ReportReceipt) {
  assert.equal(result.outcome, 'accepted', JSON.stringify(result));
  return result;
}
function rejected(result: ReportReceipt, expected: string) {
  assert.equal(result.outcome, 'rejected', JSON.stringify(result));
  if (result.outcome === 'rejected') assert.equal(result.code, expected);
}
test(
  'real PostgreSQL reporting, immutable post juries, removal, due recovery and notice ownership',
  { timeout: 120000 },
  async (t) => {
    const urlString = process.env['TEST_DATABASE_URL'];
    assert.ok(urlString, 'Use disposable loopback whaleu_test');
    const url = new URL(urlString);
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: urlString,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '20',
      SAFETY_JURY_PROCESSING: 'manual_only',
      SAFETY_JURY_INTERVAL_MS: '20',
      COMMUNITY_UPDATES_PROCESSING: 'disabled',
    });
    const pool = new Pool(poolOptions(config));
    let suite: PoolClient | undefined,
      app: INestApplication | undefined,
      automatic: INestApplication | undefined,
      owns = false,
      locked = false;
    const schemas = ['whaleu_community_test', ...migrationSchemaNames];
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
            await pool.query<{ v: number }>(
              "SELECT current_setting('server_version_num')::integer AS v",
            )
          ).rows[0]!.v,
        ),
      );
      assert.equal(
        (
          await pool.query(
            'SELECT 1 FROM pg_namespace WHERE nspname=ANY($1::text[])',
            [schemas],
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
      await fixtureSchema(pool);
      await pool.query(`CREATE TABLE whaleu_community_test.jury_clocks(post_id uuid PRIMARY KEY,deadline timestamptz NOT NULL);
 CREATE FUNCTION whaleu_community_test.jury_clock() RETURNS trigger LANGUAGE plpgsql AS $$ DECLARE bound timestamptz; BEGIN SELECT deadline INTO bound FROM whaleu_community_test.jury_clocks WHERE post_id=NEW.post_id; IF FOUND THEN NEW.deadline:=date_trunc('milliseconds',bound);NEW.created_at:=NEW.deadline-interval '24 hours';END IF; RETURN NEW; END $$;
 CREATE TRIGGER synthetic_jury_clock BEFORE INSERT ON whaleu_safety.post_juries FOR EACH ROW EXECUTE FUNCTION whaleu_community_test.jury_clock();`);
      const provider = {
        exchange: async (subject: string) => ({
          provider: 'wechat',
          appId: 'synthetic-reporting-only',
          subject,
        }),
      };
      async function application(
        mode: 'manual_only' | 'automatic' | 'disabled',
      ) {
        const module = await Test.createTestingModule({
          imports: [
            AppModule.register({ ...config, SAFETY_JURY_PROCESSING: mode }),
          ],
        })
          .overrideProvider(IDENTITY_PROVIDER)
          .useValue(provider)
          .overrideProvider(COMMUNITY_AUTHORIZATION)
          .useValue(new FixtureAuthorization())
          .overrideProvider(COMMUNITY_BASE_VISIBILITY)
          .useValue(new FixtureVisibility())
          .overrideProvider(CONTENT_PUBLICATION_GATE)
          .useValue(new FixtureContent())
          .overrideProvider(MEDIA_ATTACHMENT)
          .useValue(new FixtureMedia())
          .compile();
        const next = module.createNestApplication({ logger: false });
        configureHttp(next);
        await next.init();
        return next;
      }
      app = await application('manual_only');
      const identity = app.get(IdentityService),
        reports = app.get(ReportingService),
        publications = app.get(PublicationService),
        notices = app.get(SystemNoticesService),
        worker = app.get(JuryWorker),
        database = app.get(DatabaseService);
      const region = randomUUID(),
        space = randomUUID(),
        issuer = randomUUID(),
        otherRegion = randomUUID(),
        globalSpace = randomUUID();
      await pool.query(
        "INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES($1,'Synthetic one',true),($2,'Synthetic two',true)",
        [region, otherRegion],
      );
      await pool.query(
        "INSERT INTO whaleu_campus.institutions(id,name) VALUES($1,'Synthetic institution'),($2,'Other synthetic institution')",
        [issuer, otherRegion],
      );
      await pool.query(
        "INSERT INTO whaleu_community.spaces(id,kind,operating_region_id,name,is_active) VALUES($1,'regional',$2,'Synthetic',true),($3,'global',NULL,'Synthetic global',true)",
        [space, region, globalSpace],
      );
      async function actor() {
        const a = await identity.login(randomUUID());
        await setSyntheticSnapshot(pool, a.accountId, [
          syntheticAssertion(a.accountId, issuer, 'phone'),
          syntheticAssertion(a.accountId, issuer, 'affiliation'),
        ]);
        await grant(pool, a.accountId, space, verified(region));
        await grant(pool, a.accountId, globalSpace, verified(region));
        await pool.query(
          "INSERT INTO whaleu_profile.profiles(account_id,nickname)VALUES($1,'Synthetic')",
          [a.accountId],
        );
        return a;
      }
      type Actor = Awaited<ReturnType<typeof actor>>;
      async function post(
        owner: Actor,
        mode: 'named' | 'anonymous' = 'named',
        inSpace = space,
      ) {
        const text = `Synthetic reporting ${randomUUID()}`;
        await approve(pool, owner.accountId, text);
        const r = await publications.post(owner.accessToken, {
          clientRequestId: randomUUID(),
          spaceId: inSpace,
          category: 'discussion',
          text,
          authorMode: mode,
          commentsPolicy: 'open',
          imageAssetIds: [],
          component: { kind: 'none' },
        });
        assert.equal(r.outcome, 'created', JSON.stringify(r));
        if (r.outcome !== 'created') throw new Error();
        return r.resourceId;
      }
      async function root(owner: Actor, postId: string) {
        const text = `Synthetic root ${randomUUID()}`;
        await approve(pool, owner.accountId, text, 'publish_comment');
        const r = await publications.comment(owner.accessToken, postId, {
          clientRequestId: randomUUID(),
          text,
          authorMode: 'named',
          imageAssetIds: [],
        });
        assert.equal(r.outcome, 'created', JSON.stringify(r));
        if (r.outcome !== 'created') throw new Error();
        return r.resourceId;
      }
      async function reply(owner: Actor, postId: string, rootId: string) {
        const body = {
          clientRequestId: randomUUID(),
          text: 'Synthetic reply',
          authorMode: 'named' as const,
          imageAssetIds: [],
          targetReplyId: null,
        };
        const parent = (
          await pool.query<{
            account_id: string;
            author_mode: 'named' | 'anonymous';
          }>(
            'SELECT account_id,author_mode FROM whaleu_community.posts WHERE id=$1',
            [postId],
          )
        ).rows[0]!;
        await approveReply(
          pool,
          owner.accountId,
          postId,
          rootId,
          body,
          parent.account_id === owner.accountId
            ? parent.author_mode
            : body.authorMode,
        );
        const r = await app!
          .get(ReplyPublicationService)
          .create(owner.accessToken, rootId, body);
        assert.equal(r.outcome, 'created', JSON.stringify(r));
        if (r.outcome !== 'created') throw new Error();
        return r.resourceId;
      }
      const command = (id: string, kind: ReportTarget['kind'] = 'post') => ({
        clientRequestId: randomUUID(),
        target: { kind, id },
      });
      async function report(
        a: Actor,
        id: string,
        kind: ReportTarget['kind'] = 'post',
      ) {
        return reports.report(a.accessToken, command(id, kind));
      }
      async function jury(postId: string) {
        return (
          await pool.query<{ id: string; state: string; deadline: Date }>(
            'SELECT id,state,deadline FROM whaleu_safety.post_juries WHERE post_id=$1',
            [postId],
          )
        ).rows[0]!;
      }
      async function open(postId: string) {
        const actors = await Promise.all(
          Array.from({ length: 5 }, () => actor()),
        );
        await Promise.all(actors.map((a) => report(a, postId).then(accepted)));
        return { jury: await jury(postId), reporters: actors };
      }
      async function ballot(
        a: Actor,
        p: string,
        j: string,
        vote: 'keep' | 'remove',
      ) {
        return reports.vote(a.accessToken, {
          clientRequestId: randomUUID(),
          postId: p,
          juryId: j,
          vote,
        });
      }
      async function privilege(
        a: Actor,
        role: 'developer' | 'super_admin' | 'school_admin',
        r: string | null = null,
        expires: Date | null = null,
      ) {
        const id = randomUUID();
        await pool.query(
          "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference,valid_from,expires_at) VALUES($1,$2,$3,$4,$2,$5,clock_timestamp()-interval '1 second',$6)",
          [id, a.accountId, role, r, 'synthetic-test-only', expires],
        );
        return id;
      }
      async function due(p: string, ms = -1) {
        await pool.query(
          "INSERT INTO whaleu_community_test.jury_clocks(post_id,deadline) VALUES($1,clock_timestamp()+($2::text||' milliseconds')::interval)",
          [p, ms],
        );
      }
      async function eventually(check: () => Promise<boolean>) {
        const end = Date.now() + 5000;
        while (!(await check())) {
          assert.ok(Date.now() < end, 'Expected eventual settlement');
          await sleep(15);
        }
      }
      await t.test(
        'native origin is atomic, no old-target coverage inference and strict HTTP keys',
        async () => {
          const a = await actor(),
            b = await actor(),
            p = await post(b);
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.report_origins WHERE target_id=$1',
                [p],
              )
            ).rowCount,
            1,
          );
          const old = randomUUID();
          await pool.query(
            "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'discussion','Synthetic old','named','open')",
            [old, space, b.accountId],
          );
          await assert.rejects(
            reports.progress(a.accessToken, { kind: 'post', id: old }),
            code('SAFETY_UNAVAILABLE'),
          );
          await assert.rejects(report(a, old), code('SAFETY_UNAVAILABLE'));
          await request(app!.getHttpServer())
            .post('/v1/me/safety/reports')
            .set('Authorization', `Bearer ${a.accessToken}`)
            .send({ ...command(p), weight: 5 })
            .expect(400);
          await request(app!.getHttpServer())
            .get(`/v1/me/safety/report-progress/post/${p}?x=1`)
            .set('Authorization', `Bearer ${a.accessToken}`)
            .expect(400);
        },
      );
      await t.test(
        'independent phone+affiliation, no student number/publication gate; self all kinds',
        async () => {
          const a = await actor(),
            owner = await actor(),
            p = await post(owner, 'anonymous'),
            r = await root(owner, p),
            q = await reply(owner, p, r);
          await pool.query(
            'DELETE FROM whaleu_community_test.grants WHERE account_id=$1',
            [a.accountId],
          );
          accepted(await report(a, p));
          for (const [kind, id] of [
            ['post', p],
            ['comment', r],
            ['reply', q],
          ] as const)
            rejected(await report(owner, id, kind), 'REPORT_SELF_NOT_ALLOWED');
          const b = await actor();
          await setSyntheticSnapshot(pool, b.accountId, [
            syntheticAssertion(b.accountId, issuer, 'phone'),
            syntheticAssertion(b.accountId, issuer, 'affiliation'),
            syntheticAssertion(b.accountId, issuer, 'student_number', {
              issuer_institution_id: otherRegion,
              source_issuer_institution_id: otherRegion,
            }),
          ]);
          accepted(await report(b, p));
          const c = await actor();
          await setSyntheticSnapshot(pool, c.accountId, [
            syntheticAssertion(c.accountId, issuer, 'phone', {
              assertion_state: 'unverified',
            }),
            syntheticAssertion(c.accountId, issuer, 'affiliation'),
          ]);
          rejected(await report(c, p), 'PHONE_VERIFICATION_REQUIRED');
          assert.equal(
            (await reports.progress(c.accessToken, { kind: 'post', id: p }))
              .reportCount,
            2,
          );
        },
      );
      await t.test(
        'five concurrent ordinary reports create exactly one jury/work; duplicate immutable recovery',
        async () => {
          const owner = await actor(),
            p = await post(owner),
            actors = await Promise.all(
              Array.from({ length: 5 }, () => actor()),
            ),
            body = command(p);
          const first = accepted(
            await reports.report(actors[0]!.accessToken, body),
          );
          await Promise.all(
            actors.slice(1).map((a) => report(a, p).then(accepted)),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_safety.post_juries WHERE post_id=$1',
                [p],
              )
            ).rowCount,
            1,
          );
          const status = await reports.progress(owner.accessToken, {
            kind: 'post',
            id: p,
          });
          assert.equal(status.reportCount, 5);
          assert.equal(status.kind === 'post' && status.effectiveWeight, 5);
          assert.deepEqual(
            await reports.report(actors[0]!.accessToken, body),
            first,
          );
          rejected(await report(actors[0]!, p), 'REPORT_ALREADY_REPORTED');
          rejected(await report(await actor(), p), 'REPORTING_CLOSED');
          await assert.rejects(
            reports.report(actors[0]!.accessToken, {
              ...body,
              target: { kind: 'post', id: randomUUID() },
            }),
            code('REQUEST_CONFLICT'),
          );
          await setSyntheticSnapshot(pool, actors[0]!.accountId, []);
          assert.deepEqual(
            await reports.receipt(actors[0]!.accessToken, body.clientRequestId),
            first,
          );
        },
      );
      await t.test(
        'real scoped/global grant weighting frozen; ambiguous scoped global/related remains unavailable',
        async () => {
          const owner = await actor();
          for (const role of [
            'school_admin',
            'super_admin',
            'developer',
          ] as const) {
            const a = await actor(),
              p = await post(owner);
            const gid = await privilege(
              a,
              role,
              role === 'school_admin' ? region : null,
            );
            accepted(await report(a, p));
            const s = await reports.progress(owner.accessToken, {
              kind: 'post',
              id: p,
            });
            assert.equal(s.reportCount, 1);
            assert.equal(s.kind === 'post' && s.effectiveWeight, 5);
            await pool.query(
              'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
              [gid],
            );
            assert.equal(
              (
                await pool.query<{ weight: number }>(
                  'SELECT weight FROM whaleu_safety.reports WHERE account_id=$1',
                  [a.accountId],
                )
              ).rows[0]!.weight,
              5,
            );
          }
          const scoped = await actor();
          await privilege(scoped, 'school_admin', otherRegion);
          for (const p of [
            await post(owner),
            await post(owner, 'named', globalSpace),
          ]) {
            await assert.rejects(
              report(scoped, p),
              code('REPORT_SCOPE_UNAVAILABLE'),
            );
            const s = await reports.progress(scoped.accessToken, {
              kind: 'post',
              id: p,
            });
            assert.equal(s.reportCapability.status, 'unavailable');
            assert.equal(s.reportCount, 0);
            accepted(await report(await actor(), p));
          }
        },
      );
      await t.test(
        'anonymous owner and reporters cannot vote; six remove atomic notice and minimal receipt survives',
        async () => {
          const owner = await actor(),
            p = await post(owner, 'anonymous'),
            { jury: j, reporters } = await open(p);
          rejected(await ballot(owner, p, j.id, 'remove'), 'JURY_INELIGIBLE');
          rejected(
            await ballot(reporters[0]!, p, j.id, 'keep'),
            'JURY_INELIGIBLE',
          );
          const jurors = await Promise.all(
            Array.from({ length: 6 }, () => actor()),
          );
          const body = {
            clientRequestId: randomUUID(),
            postId: p,
            juryId: j.id,
            vote: 'remove' as const,
          };
          const first = accepted(
            await reports.vote(jurors[0]!.accessToken, body),
          );
          rejected(
            await ballot(jurors[0]!, p, j.id, 'keep'),
            'JURY_ALREADY_VOTED',
          );
          await Promise.all(
            jurors
              .slice(1)
              .map((a) => ballot(a, p, j.id, 'remove').then(accepted)),
          );
          assert.equal((await jury(p)).state, 'removed');
          await assert.rejects(
            reports.progress(reporters[0]!.accessToken, {
              kind: 'post',
              id: p,
            }),
            code('REPORT_TARGET_UNAVAILABLE'),
          );
          assert.deepEqual(
            await reports.vote(jurors[0]!.accessToken, body),
            first,
          );
          const page = await notices.list(owner.accessToken, { limit: 20 });
          assert.equal(page.items.length, 1);
          assert.equal(page.items[0]!.removeVotes, 6);
          assert.equal(
            (await notices.list(jurors[0]!.accessToken, { limit: 20 })).items
              .length,
            0,
          );
          assert.deepEqual(
            await notices.markRead(owner.accessToken, page.items[0]!.noticeId),
            await notices.markRead(owner.accessToken, page.items[0]!.noticeId),
          );
          await assert.rejects(
            notices.markRead(jurors[0]!.accessToken, page.items[0]!.noticeId),
            code('NOTICE_NOT_FOUND'),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_safety.account_heads WHERE account_id=$1 AND actions_allowed',
                [owner.accountId],
              )
            ).rowCount,
            1,
          );
        },
      );
      await t.test(
        'six keep never reopens reporting, maximum eleven and no notice',
        async () => {
          const owner = await actor(),
            p = await post(owner),
            { jury: j } = await open(p);
          const voters = await Promise.all(
            Array.from({ length: 12 }, () => actor()),
          );
          for (const a of voters.slice(0, 5))
            accepted(await ballot(a, p, j.id, 'remove'));
          for (const a of voters.slice(5, 11))
            accepted(await ballot(a, p, j.id, 'keep'));
          rejected(await ballot(voters[11]!, p, j.id, 'keep'), 'JURY_CLOSED');
          assert.equal((await jury(p)).state, 'kept');
          rejected(await report(await actor(), p), 'REPORTING_CLOSED');
          assert.equal(
            (await notices.list(owner.accessToken, { limit: 20 })).items.length,
            0,
          );
        },
      );
      await t.test(
        'root and reply tenth reports remove atomically, retain one disabled review and release pin',
        async () => {
          const owner = await actor(),
            p = await post(owner),
            r = await root(owner, p),
            q = await reply(owner, p, r);
          const actors = await Promise.all(
            Array.from({ length: 10 }, () => actor()),
          );
          for (const a of actors.slice(0, 9))
            accepted(await report(a, q, 'reply'));
          accepted(await report(actors[9]!, q, 'reply'));
          await assert.rejects(
            reports.progress(owner.accessToken, { kind: 'reply', id: q }),
            code('REPORT_TARGET_UNAVAILABLE'),
          );
          const child = await reply(owner, p, r);
          await pool.query(
            'INSERT INTO whaleu_community.comment_pins(post_id,comment_id)VALUES($1,$2)',
            [p, r],
          );
          await Promise.all(
            actors.map((a) => report(a, r, 'comment').then(accepted)),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.comment_pins WHERE post_id=$1',
                [p],
              )
            ).rowCount,
            0,
          );
          await assert.rejects(
            reports.progress(owner.accessToken, { kind: 'reply', id: child }),
            code('REPORT_TARGET_UNAVAILABLE'),
          );
          const obligations = (
            await pool.query<{ status: string; attempts: number }>(
              'SELECT o.status,o.attempts FROM whaleu_safety.review_obligations o JOIN whaleu_safety.report_cases c ON c.id=o.case_id WHERE c.post_id=$1',
              [p],
            )
          ).rows;
          assert.equal(obligations.length, 2);
          assert.ok(
            obligations.every(
              (x) => x.status === 'provider_disabled' && x.attempts === 0,
            ),
          );
        },
      );
      await t.test(
        'deadline zero keeps; automatic restart and concurrent workers remove exactly once; independent delete supersedes',
        async () => {
          const owner = await actor(),
            p = await post(owner);
          await due(p);
          const opened = await open(p);
          const status = await reports.progress(owner.accessToken, {
            kind: 'post',
            id: p,
          });
          assert.equal(
            status.kind === 'post' && status.jury?.state,
            'settlement_pending',
          );
          automatic = await application('automatic');
          await eventually(async () => (await jury(p)).state === 'kept');
          await automatic.close();
          automatic = undefined;
          const p2 = await post(owner);
          await due(p2, 1200);
          const { jury: j } = await open(p2);
          accepted(await ballot(await actor(), p2, j.id, 'remove'));
          await sleep(Math.max(0, j.deadline.getTime() - Date.now() + 20));
          const results = await Promise.all([
            worker.run({ mode: 'apply', juryIds: [j.id] }),
            worker.run({ mode: 'apply', juryIds: [j.id] }),
          ]);
          assert.equal(
            results.reduce((n, x) => n + x.failed, 0),
            0,
          );
          assert.equal(
            (await notices.list(owner.accessToken, { limit: 20 })).items.length,
            1,
          );
          const p3 = await post(owner);
          await due(p3);
          const { jury: j3 } = await open(p3);
          await app!.get(DeletionService).post(owner.accessToken, p3);
          await worker.run({ mode: 'apply', juryIds: [j3.id] });
          assert.equal((await jury(p3)).state, 'superseded');
          assert.equal(
            (await notices.list(owner.accessToken, { limit: 20 })).items.length,
            1,
          );
          assert.equal(opened.jury.id.length, 36);
        },
      );
      await t.test(
        'changed version retains unresolved durable work without removing or pretending keep',
        async () => {
          const owner = await actor(),
            p = await post(owner);
          await due(p);
          const { jury: j } = await open(p);
          await pool.query(
            "UPDATE whaleu_community.posts SET text='Synthetic changed revision' WHERE id=$1",
            [p],
          );
          const result = await worker.run({ mode: 'apply', juryIds: [j.id] });
          assert.equal(result.changed, 1);
          assert.equal((await jury(p)).state, 'pending');
          const work = (
            await pool.query<{
              state: string;
              error_code: string;
              attempts: number;
            }>(
              'SELECT state,error_code,attempts FROM whaleu_safety.jury_work WHERE jury_id=$1',
              [j.id],
            )
          ).rows[0]!;
          assert.deepEqual(work, {
            state: 'pending',
            error_code: 'content_version_changed',
            attempts: 1,
          });
        },
      );
      await t.test(
        'anonymous reports are invariant to hidden owner block pairs; named visibility loses counts',
        async () => {
          const owner = await actor(),
            a = await actor(),
            named = await post(owner),
            anonymous = await post(owner, 'anonymous'),
            own = await post(a);
          accepted(await report(a, named));
          accepted(
            await app!
              .get(NamedBlockService)
              .block(owner.accessToken, {
                clientRequestId: randomUUID(),
                source: { kind: 'post', id: own },
                blocked: true,
              })
              .then(
                (r) =>
                  ({
                    requestId: r.receipt.requestId,
                    operation: 'report',
                    outcome: 'accepted',
                    receiptId: randomUUID(),
                  }) as ReportReceipt,
              ),
          );
          await assert.rejects(
            reports.progress(a.accessToken, { kind: 'post', id: named }),
            code('REPORT_TARGET_UNAVAILABLE'),
          );
          accepted(await report(a, anonymous));
          assert.equal(
            (
              await reports.progress(a.accessToken, {
                kind: 'post',
                id: anonymous,
              })
            ).reportCount,
            1,
          );
        },
      );
      await t.test(
        'final ballot deadline crossed by notice write rolls back ballot/removal/notice and receipt',
        async () => {
          const owner = await actor(),
            p = await post(owner);
          await due(p, 1500);
          const { jury: j } = await open(p);
          const voters = await Promise.all(
            Array.from({ length: 6 }, () => actor()),
          );
          for (const a of voters.slice(0, 5))
            accepted(await ballot(a, p, j.id, 'remove'));
          await pool.query(
            `CREATE FUNCTION whaleu_community_test.notice_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1.8);RETURN NEW;END $$;CREATE TRIGGER synthetic_notice_delay BEFORE INSERT ON whaleu_notifications.system_notices FOR EACH ROW EXECUTE FUNCTION whaleu_community_test.notice_delay()`,
          );
          const body = {
            clientRequestId: randomUUID(),
            postId: p,
            juryId: j.id,
            vote: 'remove' as const,
          };
          try {
            await assert.rejects(
              reports.vote(voters[5]!.accessToken, body),
              code('JURY_CLOSED'),
            );
          } finally {
            await pool.query(
              'DROP TRIGGER synthetic_notice_delay ON whaleu_notifications.system_notices;DROP FUNCTION whaleu_community_test.notice_delay()',
            );
          }
          assert.equal((await jury(p)).state, 'pending');
          assert.equal(
            (await notices.list(owner.accessToken, { limit: 20 })).items.length,
            0,
          );
          await assert.rejects(
            reports.receipt(voters[5]!.accessToken, body.clientRequestId),
            code('REQUEST_NOT_FOUND'),
          );
          await worker.run({ mode: 'apply', juryIds: [j.id] });
          assert.equal((await jury(p)).state, 'removed');
          assert.equal(
            (await notices.list(owner.accessToken, { limit: 20 })).items[0]!
              .removeVotes,
            5,
          );
        },
      );
      await t.test(
        'session and phone expiry after immutable receipt trigger never commits accepted report',
        async () => {
          for (const kind of ['session', 'phone'] as const) {
            const owner = await actor(),
              a = await actor(),
              p = await post(owner),
              body = command(p);
            if (kind === 'session')
              await pool.query(
                "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()+interval '200 milliseconds' WHERE token_hash=$1",
                [hashToken(a.accessToken)],
              );
            else
              await setSyntheticSnapshot(pool, a.accountId, [
                syntheticAssertion(a.accountId, issuer, 'phone', {
                  expires_at: new Date(Date.now() + 200),
                }),
                syntheticAssertion(a.accountId, issuer, 'affiliation'),
              ]);
            await pool.query(
              `CREATE FUNCTION whaleu_community_test.receipt_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.3);RETURN NEW;END $$;CREATE TRIGGER synthetic_receipt_delay BEFORE UPDATE ON whaleu_safety.report_requests FOR EACH ROW EXECUTE FUNCTION whaleu_community_test.receipt_delay()`,
            );
            try {
              await assert.rejects(
                reports.report(a.accessToken, body),
                code(
                  kind === 'session'
                    ? 'ACCESS_TOKEN_EXPIRED'
                    : 'PHONE_VERIFICATION_REQUIRED',
                ),
              );
            } finally {
              await pool.query(
                'DROP TRIGGER synthetic_receipt_delay ON whaleu_safety.report_requests;DROP FUNCTION whaleu_community_test.receipt_delay()',
              );
            }
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_safety.reports WHERE account_id=$1',
                  [a.accountId],
                )
              ).rowCount,
              0,
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_safety.report_requests WHERE account_id=$1',
                  [a.accountId],
                )
              ).rowCount,
              0,
            );
          }
        },
      );
      await t.test(
        'receipt/audit write failure rolls back report, jury, obligations and removal together',
        async () => {
          const owner = await actor(),
            a = await actor(),
            p = await post(owner);
          await privilege(a, 'developer');
          await pool.query(
            `CREATE FUNCTION whaleu_community_test.fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic private fault';END $$;CREATE TRIGGER synthetic_fail_receipt BEFORE UPDATE ON whaleu_safety.report_requests FOR EACH ROW EXECUTE FUNCTION whaleu_community_test.fail_receipt()`,
          );
          try {
            await assert.rejects(report(a, p), code('SAFETY_UNAVAILABLE'));
          } finally {
            await pool.query(
              'DROP TRIGGER synthetic_fail_receipt ON whaleu_safety.report_requests;DROP FUNCTION whaleu_community_test.fail_receipt()',
            );
          }
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_safety.report_cases WHERE post_id=$1',
                [p],
              )
            ).rowCount,
            0,
          );
          accepted(await report(a, p));
        },
      );
      await t.test(
        'selected grant expiration after receipt wait rolls back five-weight report',
        async () => {
          const owner = await actor(),
            a = await actor(),
            p = await post(owner);
          await privilege(a, 'developer', null, new Date(Date.now() + 200));
          await pool.query(
            `CREATE FUNCTION whaleu_community_test.grant_delay() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.3);RETURN NEW;END $$;CREATE TRIGGER synthetic_grant_delay BEFORE UPDATE ON whaleu_safety.report_requests FOR EACH ROW EXECUTE FUNCTION whaleu_community_test.grant_delay()`,
          );
          try {
            await assert.rejects(
              report(a, p),
              code('AUTHORIZATION_UNAVAILABLE'),
            );
          } finally {
            await pool.query(
              'DROP TRIGGER synthetic_grant_delay ON whaleu_safety.report_requests;DROP FUNCTION whaleu_community_test.grant_delay()',
            );
          }
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_safety.reports WHERE account_id=$1',
                [a.accountId],
              )
            ).rowCount,
            0,
          );
        },
      );
      await t.test(
        'SQL constraints reject incomplete/foreign receipts, immutable evidence and bad ancestry',
        async () => {
          const owner = await actor(),
            a = await actor(),
            p = await post(owner);
          accepted(await report(a, p));
          await assert.rejects(
            pool.query(
              "INSERT INTO whaleu_safety.report_requests(account_id,client_request_id,operation,payload_hash) VALUES($1,$2,'report',$3)",
              [a.accountId, randomUUID(), 'a'.repeat(64)],
            ),
          );
          await assert.rejects(
            pool.query(
              'DELETE FROM whaleu_safety.reports WHERE account_id=$1',
              [a.accountId],
            ),
          );
          await assert.rejects(
            pool.query(
              'UPDATE whaleu_safety.report_cases SET content_digest=$2 WHERE post_id=$1',
              [p, 'b'.repeat(64)],
            ),
          );
          await assert.rejects(
            database.transaction(async (tx) => {
              await tx.query(
                "INSERT INTO whaleu_safety.report_cases(id,kind,target_id,post_id,root_id,owner_account_id,provenance,content_digest) VALUES($1,'comment',$2,$2,NULL,$3,'native_publication',$4)",
                [randomUUID(), p, owner.accountId, 'a'.repeat(64)],
              );
            }),
          );
        },
      );

      await t.test(
        'target attempt admission precedes content contention and deduplicates one actor per window',
        async () => {
          const owner = await actor(),
            a = await actor(),
            b = await actor(),
            p = await post(owner);
          await open(p);
          const before = (
            await pool.query<{ hits: number }>(
              "SELECT hits FROM whaleu_safety.report_target_buckets WHERE kind='post' AND target_id=$1",
              [p],
            )
          ).rows[0]!.hits;
          rejected(await report(a, p), 'REPORTING_CLOSED');
          rejected(await report(a, p), 'REPORTING_CLOSED');
          assert.equal(
            (
              await pool.query<{ hits: number }>(
                "SELECT hits FROM whaleu_safety.report_target_buckets WHERE kind='post' AND target_id=$1",
                [p],
              )
            ).rows[0]!.hits,
            before + 1,
          );
          await pool.query(
            "UPDATE whaleu_safety.report_target_buckets SET hits=120,window_start=date_trunc('minute',clock_timestamp()) WHERE kind='post' AND target_id=$1",
            [p],
          );
          const barrier = await pool.connect();
          try {
            await barrier.query('BEGIN');
            await barrier.query(
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
              [p],
            );
            const blocked = request(app!.getHttpServer())
              .post('/v1/me/safety/reports')
              .set('Authorization', `Bearer ${b.accessToken}`)
              .send(command(p))
              .expect(429)
              .expect('retry-after', '60');
            await Promise.race([
              blocked,
              sleep(700).then(() => {
                throw new Error('Target admission waited for content lock');
              }),
            ]);
          } finally {
            await barrier.query('ROLLBACK');
            barrier.release();
          }
          rejected(await report(a, p), 'REPORTING_CLOSED');
        },
      );
      await t.test(
        'SQL forbids lost work, premature closure and contradictory rejected evidence',
        async () => {
          const owner = await actor(),
            p = await post(owner),
            opened = await open(p),
            j = opened.jury;
          for (const sql of [
            'DELETE FROM whaleu_safety.jury_work WHERE jury_id=$1',
            "UPDATE whaleu_safety.jury_work SET state='completed' WHERE jury_id=$1",
            "UPDATE whaleu_safety.jury_work SET due_at=due_at+interval '1 second' WHERE jury_id=$1",
          ])
            await assert.rejects(pool.query(sql, [j.id]));
          const c = (
            await pool.query<{ id: string }>(
              'SELECT id FROM whaleu_safety.report_cases WHERE post_id=$1',
              [p],
            )
          ).rows[0]!;
          for (const reason of [
            'deadline',
            'six_votes',
            'target_unavailable',
            'ten_reports',
          ])
            await assert.rejects(
              database.transaction(async (tx) => {
                const decisionId = randomUUID();
                await tx.query(
                  "INSERT INTO whaleu_safety.report_decisions(id,case_id,owner_account_id,cause,outcome,reason,keep_votes,remove_votes)VALUES($1,$2,$3,'post_jury','kept',$4,0,0)",
                  [decisionId, c.id, owner.accountId, reason],
                );
                await tx.query(
                  "UPDATE whaleu_safety.post_juries SET state='kept',decision_id=$2 WHERE id=$1",
                  [j.id, decisionId],
                );
                await tx.query(
                  "UPDATE whaleu_safety.report_cases SET state='kept' WHERE id=$1",
                  [c.id],
                );
                await tx.query(
                  "UPDATE whaleu_safety.jury_work SET state='completed' WHERE jury_id=$1",
                  [j.id],
                );
              }),
            );
          const other = await actor(),
            p2 = await post(owner);
          accepted(await report(other, p2));
          const c2 = (
            await pool.query<{ id: string }>(
              'SELECT id FROM whaleu_safety.report_cases WHERE post_id=$1',
              [p2],
            )
          ).rows[0]!;
          for (const operation of ['report', 'vote'] as const)
            await assert.rejects(
              database.transaction(async (tx) => {
                const a = await actor(),
                  key = randomUUID(),
                  id = randomUUID(),
                  receipt = {
                    requestId: key,
                    operation: operation === 'report' ? 'vote' : 'report',
                    outcome: 'rejected',
                    code: 'JURY_CLOSED',
                  };
                await tx.query(
                  'INSERT INTO whaleu_safety.report_requests(account_id,client_request_id,operation,payload_hash,receipt)VALUES($1,$2,$3,$4,$5)',
                  [
                    a.accountId,
                    key,
                    receipt.operation,
                    'a'.repeat(64),
                    JSON.stringify(receipt),
                  ],
                );
                if (operation === 'report') {
                  await tx.query(
                    'INSERT INTO whaleu_safety.reports(id,case_id,account_id,request_id,weight)VALUES($1,$2,$3,$4,1)',
                    [id, c2.id, a.accountId, key],
                  );
                  await tx.query(
                    'UPDATE whaleu_safety.report_cases SET report_count=report_count+1,effective_weight=effective_weight+1 WHERE id=$1',
                    [c2.id],
                  );
                } else
                  await tx.query(
                    "INSERT INTO whaleu_safety.jury_ballots(id,jury_id,account_id,request_id,vote)VALUES($1,$2,$3,$4,'keep')",
                    [id, j.id, a.accountId, key],
                  );
              }),
            );
          const r = await root(owner, p2);
          accepted(await report(other, r, 'comment'));
          await assert.rejects(
            pool.query(
              "UPDATE whaleu_safety.report_cases SET state='removed' WHERE target_id=$1",
              [r],
            ),
          );
        },
      );
      await t.test(
        'same-key concurrent replays and cross-account equal keys never double count',
        async () => {
          const owner = await actor(),
            a = await actor(),
            b = await actor(),
            p = await post(owner),
            body = command(p);
          const results = await Promise.all([
            reports.report(a.accessToken, body),
            reports.report(a.accessToken, body),
            reports.report(b.accessToken, body),
          ]);
          accepted(results[0]!);
          assert.deepEqual(results[0], results[1]);
          accepted(results[2]!);
          assert.equal(
            (await reports.progress(owner.accessToken, { kind: 'post', id: p }))
              .reportCount,
            2,
          );
        },
      );
      await t.test(
        'a real post-lock wait crossing affiliation expiry rolls back accepted report',
        async () => {
          const owner = await actor(),
            a = await actor(),
            p = await post(owner),
            body = command(p);
          await setSyntheticSnapshot(pool, a.accountId, [
            syntheticAssertion(a.accountId, issuer, 'phone'),
            syntheticAssertion(a.accountId, issuer, 'affiliation', {
              expires_at: new Date(Date.now() + 220),
            }),
          ]);
          const barrier = await pool.connect();
          let pending: Promise<ReportReceipt> | undefined;
          try {
            await barrier.query('BEGIN');
            await barrier.query(
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
              [p],
            );
            pending = reports.report(a.accessToken, body);
            pending.catch(() => undefined);
            await sleep(320);
            await barrier.query('COMMIT');
            await assert.rejects(
              pending,
              code('AFFILIATION_VERIFICATION_REQUIRED'),
            );
          } finally {
            await barrier.query('ROLLBACK');
            barrier.release();
            await pending?.catch(() => undefined);
          }
          await assert.rejects(
            reports.receipt(a.accessToken, body.clientRequestId),
            code('REQUEST_NOT_FOUND'),
          );
        },
      );
      await t.test(
        'queued late vote and removed-target late vote preserve only prior ballots',
        async (t) => {
          for (const ordered of [true, false]) {
            await t.test(
              ordered
                ? 'known vote-first source order'
                : 'real competing source locks',
              async () => {
                const owner = await actor(),
                  p = await post(owner);
                await due(p, 700);
                const opened = await open(p),
                  a = await actor(),
                  b = await actor();
                accepted(await ballot(a, p, opened.jury.id, 'remove'));
                const barrier = await pool.connect();
                const targets = app!.get(CommunityReportTargetFacade);
                const originalLock = targets.lockForSettlement;
                let workerReachedSource = false;
                let releaseWorker!: () => void;
                const workerGate = new Promise<void>((resolve) => {
                  releaseWorker = resolve;
                });
                // Prove the worker reached its source boundary, then keep it outside
                // the post lock until the queued vote has committed its rejection.
                // A queued tuple-lock waiter alone does not prove final acquisition
                // order against a newly dispatched worker after barrier release.
                targets.lockForSettlement = async (...args) => {
                  if (ordered && args[0].id === p && !workerReachedSource) {
                    workerReachedSource = true;
                    await workerGate;
                  }
                  return originalLock.apply(targets, args);
                };
                const lateCommand = {
                  clientRequestId: randomUUID(),
                  postId: p,
                  juryId: opened.jury.id,
                  vote: 'keep' as const,
                };
                let voting: Promise<ReportReceipt> | undefined,
                  processing: ReturnType<JuryWorker['run']> | undefined;
                try {
                  await barrier.query('BEGIN');
                  await barrier.query(
                    'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
                    [p],
                  );
                  voting = reports.vote(b.accessToken, lateCommand);
                  voting.catch(() => undefined);
                  const barrierPid = (
                    await barrier.query<{ pid: number }>(
                      'SELECT pg_backend_pid() pid',
                    )
                  ).rows[0]!.pid;
                  // This vote is the sole outstanding operation before the worker
                  // starts. Prove it reached this exact post's UPDATE-lock queue;
                  // invoking ballot() or waiting until the deadline is not proof.
                  await eventually(async () => {
                    const queued = await pool.query<{ pid: number }>(
                      `SELECT pid FROM pg_stat_activity
                 WHERE datname=current_database() AND wait_event_type='Lock'
                   AND query=$1 AND $2::integer=ANY(pg_blocking_pids(pid))`,
                      [
                        'SELECT * FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
                        barrierPid,
                      ],
                    );
                    assert.ok(queued.rows.length <= 1);
                    return queued.rows.length === 1;
                  });
                  await sleep(
                    Math.max(
                      0,
                      opened.jury.deadline.getTime() - Date.now() + 30,
                    ),
                  );
                  processing = worker.run({
                    mode: 'apply',
                    juryIds: [opened.jury.id],
                  });
                  if (ordered)
                    await eventually(async () => workerReachedSource);
                  await barrier.query('COMMIT');
                  const late = await voting;
                  if (ordered) rejected(late, 'JURY_CLOSED');
                  else {
                    // The original failing run did not record final lock ownership.
                    // Both exact outcomes are independently proved by ordered cases;
                    // neither permits a late ballot or another settlement effect.
                    assert.equal(late.outcome, 'rejected');
                    if (late.outcome !== 'rejected')
                      throw new Error('Late ballot accepted');
                    assert.ok(
                      ['JURY_CLOSED', 'REPORT_TARGET_UNAVAILABLE'].includes(
                        late.code,
                      ),
                    );
                  }
                  assert.deepEqual(
                    await reports.receipt(
                      b.accessToken,
                      lateCommand.clientRequestId,
                    ),
                    late,
                  );
                  assert.deepEqual(
                    await reports.vote(b.accessToken, lateCommand),
                    late,
                  );
                  releaseWorker();
                  const settled = await processing;
                  assert.equal(settled.failed, 0);
                  assert.equal(settled.completed, 1);
                  assert.deepEqual(
                    await reports.receipt(
                      b.accessToken,
                      lateCommand.clientRequestId,
                    ),
                    late,
                  );
                  assert.deepEqual(
                    await reports.vote(b.accessToken, lateCommand),
                    late,
                  );
                } finally {
                  releaseWorker();
                  targets.lockForSettlement = originalLock;
                  let rollbackFailed = true;
                  try {
                    await barrier.query('ROLLBACK');
                    rollbackFailed = false;
                  } finally {
                    barrier.release(rollbackFailed);
                    await Promise.allSettled([voting, processing]);
                  }
                }
                // The opposite source ordering has a different exact terminal code:
                // once the worker removed the post, its jury is no visibility grant.
                const afterRemoval = await actor();
                rejected(
                  await ballot(afterRemoval, p, opened.jury.id, 'keep'),
                  'REPORT_TARGET_UNAVAILABLE',
                );
                const ballots = await pool.query<{
                  account_id: string;
                  vote: string;
                }>(
                  'SELECT account_id,vote FROM whaleu_safety.jury_ballots WHERE jury_id=$1',
                  [opened.jury.id],
                );
                assert.deepEqual(ballots.rows, [
                  { account_id: a.accountId, vote: 'remove' },
                ]);
                assert.equal((await jury(p)).state, 'removed');
                const decisions = await pool.query<{
                  outcome: string;
                  keep_votes: number;
                  remove_votes: number;
                }>(
                  'SELECT outcome,keep_votes,remove_votes FROM whaleu_safety.report_decisions WHERE case_id=(SELECT case_id FROM whaleu_safety.post_juries WHERE id=$1)',
                  [opened.jury.id],
                );
                assert.deepEqual(decisions.rows, [
                  { outcome: 'removed', keep_votes: 0, remove_votes: 1 },
                ]);
                assert.equal(
                  (
                    await pool.query(
                      'SELECT id FROM whaleu_community.posts WHERE id=$1 AND deleted_at IS NOT NULL',
                      [p],
                    )
                  ).rowCount,
                  1,
                );
                const page = await notices.list(owner.accessToken, {
                  limit: 20,
                });
                assert.equal(page.items.length, 1);
                assert.equal(page.items[0]!.keepVotes, 0);
                assert.equal(page.items[0]!.removeVotes, 1);
              },
            );
          }
        },
      );
      await t.test(
        'replays use read quota, fresh actor/target budget and Retry-After',
        async () => {
          const owner = await actor(),
            a = await actor(),
            p = await post(owner),
            body = command(p);
          const first = accepted(await reports.report(a.accessToken, body));
          await pool.query(
            "UPDATE whaleu_safety.report_rate_buckets SET hits=30,window_start=date_trunc('minute',clock_timestamp()) WHERE account_id=$1 AND action='report'",
            [a.accountId],
          );
          assert.deepEqual(await reports.report(a.accessToken, body), first);
          await request(app!.getHttpServer())
            .post('/v1/me/safety/reports')
            .set('Authorization', `Bearer ${a.accessToken}`)
            .send(command(p))
            .expect(429)
            .expect('retry-after', '60');
        },
      );
    } finally {
      try {
        await automatic?.close();
        await app?.close();
        if (owns)
          for (const schema of schemas)
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
