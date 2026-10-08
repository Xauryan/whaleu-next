import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import type {
  PublishPost,
  PublishComment,
} from '../../src/community/contracts.js';
import type { PublishReply } from '../../src/community/discussion/contracts.js';
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
import type { SessionCredentials } from '../../src/identity/contracts.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import { initializeNativeSafetyAccount } from '../../src/safety/lifecycle.js';
import { ExperienceWorker } from '../../src/experience/worker.js';
import {
  createRuntimeActor,
  discussionApprovalEnvelope,
  postApprovalEnvelope,
  setRuntimeVerification,
} from '../support/community-runtime-fixtures.js';
import {
  appendIdentitySelection,
  seedCommunityScope,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from '../support/community-approval-fixtures.js';
import {
  grantSyntheticTitle,
  recordSyntheticHistory,
  establishSyntheticExperienceBaseline,
} from '../support/experience-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';
import {
  NativeExperienceTransport,
  nativeOrigin,
  memoryStorage,
  platformStorage,
  protocolFailure,
  serverFailure,
} from '../support/experience-native-bridge.js';

// Ordinary AppModule, ordinary database providers, real native gateways/decoders/
// controllers. Only device transport/storage are bridged to this disposable local
// server. Canonical synthetic scope, review and identity evidence is explicit.
const require = createRequire(import.meta.url);
const { ApiClient } = require('../../../wechat/src/api/client.ts');
const { AuthService } = require('../../../wechat/src/auth/auth-service.ts');
const {
  HttpAuthGateway,
} = require('../../../wechat/src/auth/http-auth-gateway.ts');
const { SessionStore } = require('../../../wechat/src/auth/session.ts');
const { systemClock } = require('../../../wechat/src/platform/clock.ts');
const { Cancellation } = require('../../../wechat/src/platform/contracts.ts');
const {
  HttpCommunityGateway,
} = require('../../../wechat/src/community/gateway.ts');
const {
  createCommunityRuntime,
} = require('../../../wechat/src/community/runtime.ts');
const {
  PostLikeMutationController,
  initialPostLikeMutationView,
} = require('../../../wechat/src/community/post-like-controller.ts');
const {
  HttpExperienceGateway,
} = require('../../../wechat/src/experience/gateway.ts');
const {
  createExperienceRuntime,
} = require('../../../wechat/src/experience/runtime.ts');
const {
  ExperienceController,
  initialExperienceView,
} = require('../../../wechat/src/experience/controller.ts');

interface HistoryRow {
  recordId: string;
  action: string;
  nominalDelta: string | null;
  appliedDelta: string | null;
  balanceAfter: string | null;
  outcome: string;
  occurredAt: string | null;
  appliedAt: string | null;
}
interface OwnedTitle {
  key: string;
  earnedAt: string | null;
}
interface Task {
  action: string;
  rewardedCount: number | null;
  remaining: number | null;
  refundCount: number | null;
}

function noSourceOrCredentials(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(
      ![
        'ownerId',
        'owner_id',
        'accountId',
        'account_id',
        'beneficiaryId',
        'beneficiary_id',
        'sourceId',
        'source_id',
        'unitId',
        'unit_id',
        'groupId',
        'group_id',
        'actorAccountId',
        'providerSubject',
        'accessToken',
        'refreshToken',
        'openid',
        'unionid',
        'resourceId',
        'postId',
        'rootCommentId',
        'replyId',
      ].includes(key),
      `Owner experience DTO leaked ${key}`,
    );
    noSourceOrCredentials(child);
  }
}

