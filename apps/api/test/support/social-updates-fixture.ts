/** Disposable PostgreSQL fixtures. All social sources use real AppModule writers. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.js';
import {
  poolOptions,
  supportedPostgresVersion,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { configureHttp } from '../../src/http/http.js';
import type {
  PublishComment,
  PublishPost,
} from '../../src/community/contracts.js';
import type { PublishReply } from '../../src/community/discussion/contracts.js';
import { UpdatesDispatcher } from '../../src/notifications/dispatcher.js';
import { SocialUpdatesDispatcher } from '../../src/notifications/social/dispatcher.js';
import { SocialUpdatesWorker } from '../../src/notifications/social/worker.js';
import {
  socialNoticeReadSchema,
  socialNoticeTargetSchema,
  socialUnreadSchema,
  socialUpdatesPageSchema,
} from '../../src/notifications/social/contracts.js';
import type { SocialCategory } from '../../src/notifications/social/contracts.js';
import {
  createRuntimeActor,
  discussionApprovalEnvelope,
  postApprovalEnvelope,
  setRuntimeVerification,
} from './community-runtime-fixtures.js';
import {
  appendIdentitySelection,
  seedCommunityScope,
} from './community-scope-fixtures.js';
import type { CommunityScopeFixture } from './community-scope-fixtures.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from './community-approval-fixtures.js';
import { migrationSchemaNames } from './migration-schemas.js';

export type SocialActor = Awaited<ReturnType<typeof createRuntimeActor>>;
export const socialAuth = (actor: Pick<SocialActor, 'accessToken'>) =>
  `Bearer ${actor.accessToken}`;

function helpers(
  app: INestApplication,
  pool: Pool,
  scope: CommunityScopeFixture,
) {
  const http = app.getHttpServer();
  const actor = async () => {
    const result = await createRuntimeActor(app);
    const facts = await setRuntimeVerification(
      pool,
      result.accountId,
      scope.institutionId,
      scope.home.regionId,
    );
    await appendIdentitySelection(
      pool,
      result.accountId,
      facts,
      scope,
      scope.home.campusId,
    );
    return result;
  };
  const publish = async (
    owner: SocialActor,
    authorMode: 'named' | 'anonymous' = 'named',
  ) => {
    const body: PublishPost = {
      clientRequestId: randomUUID(),
      spaceId: scope.home.spaceId,
      category: 'discussion',
      text: `Synthetic social source ${randomUUID()}`,
      authorMode,
      commentsPolicy: 'open',
      imageAssetIds: [],
    };
    const approval = await approveEnvelope(
      pool,
      await postApprovalEnvelope(app, pool, owner.accountId, body),
    );
    const response = await request(http)
      .post('/v1/community/posts')
      .set('Authorization', socialAuth(owner))
      .send(body);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(
      response.body.outcome,
      'created',
      JSON.stringify(response.body),
    );
    return { id: response.body.resourceId as string, approval };
  };
  const comment = async (owner: SocialActor, postId: string) => {
    const body: PublishComment = {
      clientRequestId: randomUUID(),
      text: `Synthetic social root ${randomUUID()}`,
      authorMode: 'named',
      imageAssetIds: [],
    };
    const approval = await approveEnvelope(
      pool,
      await discussionApprovalEnvelope(
        app,
        pool,
        owner.accountId,
        postId,
        body,
      ),
    );
    const response = await request(http)
      .post(`/v1/community/posts/${postId}/comments`)
      .set('Authorization', socialAuth(owner))
      .send(body);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(
      response.body.outcome,
      'created',
      JSON.stringify(response.body),
    );
    return { id: response.body.resourceId as string, approval };
  };
  const reply = async (
    owner: SocialActor,
    postId: string,
    rootId: string,
    targetReplyId: string | null = null,
  ) => {
    const body: PublishReply = {
      clientRequestId: randomUUID(),
      text: `Synthetic social reply ${randomUUID()}`,
      authorMode: 'named',
      imageAssetIds: [],
      targetReplyId,
    };
    const approval = await approveEnvelope(
      pool,
      await discussionApprovalEnvelope(
        app,
        pool,
        owner.accountId,
        postId,
        body,
        rootId,
      ),
    );
    const response = await request(http)
      .post(`/v1/community/comments/${rootId}/replies`)
      .set('Authorization', socialAuth(owner))
      .send(body);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal(
      response.body.outcome,
      'created',
      JSON.stringify(response.body),
    );
    return { id: response.body.resourceId as string, approval };
  };
  const list = async (
    owner: SocialActor,
    category: SocialCategory,
    limit = 20,
    cursor?: string,
  ) => {
    const response = await request(http)
      .get('/v1/me/social-updates')
      .set('Authorization', socialAuth(owner))
      .query({ category, limit, ...(cursor ? { cursor } : {}) });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.headers['cache-control'], 'no-store');
    return socialUpdatesPageSchema.parse(response.body);
  };
  const count = async (owner: SocialActor, category: SocialCategory) => {
    const response = await request(http)
      .get('/v1/me/social-updates/unread-count')
      .set('Authorization', socialAuth(owner))
      .query({ category });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return socialUnreadSchema.parse(response.body);
  };
  const read = async (
    owner: SocialActor,
    category: SocialCategory,
    noticeId: string,
  ) => {
    const response = await request(http)
      .put(`/v1/me/social-updates/${noticeId}/read`)
      .set('Authorization', socialAuth(owner))
      .query({ category })
      .send({});
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return socialNoticeReadSchema.parse(response.body);
  };
  const target = async (
    owner: SocialActor,
    category: SocialCategory,
    noticeId: string,
  ) => {
    const response = await request(http)
      .get(`/v1/me/social-updates/${noticeId}/target`)
      .set('Authorization', socialAuth(owner))
      .query({ category });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    return socialNoticeTargetSchema.parse(response.body);
  };
  const profile = async (owner: SocialActor) => {
    let response = await request(http)
      .get('/v1/me/public-profile-ref')
      .set('Authorization', socialAuth(owner));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    // A session alone has no public profile. Create it through the normal writer
    // only when this fixture caller explicitly needs a public persona.
    if (response.body.profileId === null) {
      const created = await request(http)
        .patch('/v1/me/profile')
        .set('Authorization', socialAuth(owner))
        .send({ expectedRevision: 0, nickname: 'SocialActor' });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      response = await request(http)
        .get('/v1/me/public-profile-ref')
        .set('Authorization', socialAuth(owner));
      assert.equal(response.status, 200, JSON.stringify(response.body));
    }
    assert.equal(typeof response.body.profileId, 'string');
    return response.body.profileId as string;
  };
  return {
    app,
    pool,
    http,
    scope,
    actor,
    publish,
    comment,
    reply,
    list,
    count,
    read,
    target,
    profile,
    worker: app.get(SocialUpdatesWorker),
    dispatcher: app.get(SocialUpdatesDispatcher),
  };
}
export type SocialUpdatesFixture = ReturnType<typeof helpers>;

export async function withSocialUpdatesFixture(
  run: (fixture: SocialUpdatesFixture) => Promise<void>,
) {
  const database = process.env['TEST_DATABASE_URL'];
  assert.ok(database, 'Use a new disposable loopback whaleu_test database');
  const url = new URL(database);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/whaleu_test');
  // A fixture-owned mutable copy permits an explicit manual-to-automatic rollout
  // test; production loadConfig remains frozen and no policy provider is replaced.
  const config = {
    ...loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: database,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '20',
      PG_STATEMENT_TIMEOUT_MS: '10000',
      COMMUNITY_UPDATES_PROCESSING: 'automatic',
      COMMUNITY_UPDATES_INTERVAL_MS: '60000',
      COMMUNITY_UPDATES_BATCH_SIZE: '50',
      EXPERIENCE_PROCESSING: 'manual_only',
    }),
  };
  const pool = new Pool(poolOptions(config));
  let suite: PoolClient | undefined,
    app: INestApplication | undefined,
    locked = false,
    owns = false;
  try {
    suite = await pool.connect();
    locked = (
      await suite.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1,$2) locked',
        [MIGRATION_LOCK[0], 2],
      )
    ).rows[0]!.locked;
    assert.equal(locked, true, 'Run disposable suites serially');
    assert.ok(
      supportedPostgresVersion(
        (
          await pool.query<{ v: number }>(
            "SELECT current_setting('server_version_num')::integer v",
          )
        ).rows[0]!.v,
      ),
    );
    assert.equal(
      (
        await pool.query<{ n: number }>(
          "SELECT count(*)::integer n FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
        )
      ).rows[0]!.n,
      0,
      'Refusing existing WhaleU schemas',
    );
    owns = true;
    const migrations = await readMigrations(
      fileURLToPath(new URL('../../migrations', import.meta.url)),
    );
    const socialIndex = migrations.findIndex(
      (migration) => migration.name === '0169_local_social_updates.sql',
    );
    assert.ok(socialIndex > 0);
    await runMigrations(pool, migrations.slice(0, socialIndex), { mode: 'up' });
    // Explicit pre-feature history proves the upgrade does not adopt old edges.
    // These synthetic historical rows are not used to create positive notices.
    const historicalActor = randomUUID(),
      historicalOwner = randomUUID(),
      historicalProfile = randomUUID(),
      historicalRequest = randomUUID();
    await pool.query(
      'INSERT INTO whaleu_identity.accounts(id) VALUES($1),($2)',
      [historicalActor, historicalOwner],
    );
    await pool.query(
      `INSERT INTO whaleu_community.user_follows(follower_id,followed_id,followed_profile_id)
      VALUES($1,$2,$3)`,
      [historicalActor, historicalOwner, historicalProfile],
    );
    await pool.query(
      `INSERT INTO whaleu_community.follow_requests(account_id,request_id,profile_id,following,outcome)
      VALUES($1,$2,$3,true,'applied')`,
      [historicalActor, historicalRequest, historicalProfile],
    );
    await runMigrations(pool, migrations, { mode: 'up' });
    assert.equal(
      (await pool.query('SELECT 1 FROM whaleu_community.social_sources'))
        .rowCount,
      0,
      'Migration never backfills historical positive memberships',
    );
    assert.equal(
      (await pool.query('SELECT 1 FROM whaleu_notifications.social_work'))
        .rowCount,
      0,
    );
    assert.deepEqual(
      (
        await pool.query(
          `SELECT source_request_id,local_creation_transaction
      FROM whaleu_community.user_follows WHERE follower_id=$1`,
          [historicalActor],
        )
      ).rows,
      [{ source_request_id: null, local_creation_transaction: null }],
    );
    app = await NestFactory.create(AppModule.register(config), {
      logger: false,
    });
    configureHttp(app);
    await app.init();
    // Keep real automatic enrollment and cycle(), without wall-clock timer races.
    await app.get(SocialUpdatesDispatcher).beforeApplicationShutdown();
    await app.get(UpdatesDispatcher).stop();
    const scope = await seedCommunityScope(pool);
    await seedReviewPolicy(pool);
    await run(helpers(app, pool, scope));
  } finally {
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
    await pool.end();
  }
}