test(
  'real native experience → normal AppModule → PostgreSQL receipts, provenance and lifecycle',
  { timeout: 180000 },
  async (t) => {
    const connectionString = process.env['TEST_DATABASE_URL'];
    assert.ok(
      connectionString,
      'Use disposable loopback whaleu_test; no silent skips',
    );
    const url = new URL(connectionString);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const environment = {
      NODE_ENV: 'test',
      DATABASE_URL: connectionString,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '12',
      COMMUNITY_UPDATES_PROCESSING: 'disabled',
      EXPERIENCE_PROCESSING: 'manual_only',
    };
    const config = loadConfig(environment);
    const pool = new Pool(poolOptions(config));
    let app: INestApplication | undefined, suite: PoolClient | undefined;
    let locked = false,
      ownsSchemas = false;
    const legacyOwner = randomUUID(),
      boundaryOwner = randomUUID();
    const legacySubject = randomUUID(),
      boundarySubject = randomUUID();
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) AS locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert.equal(locked, true, 'Serialize disposable database suites');
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
          await pool.query<{ n: number }>(
            "SELECT count(*)::integer AS n FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
          )
        ).rows[0]!.n,
        0,
        'Refuse existing application schemas',
      );
      ownsSchemas = true;
      const migrations = await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      );
      assert.ok(migrations.some((m) => m.name === '0022_local_experience.sql'));
      await runMigrations(
        pool,
        migrations.filter((m) => m.name < '0022_'),
        { mode: 'up' },
      );
      // Two genuine pre-experience synthetic accounts, not a new-login override.
      // Their independent safety coverage was established at their actual creation.
      for (const [owner, subject] of [
        [legacyOwner, legacySubject],
        [boundaryOwner, boundarySubject],
      ]) {
        await inTransaction(pool, async (tx) => {
          await tx.query(
            'INSERT INTO whaleu_identity.accounts(id) VALUES($1)',
            [owner],
          );
          await initializeNativeSafetyAccount(owner!, tx);
          await tx.query(
            "INSERT INTO whaleu_identity.provider_identities(provider,app_id,subject,account_id) VALUES('wechat','synthetic-experience-only',$1,$2)",
            [subject, owner],
          );
        });
      }
      await runMigrations(pool, migrations, { mode: 'up' });
      const start = async (automatic = false) => {
        app = await NestFactory.create(
          AppModule.register(
            loadConfig({
              ...environment,
              EXPERIENCE_PROCESSING: automatic ? 'automatic' : 'manual_only',
              EXPERIENCE_INTERVAL_MS: '25',
            }),
          ),
          { logger: false },
        );
        configureHttp(app);
        await app.listen(0, '127.0.0.1');
      };
      await start();
      const transport = new NativeExperienceTransport(
        Number(new URL(await app!.getUrl()).port),
      );
      const cancel = new Cancellation();
      transport.checkResponse = (path, status, body) => {
        if (
          status === 200 &&
          (path.startsWith('/v1/me/experience') ||
            path === '/v1/experience/catalog')
        )
          noSourceOrCredentials(body);
      };
      const existingSession = async (subject: string) => {
        const accessToken = mintToken('access'),
          refreshToken = mintToken('refresh');
        const session = await app!.get(IdentityRepository).createSession(
          { provider: 'wechat', appId: 'synthetic-experience-only', subject },
          {
            access: hashToken(accessToken),
            refresh: hashToken(refreshToken),
          },
        );
        return { ...session, accessToken, refreshToken };
      };
      const makeClient = async (saved?: SessionCredentials) => {
        const credentials = saved ?? (await createRuntimeActor(app!));
        const sessions = new SessionStore();
        sessions.completeLogin(sessions.beginLogin(), credentials);
        const auth = new AuthService(
          sessions,
          new HttpAuthGateway(nativeOrigin, transport, systemClock),
          {
            login: async () => {
              throw new Error('No provider is configured');
            },
          },
          systemClock,
        );
        const api = new ApiClient(nativeOrigin, transport, sessions, auth);
        const storage = memoryStorage();
        const actor = {
          credentials,
          sessions,
          auth,
          api,
          storage,
          community: new HttpCommunityGateway(api),
          experience: new HttpExperienceGateway(api),
        };
        return {
          ...actor,
          runtime: createExperienceRuntime(
            actor,
            storage,
            nativeOrigin,
            async () => randomUUID(),
          ),
        };
      };
      type Actor = Awaited<ReturnType<typeof makeClient>>;
      const author = await makeClient(),
        peer = await makeClient(),
        isolated = await makeClient();
      const unknown = await makeClient(await existingSession(legacySubject));
      const boundary = await makeClient(await existingSession(boundarySubject));
      const snapshot = async () => {
        // Include every application table and sequence, not just balances. A dry
        // run must not acknowledge Saved, enqueue Updates, advance order or grant.
        const tables = (
          await pool.query<{ table_schema: string; table_name: string }>(
            "SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema LIKE 'whaleu\\_%' ESCAPE '\\' AND table_type='BASE TABLE' ORDER BY table_schema,table_name",
          )
        ).rows;
        const result: Record<string, unknown> = {};
        for (const { table_schema, table_name } of tables) {
          assert.match(table_schema, /^[a-z_]+$/);
          assert.match(table_name, /^[a-z_]+$/);
          result[`${table_schema}.${table_name}`] = (
            await pool.query(
              `SELECT coalesce(jsonb_agg(row ORDER BY row::text),'[]'::jsonb) AS rows FROM (SELECT to_jsonb(t) AS row FROM ${table_schema}.${table_name} t) s`,
            )
          ).rows[0]!.rows;
        }
        result['sequences'] = (
          await pool.query(
            "SELECT schemaname,sequencename,last_value FROM pg_sequences WHERE schemaname LIKE 'whaleu\\_%' ESCAPE '\\' ORDER BY schemaname,sequencename",
          )
        ).rows;
        return result;
      };
      const workIds = async () =>
        (
          await pool.query<{ unit_id: string }>(
            "SELECT unit_id FROM whaleu_experience.work WHERE state<>'completed' ORDER BY enrollment_order,unit_id LIMIT 50",
          )
        ).rows.map((r) => r.unit_id);
      const settle = async () => {
        const ids = await workIds();
        if (ids.length)
          await app!.get(ExperienceWorker).run({ mode: 'apply', unitIds: ids });
      };
      const requestCount = (path: string, method = 'POST') =>
        transport.exchanges.filter(
          (v) => v.path === path && v.method === method,
        ).length;

      await t.test(
        'new local account reads known zero, both owned defaults, null selection and no fabricated opening history',
        async () => {
          const before = await snapshot();
          const state = await author.experience.summary(cancel);
          assert.equal(state.baseline, 'known');
          assert.equal(state.balance, '0');
          assert.equal(state.level, 1);
          assert.equal(state.timezone, 'Asia/Shanghai');
          assert.equal(state.progress.pointsToNextLevel, '15');
          assert.equal(state.signIn.signedIn, false);
          assert.equal(state.signIn.nextReward, 2);
          assert.ok(
            state.tasks.every((task: Task) => task.rewardedCount === 0),
          );
          const appearance = await author.experience.appearance(cancel);
          assert.deepEqual(
            appearance.titles.map((title: OwnedTitle) => title.key).sort(),
            ['default_jingxiaoyu', 'level_1'],
          );
          assert.equal(appearance.titleKey, null);
          assert.equal(appearance.colorId, null);
          assert.equal(appearance.revision, '0');
          assert.deepEqual(
            (await author.experience.records(null, cancel)).items,
            [],
          );
          const catalog = await author.experience.catalog(cancel);
          assert.equal(catalog.levels.length, 30);
          assert.equal(catalog.colors.length, 26);
          await author.experience.unlocks(cancel);
          assert.deepEqual(
            await snapshot(),
            before,
            'All experience GETs are read-only',
          );
          for (const path of [
            '/v1/me/experience',
            '/v1/me/experience/records',
            '/v1/me/experience/appearance',
          ]) {
            assert.equal(
              (await request(app!.getHttpServer()).get(path)).status,
              401,
            );
            assert.equal(
              (
                await request(app!.getHttpServer())
                  .get(path)
                  .set(
                    'Authorization',
                    `Bearer ${author.credentials.accessToken}`,
                  )
                  .query({ ownerId: peer.credentials.accountId })
              ).status,
              400,
            );
          }
        },
      );

      await t.test(
        'unknown migrated baseline stays null while independent undated history and title remain readable and selectable',
        async () => {
          await inTransaction(pool, async (tx) => {
            await grantSyntheticTitle(tx, legacyOwner, 'level_3', null);
            await recordSyntheticHistory(tx, legacyOwner, {
              action: 'publish',
              occurredAt: null,
              nominalDelta: 10n,
            });
          });
          const before = await snapshot();
          const state = await unknown.experience.summary(cancel);
          assert.equal(state.baseline, 'baseline_unknown');
          assert.equal(state.balance, null);
          assert.equal(state.level, null);
          assert.equal(state.progress, null);
          assert.ok(
            state.tasks.every(
              (task: Task) =>
                task.rewardedCount === null && task.remaining === null,
            ),
          );
          const history = await unknown.experience.records(null, cancel);
          assert.equal(history.coverage, 'partial');
          assert.equal(history.items.length, 1);
          assert.equal(history.items[0].occurredAt, null);
          assert.equal(history.items[0].appliedAt, null);
          assert.equal(history.items[0].outcome, 'historical');
          const appearance = await unknown.experience.appearance(cancel);
          assert.equal(appearance.coverage, 'partial');
          assert.equal(
            appearance.titles.find(
              (title: OwnedTitle) => title.key === 'level_3',
            ).earnedAt,
            null,
          );
          assert.deepEqual(
            await snapshot(),
            before,
            'Undated proof does not initialize a balance',
          );
          await assert.rejects(
            unknown.runtime.signIn(),
            serverFailure('EXPERIENCE_BASELINE_UNAVAILABLE'),
          );
          const pending = unknown.runtime.pending.load(legacyOwner, 'sign_in');
          assert.ok(pending);
          await assert.rejects(
            unknown.experience.receipt(pending.intent.requestId, cancel),
            serverFailure('EXPERIENCE_REQUEST_NOT_FOUND'),
          );
          const selected = await unknown.runtime.selectAppearance({
            expectedRevision: appearance.revision,
            titleKey: 'level_3',
            colorId: 3,
          });
          assert.equal(selected.outcome, 'applied');
          assert.equal(selected.titleKey, 'level_3');
          assert.deepEqual(
            unknown.runtime.pending.load(legacyOwner, 'sign_in'),
            pending,
            'Appearance has a separate durable journal',
          );
          assert.equal(
            (await unknown.experience.summary(cancel)).balance,
            null,
          );
          assert.deepEqual(
            (await isolated.experience.records(null, cancel)).items,
            [],
          );
          await assert.rejects(
            isolated.experience.receipt(selected.requestId, cancel),
            serverFailure('EXPERIENCE_REQUEST_NOT_FOUND'),
          );
          const readPosts = requestCount('/v1/me/experience/sign-in');
          await unknown.runtime.foreground();
          await unknown.runtime.foreground();
          assert.equal(
            requestCount('/v1/me/experience/sign-in'),
            readPosts,
            'Foreground never retries a blocked persisted command',
          );
          unknown.runtime.hide();
        },
      );

      await t.test(
        'lost appearance response recovers original receipt without overwriting newer selection or clearing blocked sign-in',
        async () => {
          const signIn = unknown.runtime.pending.load(legacyOwner, 'sign_in');
          assert.ok(signIn);
          const current = await unknown.experience.appearance(cancel);
          transport.dropSuccess = {
            path: '/v1/me/experience/appearance',
            method: 'PUT',
          };
          await assert.rejects(
            unknown.runtime.selectAppearance({
              expectedRevision: current.revision,
              titleKey: 'level_3',
              colorId: 4,
            }),
          );
          const pending = unknown.runtime.pending.load(
            legacyOwner,
            'appearance',
          );
          assert.ok(pending);
          const committed = await unknown.experience.appearance(cancel);
          assert.equal(committed.colorId, 4);
          await unknown.experience.selectAppearance(
            {
              requestId: randomUUID(),
              expectedRevision: committed.revision,
              titleKey: 'level_3',
              colorId: 5,
            },
            cancel,
          );
          const recovered = await unknown.runtime.recover('appearance', true);
          assert.equal(recovered.requestId, pending.intent.requestId);
          assert.equal(recovered.colorId, 4);
          assert.equal(
            (await unknown.experience.appearance(cancel)).colorId,
            5,
            'Receipt is operation proof, never the current selected appearance',
          );
          assert.deepEqual(
            unknown.runtime.pending.load(legacyOwner, 'sign_in'),
            signIn,
          );
          assert.equal(
            unknown.runtime.pending.load(legacyOwner, 'appearance'),
            null,
          );
          let view = initialExperienceView();
          const controller = new ExperienceController(
            unknown.runtime,
            (next: typeof view) => {
              view = next;
            },
          );
          await controller.load();
          assert.equal(view.colorId, 5);
          assert.equal(view.signInPending, true);
          assert.equal(view.appearancePending, false);
          controller.dispose();
        },
      );

      const scope = await seedCommunityScope(pool);
      await seedReviewPolicy(pool);
      for (const actor of [author, peer, isolated, unknown, boundary]) {
        const facts = await setRuntimeVerification(
          pool,
          actor.credentials.accountId,
          scope.institutionId,
          scope.home.regionId,
        );
        await appendIdentitySelection(
          pool,
          actor.credentials.accountId,
          facts,
          scope,
          scope.home.campusId,
        );
      }
      const postIntent = (text: string): PublishPost => ({
        clientRequestId: randomUUID(),
        spaceId: scope.home.spaceId,
        category: 'discussion',
        text,
        imageAssetIds: [],
        authorMode: 'named',
        commentsPolicy: 'open',
      });
      const publish = async (actor: Actor, text: string) => {
        const body = postIntent(text);
        await approveEnvelope(
          pool,
          await postApprovalEnvelope(
            app!,
            pool,
            actor.credentials.accountId,
            body,
          ),
        );
        const result = await actor.community.publishPost(body, cancel);
        assert.equal(result.outcome, 'created');
        return result.resourceId as string;
      };
      const comment = async (actor: Actor, postId: string) => {
        const body: PublishComment = {
          clientRequestId: randomUUID(),
          text: 'Synthetic root discussion',
          imageAssetIds: [],
          authorMode: 'named',
        };
        await approveEnvelope(
          pool,
          await discussionApprovalEnvelope(
            app!,
            pool,
            actor.credentials.accountId,
            postId,
            body,
          ),
        );
        const result = await actor.community.publishComment(
          postId,
          body,
          cancel,
        );
        assert.equal(result.outcome, 'created');
        return result.resourceId as string;
      };
      const reply = async (actor: Actor, postId: string, root: string) => {
        const body: PublishReply = {
          clientRequestId: randomUUID(),
          text: 'Synthetic reply discussion',
          imageAssetIds: [],
          authorMode: 'named',
          targetReplyId: null,
        };
        await approveEnvelope(
          pool,
          await discussionApprovalEnvelope(
            app!,
            pool,
            actor.credentials.accountId,
            postId,
            body,
            root,
          ),
        );
        const result = await actor.community.publishReply(root, body, cancel);
        assert.equal(result.outcome, 'created');
        return result.resourceId as string;
      };
      const like = async (
        actor: Actor,
        postId: string,
        liked = true,
        requestId = randomUUID(),
      ) =>
        actor.community.like(
          { requestId, operation: 'set_post_like', postId, liked },
          cancel,
        );
      const save = async (actor: Actor, postId: string, desired = true) =>
        actor.community.applySaved(
          {
            clientRequestId: randomUUID(),
            operation: 'set_post_saved',
            postId,
            desired,
            channel: null,
          },
          cancel,
        );
      let post = '';
      await t.test(
        'real source commits queue work, reads stay truthful, dry-run mutates nothing and independent settlement updates native tasks/history',
        async () => {
          post = await publish(author, 'Experience source post');
          await publish(author, 'Experience capped second post');
          const root = await comment(peer, post);
          await reply(author, post, root);
          await like(peer, post);
          await save(peer, post);
          const pending = await author.experience.summary(cancel);
          assert.equal(pending.balance, '0');
          assert.ok(pending.pending.count > 0);
          assert.equal(pending.pending.reason, 'queued');
          const before = await snapshot();
          await app!
            .get(ExperienceWorker)
            .run({ mode: 'dry-run', unitIds: await workIds() });
          assert.deepEqual(await snapshot(), before);
          const selected = (await workIds())[0]!;
          const cli = await promisify(execFile)(
            process.execPath,
            [
              '--import',
              'tsx',
              fileURLToPath(
                new URL(
                  '../../src/experience/process-experience.ts',
                  import.meta.url,
                ),
              ),
              'dry-run',
              `--unit-id=${selected}`,
            ],
            {
              cwd: fileURLToPath(new URL('../../', import.meta.url)),
              env: {
                ...process.env,
                ...environment,
                COMMUNITY_UPDATES_PROCESSING: 'automatic',
                SAFETY_JURY_PROCESSING: 'automatic',
                EXPERIENCE_PROCESSING: 'automatic',
                COMMUNITY_UPDATES_INTERVAL_MS: '1',
                SAFETY_JURY_INTERVAL_MS: '1',
                EXPERIENCE_INTERVAL_MS: '1',
              },
              timeout: 15000,
              maxBuffer: 1024 * 1024,
            },
          );
          const report = JSON.parse(cli.stdout.trim()) as {
            command: string;
            requested: number;
            settled: number;
          };
          assert.equal(report.command, 'local-experience');
          assert.equal(report.requested, 1);
          assert.equal(report.settled, 0);
          assert.deepEqual(
            await snapshot(),
            before,
            'Selected CLI dry-run must disable every inherited automatic dispatcher',
          );
          await assert.rejects(
            peer.runtime.signIn(),
            serverFailure('EXPERIENCE_PENDING'),
          );
          const oldIntent = peer.runtime.pending.load(
            peer.credentials.accountId,
            'sign_in',
          );
          assert.ok(oldIntent);
          const appearance = await peer.experience.appearance(cancel);
          await peer.runtime.selectAppearance({
            expectedRevision: appearance.revision,
            titleKey: 'level_1',
            colorId: 1,
          });
          assert.deepEqual(
            peer.runtime.pending.load(peer.credentials.accountId, 'sign_in'),
            oldIntent,
          );
          await settle();
          const a = await author.experience.summary(cancel),
            p = await peer.experience.summary(cancel);
          assert.equal(a.balance, '20');
          assert.equal(a.level, 2);
          assert.equal(a.pending.count, 0);
          assert.equal(p.balance, '8');
          assert.equal(
            a.tasks.find((task: Task) => task.action === 'publish')
              .rewardedCount,
            1,
          );
          assert.equal(
            p.tasks.find((task: Task) => task.action === 'like_save')
              .rewardedCount,
            2,
          );
          const history = await author.experience.records(null, cancel);
          assert.ok(
            history.items.some(
              (r: HistoryRow) =>
                r.action === 'publish' &&
                r.outcome === 'capped' &&
                r.nominalDelta === '10' &&
                r.appliedDelta === '0',
            ),
          );
          assert.equal(
            history.items.reduce(
              (sum: bigint, r: HistoryRow) => sum + BigInt(r.appliedDelta!),
              0n,
            ),
            20n,
          );
          assert.ok(
            history.items.every(
              (r: HistoryRow) => r.appliedAt !== null && r.occurredAt !== null,
            ),
          );
          const resumed = await peer.runtime.recover('sign_in', true);
          assert.equal(resumed.requestId, oldIntent.intent.requestId);
          assert.equal(resumed.appliedDelta, '2');
          assert.equal((await peer.experience.summary(cancel)).balance, '10');
          const receipts = (
            await pool.query(
              'SELECT action,status FROM whaleu_community.saved_obligations ORDER BY action',
            )
          ).rows;
          assert.ok(
            receipts
              .filter((r) =>
                ['saver_reward', 'author_reward'].includes(r.action),
              )
              .every((r) => r.status === 'completed'),
          );
          assert.ok(
            receipts
              .filter(
                (r) => !['saver_reward', 'author_reward'].includes(r.action),
              )
              .every((r) => r.status === 'pending'),
            'Unrelated materializers are not falsely acknowledged',
          );
        },
      );

      await t.test(
        'post-like lost response, intervening unlike and immutable receipt recovery cannot re-like or mint duplicate rewards',
        async () => {
          const wx = platformStorage(),
            runtime = createCommunityRuntime(isolated, wx, nativeOrigin);
          let view = initialPostLikeMutationView(),
            refreshes = 0;
          const controller = new PostLikeMutationController(
            runtime,
            (next: typeof view) => {
              view = next;
            },
            () => {
              refreshes++;
            },
          );
          const current = await isolated.community.post(post, cancel);
          transport.dropSuccess = {
            path: `/v1/community/posts/${post}/like`,
            method: 'PUT',
          };
          await controller.setLiked(current, true);
          assert.equal(view.frozen, true);
          assert.equal(refreshes, 0);
          const pending = runtime.pendingPostLikes.load(
            isolated.credentials.accountId,
          );
          assert.ok(pending);
          assert.equal(
            (await isolated.community.post(post, cancel)).viewer.isLiked,
            true,
          );
          await like(isolated, post, false);
          assert.equal(
            (await isolated.community.post(post, cancel)).viewer.isLiked,
            false,
          );
          await controller.recover(true);
          assert.equal(view.frozen, false);
          assert.equal(refreshes, 1);
          assert.equal(
            (await isolated.community.post(post, cancel)).viewer.isLiked,
            false,
            'Historical receipt cannot project or restore current membership',
          );
          const recovered = await isolated.community.postLikeReceipt(
            pending.requestId,
            cancel,
          );
          assert.equal(recovered.liked, true);
          assert.equal(recovered.outcome, 'applied');
          await settle();
          assert.equal(
            (await isolated.experience.summary(cancel)).balance,
            '1',
          );
          await like(isolated, post, true);
          await settle();
          assert.equal(
            (await isolated.experience.summary(cancel)).balance,
            '2',
            'A new actual transition may earn again',
          );
          await like(isolated, post, true);
          await settle();
          assert.equal(
            (await isolated.experience.summary(cancel)).balance,
            '2',
            'Desired-state no-op never enrolls another unit',
          );
          const persisted = JSON.stringify([...wx.storage.values.values()]);
          assert.ok(!persisted.includes(isolated.credentials.accessToken));
          assert.ok(!persisted.includes(isolated.credentials.refreshToken));
          controller.dispose();
        },
      );

      await t.test(
        'unknown recipient work remains pending without blocking a known saver or acknowledging unavailable rewards',
        async () => {
          const unknownPost = await publish(
            unknown,
            'Unknown baseline owner source',
          );
          const before = BigInt(
            (await isolated.experience.summary(cancel)).balance,
          );
          await save(isolated, unknownPost);
          await settle();
          assert.equal(
            BigInt((await isolated.experience.summary(cancel)).balance),
            before + 1n,
          );
          const state = await unknown.experience.summary(cancel);
          assert.equal(state.balance, null);
          assert.ok(state.pending.count >= 2);
          assert.equal(state.pending.reason, 'baseline_unknown');
          const statuses = (
            await pool.query<{ action: string; status: string }>(
              `SELECT o.action,o.status FROM whaleu_community.saved_obligations o JOIN whaleu_community.reward_source_units u ON u.saved_obligation_id=o.id WHERE u.beneficiary_id IN($1,$2) AND u.group_id IN(SELECT id FROM whaleu_community.reward_source_groups WHERE post_id=$3)`,
              [legacyOwner, isolated.credentials.accountId, unknownPost],
            )
          ).rows;
          assert.equal(
            statuses.find((r) => r.action === 'saver_reward')?.status,
            'completed',
          );
          assert.equal(
            statuses.find((r) => r.action === 'author_reward')?.status,
            'pending',
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer AS n FROM whaleu_experience.settlements WHERE owner_id=$1',
                [legacyOwner],
              )
            ).rows[0]!.n,
            0,
          );
        },
      );

      await t.test(
        'own-delete records show actual floored movement and retained equipped color survives a real downgrade',
        async () => {
          const before = BigInt(
            (await author.experience.summary(cancel)).balance,
          );
          assert.ok(before > 15n && before < 30n);
          const appearance = await author.experience.appearance(cancel);
          await author.runtime.selectAppearance({
            expectedRevision: appearance.revision,
            titleKey: 'level_1',
            colorId: 11,
          });
          const deletes = [];
          for (let index = 0; index < 3; index++)
            deletes.push(
              await publish(author, `Capped own-delete fixture ${index}`),
            );
          await settle();
          assert.equal(
            BigInt((await author.experience.summary(cancel)).balance),
            before,
          );
          for (const id of deletes)
            await author.community.deletePost(id, cancel);
          await settle();
          const after = await author.experience.summary(cancel);
          assert.equal(after.balance, '0');
          assert.equal(after.level, 1);
          const records = (
            await author.experience.records(null, cancel)
          ).items.filter((r: HistoryRow) => r.action === 'delete_post');
          assert.equal(records.length, 3);
          assert.ok(records.every((r: HistoryRow) => r.nominalDelta === '-10'));
          assert.equal(
            records.reduce(
              (sum: bigint, r: HistoryRow) => sum + BigInt(r.appliedDelta!),
              0n,
            ),
            -before,
          );
          assert.ok(
            records.some((r: HistoryRow) => r.appliedDelta !== r.nominalDelta),
            'UI receives actual movement separately from nominal penalty',
          );
          const retained = await author.experience.appearance(cancel);
          assert.equal(retained.colorId, 11);
          assert.ok(!retained.eligibleColorIds.includes(11));
          await author.runtime.selectAppearance({
            expectedRevision: retained.revision,
            titleKey: 'default_jingxiaoyu',
            colorId: 11,
          });
          assert.equal(
            (await author.experience.appearance(cancel)).colorId,
            11,
            'Unchanged previously selected high color remains through a title edit',
          );
          assert.equal(
            after.tasks.find((task: Task) => task.action === 'publish')
              .refundCount,
            1,
          );
        },
      );

      await t.test(
        'current hidden visibility cannot erase an already enrolled reward and native history contains no private source preview',
        async () => {
          const actor = await makeClient();
          const facts = await setRuntimeVerification(
            pool,
            actor.credentials.accountId,
            scope.institutionId,
            scope.home.regionId,
          );
          await appendIdentitySelection(
            pool,
            actor.credentials.accountId,
            facts,
            scope,
            scope.home.campusId,
          );
          const secret =
            'Synthetic hidden content must not enter an experience DTO';
          const id = await publish(actor, secret);
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
              [id],
            ),
          );
          await settle();
          assert.equal((await actor.experience.summary(cancel)).balance, '10');
          const history = await actor.experience.records(null, cancel);
          assert.equal(history.items.length, 1);
          assert.equal(history.items[0].action, 'publish');
          assert.ok(!JSON.stringify(history).includes(secret));
          assert.ok(!JSON.stringify(history).includes(id));
          actor.runtime.dispose();
        },
      );

      await t.test(
        'server-day foreground coalescing and lost sign-in response retain exact request across native restart',
        async () => {
          const actor = await makeClient();
          const before = await actor.experience.summary(cancel);
          transport.dropSuccess = {
            path: '/v1/me/experience/sign-in',
            method: 'POST',
          };
          await Promise.all([
            actor.runtime.foreground(),
            actor.runtime.foreground(),
            actor.runtime.foreground(),
          ]);
          const pending = actor.runtime.pending.load(
            actor.credentials.accountId,
            'sign_in',
          );
          assert.ok(pending);
          const after = await actor.experience.summary(cancel);
          assert.equal(after.balance, '2');
          assert.equal(after.signIn.lastDay, before.serverDay);
          const count = requestCount('/v1/me/experience/sign-in');
          await actor.runtime.foreground();
          assert.equal(requestCount('/v1/me/experience/sign-in'), count);
          actor.runtime.dispose();
          const restarted = createExperienceRuntime(
            actor,
            actor.storage,
            nativeOrigin,
            async () => randomUUID(),
          );
          await restarted.foreground();
          assert.equal(requestCount('/v1/me/experience/sign-in'), count);
          const receipt = await restarted.recover('sign_in');
          assert.equal(receipt.requestId, pending.intent.requestId);
          assert.equal(receipt.rewardDay, before.serverDay);
          await restarted.foreground();
          await restarted.foreground();
          assert.equal(requestCount('/v1/me/experience/sign-in'), count);
          assert.equal(
            (await actor.experience.records(null, cancel)).items.filter(
              (r: HistoryRow) => r.action === 'sign_in',
            ).length,
            1,
          );
          restarted.dispose();
        },
      );

      await t.test(
        'earned unlock notice, appearance rejection and closed notice remain separate from balance settlement',
        async () => {
          await inTransaction(pool, (tx) =>
            establishSyntheticExperienceBaseline(tx, boundaryOwner, {
              balance: 39n,
            }),
          );
          const receipt = await boundary.runtime.signIn();
          assert.equal(receipt.balance, '41');
          const appearance = await boundary.experience.appearance(cancel);
          assert.ok(
            appearance.titles.some(
              (title: OwnedTitle) => title.key === 'level_3',
            ),
          );
          const rejected = await boundary.runtime.selectAppearance({
            expectedRevision: appearance.revision,
            titleKey: 'level_29',
            colorId: null,
          });
          assert.equal(rejected.outcome, 'rejected');
          assert.equal(rejected.code, 'EXPERIENCE_TITLE_INELIGIBLE');
          assert.equal(
            boundary.runtime.pending.load(boundaryOwner, 'appearance'),
            null,
            'Strict terminal rejection releases only its own journal',
          );
          assert.deepEqual(
            await boundary.experience.receipt(rejected.requestId, cancel),
            rejected,
          );
          const notices = await boundary.experience.unlocks(cancel);
          assert.ok(notices.items.length > 0);
          let view = initialExperienceView();
          const controller = new ExperienceController(
            boundary.runtime,
            (next: typeof view) => {
              view = next;
            },
          );
          await controller.load();
          assert.equal(view.summary.balance, '41');
          const notice = notices.items[0];
          await controller.closeUnlock(notice.noticeId);
          await controller.load();
          assert.equal(boundary.runtime.isNoticeClosed(notice.noticeId), true);
          assert.ok(
            !(await boundary.experience.unlocks(cancel)).items.some(
              (n: { noticeId: string }) => n.noticeId === notice.noticeId,
            ),
          );
          assert.equal(
            (await boundary.experience.summary(cancel)).balance,
            '41',
          );
          controller.dispose();
        },
      );

      await t.test(
        'native owner view hides unknown figures, renders undated proof and discards real delayed callbacks on hide/logout/switch',
        async () => {
          for (const transition of [
            'hide',
            'logout',
            'switch',
            'new-login',
          ] as const) {
            const actor = await makeClient(unknown.credentials);
            let view = initialExperienceView();
            const controller = new ExperienceController(
              actor.runtime,
              (next: typeof view) => {
                view = next;
              },
            );
            await controller.load();
            const visible = JSON.stringify(view);
            assert.ok(visible.includes('level_3'));
            assert.ok(visible.includes('historical'));
            const held = transport.holdNext('/v1/me/experience');
            const loading = controller.load();
            await held.arrived;
            if (transition === 'hide') actor.runtime.hide();
            else if (transition === 'logout') actor.sessions.logout();
            else
              actor.sessions.completeLogin(
                actor.sessions.beginLogin(),
                transition === 'switch'
                  ? peer.credentials
                  : await existingSession(legacySubject),
              );
            const cleared = JSON.stringify(view);
            assert.ok(!cleared.includes('historical'));
            assert.ok(!cleared.includes('level_3'));
            held.release();
            await loading;
            assert.equal(
              JSON.stringify(view),
              cleared,
              'An uncooperative old callback cannot repaint another session',
            );
            const stored = JSON.stringify([...actor.storage.values.values()]);
            assert.ok(!stored.includes('historical'));
            assert.ok(!stored.includes(actor.credentials.accessToken));
            controller.dispose();
            actor.runtime.dispose();
          }
        },
      );

      await t.test(
        'owner history pagination keeps undated proof and controller load-more uses stable unique records',
        async () => {
          await inTransaction(pool, async (tx) => {
            for (let index = 0; index < 24; index++)
              await recordSyntheticHistory(tx, legacyOwner, {
                action: 'comment',
                occurredAt: null,
              });
          });
          const first = await unknown.experience.records(null, cancel);
          assert.equal(first.items.length, 20);
          assert.ok(first.nextCursor);
          const second = await unknown.experience.records(
            first.nextCursor,
            cancel,
          );
          assert.equal(second.items.length, 5);
          assert.equal(second.nextCursor, null);
          assert.equal(
            new Set(
              [...first.items, ...second.items].map(
                (r: HistoryRow) => r.recordId,
              ),
            ).size,
            25,
          );
          const foreign = await request(app!.getHttpServer())
            .get('/v1/me/experience/records')
            .query({ limit: 20, cursor: first.nextCursor })
            .set('Authorization', `Bearer ${peer.credentials.accessToken}`);
          assert.equal(
            foreign.status,
            400,
            'Owner-scoped cursor cannot select another owner history',
          );
          let view = initialExperienceView();
          const controller = new ExperienceController(
            unknown.runtime,
            (next: typeof view) => {
              view = next;
            },
          );
          await controller.load();
          assert.equal(view.records.length, 20);
          assert.equal(view.balanceLabel, '历史经验基准未确认');
          assert.ok(
            view.records.every(
              (r: { dateLabel: string }) => r.dateLabel === '发生日期不可用',
            ),
          );
          const held = transport.holdNext('/v1/me/experience/records');
          const more = controller.moreRecords();
          await held.arrived;
          await controller.moreRecords();
          held.release();
          await more;
          assert.equal(view.records.length, 25);
          assert.equal(view.hasMore, false);
          assert.equal(view.summary.balance, null);
          assert.equal(
            new Set(view.records.map((r: HistoryRow) => r.recordId)).size,
            25,
          );
          controller.dispose();
        },
      );

      await t.test(
        'late committed sign-in response after account replacement never settles another session journal or repaints its view',
        async () => {
          const actor = await makeClient();
          const held = transport.holdNext('/v1/me/experience/sign-in', 'POST');
          const result = actor.runtime.signIn().then(
            () => ({ ok: true }),
            () => ({ ok: false }),
          );
          await held.arrived;
          const pending = actor.runtime.pending.load(
            actor.credentials.accountId,
            'sign_in',
          );
          assert.ok(pending);
          actor.sessions.completeLogin(
            actor.sessions.beginLogin(),
            peer.credentials,
          );
          held.release();
          assert.deepEqual(await result, { ok: false });
          assert.deepEqual(
            actor.runtime.pending.load(actor.credentials.accountId, 'sign_in'),
            pending,
          );
          assert.equal(
            actor.runtime.pending.load(peer.credentials.accountId, 'sign_in'),
            null,
          );
          assert.equal(
            (await actor.experience.summary(cancel)).balance,
            (await peer.experience.summary(cancel)).balance,
          );
          actor.runtime.dispose();
          const original = await makeClient(actor.credentials);
          const restored = createExperienceRuntime(
            original,
            actor.storage,
            nativeOrigin,
            async () => randomUUID(),
          );
          const recovered = await restored.recover('sign_in');
          assert.equal(recovered.requestId, pending.intent.requestId);
          assert.equal(recovered.balance, '2');
          assert.equal(
            (await original.experience.records(null, cancel)).items.length,
            1,
          );
          restored.dispose();
          original.runtime.dispose();
        },
      );

      await t.test(
        'real gateway rejects extra private source fields and contradictory unknown summary instead of stripping them',
        async () => {
          for (const transform of [
            (value: unknown) => ({
              ...(value as Record<string, unknown>),
              ownerId: legacyOwner,
            }),
            (value: unknown) => ({
              ...(value as Record<string, unknown>),
              balance: '0',
            }),
          ]) {
            transport.corruptNext = { path: '/v1/me/experience', transform };
            await assert.rejects(
              unknown.experience.summary(cancel),
              protocolFailure,
            );
          }
          transport.corruptNext = {
            path: '/v1/me/experience/records',
            transform: (value: unknown) => {
              const page = value as { items: HistoryRow[] };
              return {
                ...page,
                items: page.items.map((r) => ({
                  ...r,
                  sourceId: randomUUID(),
                })),
              };
            },
          };
          await assert.rejects(
            unknown.experience.records(null, cancel),
            protocolFailure,
          );
        },
      );

      await t.test(
        'failed settlement rolls back; manual startup preserves retry and explicit local automatic opt-in survives restart without replay',
        async () => {
          const actor = await makeClient();
          const facts = await setRuntimeVerification(
            pool,
            actor.credentials.accountId,
            scope.institutionId,
            scope.home.regionId,
          );
          await appendIdentitySelection(
            pool,
            actor.credentials.accountId,
            facts,
            scope,
            scope.home.campusId,
          );
          await publish(actor, 'Durable worker restart source');
          assert.equal((await actor.experience.summary(cancel)).balance, '0');
          const units = (
            await pool.query<{ unit_id: string }>(
              'SELECT unit_id FROM whaleu_experience.work WHERE beneficiary_id=$1',
              [actor.credentials.accountId],
            )
          ).rows.map((r) => r.unit_id);
          assert.equal(units.length, 1);
          // A fixture-only storage failure after the real balance/settlement writes
          // tests transaction rollback; no policy, source or reward provider is replaced.
          await pool.query(`CREATE FUNCTION whaleu_experience.synthetic_roundtrip_failure() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN IF NEW.owner_id='${actor.credentials.accountId}'::uuid THEN RAISE EXCEPTION 'Synthetic local record interruption'; END IF; RETURN NEW; END $$;
            CREATE TRIGGER synthetic_roundtrip_failure BEFORE INSERT ON whaleu_experience.records FOR EACH ROW EXECUTE FUNCTION whaleu_experience.synthetic_roundtrip_failure()`);
          try {
            const failed = await app!
              .get(ExperienceWorker)
              .run({ mode: 'apply', unitIds: units });
            assert.equal(failed.failed, 1);
            assert.equal(failed.settled, 0);
            assert.equal((await actor.experience.summary(cancel)).balance, '0');
            assert.equal(
              (await actor.experience.records(null, cancel)).items.length,
              0,
            );
            const retry = (
              await pool.query<{
                attempts: number;
                error_code: string;
                state: string;
              }>(
                'SELECT attempts,error_code,state FROM whaleu_experience.work WHERE unit_id=$1',
                [units[0]],
              )
            ).rows[0]!;
            assert.equal(retry.attempts, 1);
            assert.equal(retry.error_code, 'local_processing_failed');
            assert.equal(retry.state, 'pending');
          } finally {
            await pool.query(
              'DROP TRIGGER synthetic_roundtrip_failure ON whaleu_experience.records; DROP FUNCTION whaleu_experience.synthetic_roundtrip_failure()',
            );
          }
          await app!.close();
          await start();
          transport.port = Number(new URL(await app!.getUrl()).port);
          assert.equal(
            (await actor.experience.summary(cancel)).balance,
            '0',
            'Default manual startup cannot settle queued work',
          );
          await app!.close();
          await start(true);
          transport.port = Number(new URL(await app!.getUrl()).port);
          const deadline = Date.now() + 10000;
          let state = await actor.experience.summary(cancel);
          while (state.pending.count > 0 && Date.now() < deadline) {
            await delay(25);
            state = await actor.experience.summary(cancel);
          }
          assert.equal(state.pending.count, 0);
          assert.equal(state.balance, '10');
          await app!.close();
          await start();
          transport.port = Number(new URL(await app!.getUrl()).port);
          assert.equal((await actor.experience.summary(cancel)).balance, '10');
          assert.equal(
            (await actor.experience.records(null, cancel)).items.length,
            1,
          );
          actor.runtime.dispose();
        },
      );
      for (const actor of [author, peer, isolated, unknown, boundary])
        actor.runtime.dispose();
    } finally {
      try {
        await app?.close();
      } finally {
        try {
          if (ownsSchemas)
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
