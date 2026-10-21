import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
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

import type { PublishPost } from '../../src/community/contracts.js';
import {
  createRuntimeActor,
  setRuntimeVerification,
  postApprovalEnvelope,
} from '../support/community-runtime-fixtures.js';
import {
  seedCommunityScope,
  appendIdentitySelection,
} from '../support/community-scope-fixtures.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from '../support/community-approval-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

// Real AppModule and canonical owner records only, with deterministic database
// waits. No provider, application policy or visibility replacements are installed.
test(
  'Following real HTTP auth, named-only feed, privacy, receipts and concurrent edges',
  { timeout: 120000 },
  async (t) => {
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(database, 'Use disposable loopback whaleu_test');
    const url = new URL(database);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: database,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '20',
      COMMUNITY_UPDATES_PROCESSING: 'disabled',
    });
    const pool = new Pool(poolOptions(config));
    let suite: PoolClient | undefined,
      app: INestApplication | undefined,
      owns = false,
      locked = false;
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
      const http = app.getHttpServer();
      const author = await createRuntimeActor(app),
        reader = await createRuntimeActor(app);
      const auth = (actor = reader) => `Bearer ${actor.accessToken}`;
      const scope = await seedCommunityScope(pool);
      await seedReviewPolicy(pool);
      const facts = await setRuntimeVerification(
        pool,
        author.accountId,
        scope.institutionId,
        scope.home.regionId,
      );
      await appendIdentitySelection(
        pool,
        author.accountId,
        facts,
        scope,
        scope.home.campusId,
      );
      const publish = async (
        text = 'Synthetic current profile post',
        actor = author,
        visibilityUntil: Date | null = null,
      ) => {
        const input: PublishPost = {
          clientRequestId: randomUUID(),
          spaceId: scope.home.spaceId,
          category: 'discussion',
          text,
          imageAssetIds: [],
          authorMode: 'named',
          commentsPolicy: 'open',
        };
        const approval = await approveEnvelope(
          pool,
          await postApprovalEnvelope(app!, pool, actor.accountId, input),
          { visibilityUntil },
        );
        const response = await request(http)
          .post('/v1/community/posts')
          .set('Authorization', auth(actor))
          .send(input);
        assert.equal(response.status, 201, JSON.stringify(response.body));
        assert.equal(
          response.body.outcome,
          'created',
          JSON.stringify(response.body),
        );
        return { id: response.body.resourceId as string, approval };
      };
      const readerFacts = await setRuntimeVerification(
        pool,
        reader.accountId,
        scope.institutionId,
        scope.home.regionId,
      );
      await appendIdentitySelection(
        pool,
        reader.accountId,
        readerFacts,
        scope,
        scope.home.campusId,
      );
      const post = await publish();
      const profileId = (
        await request(http)
          .get('/v1/me/public-profile-ref')
          .set('Authorization', auth(author))
      ).body.profileId as string;
      assert.ok(profileId);
      assert.notEqual(profileId, author.accountId);
      const endpoint = `/v1/profiles/${profileId}/follow`;
      const feed = (cursor?: string) =>
        request(http)
          .get('/v1/community/following/posts')
          .set('Authorization', auth())
          .query({
            spaceId: scope.home.spaceId,
            limit: '1',
            ...(cursor ? { cursor } : {}),
          });
      const set = (following: boolean, requestId = randomUUID()) =>
        (following
          ? request(http).post(endpoint)
          : request(http).delete(endpoint)
        )
          .set('Authorization', auth())
          .send({ requestId });
      await t.test(
        'anonymous access and self-follow are rejected; duplicate parallel follow creates one edge',
        async () => {
          await request(http)
            .get('/v1/community/following/posts')
            .query({ spaceId: scope.home.spaceId })
            .expect(401);
          await request(http)
            .post(endpoint)
            .send({ requestId: randomUUID() })
            .expect(401);
          await request(http)
            .post(endpoint)
            .set('Authorization', auth(author))
            .send({ requestId: randomUUID() })
            .expect(200)
            .expect((response) =>
              assert.equal(response.body.code, 'FOLLOW_SELF_NOT_ALLOWED'),
            );
          const receipt = randomUUID();
          for (const response of await Promise.all([
            set(true, receipt),
            set(true, receipt),
            set(true),
          ]))
            assert.equal(response.status, 200, JSON.stringify(response.body));
          assert.equal(
            (await pool.query('SELECT * FROM whaleu_community.user_follows'))
              .rowCount,
            1,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT revision::text FROM whaleu_community.follow_heads WHERE account_id=$1',
                [reader.accountId],
              )
            ).rows[0].revision,
            '1',
          );
        },
      );
      await t.test(
        'feed projects only named visible followed posts and invalidates navigation on follow changes',
        async () => {
          const anonymousId = randomUUID();
          await pool.query(
            "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'discussion','Anonymous canary','anonymous','open')",
            [anonymousId, scope.home.spaceId, author.accountId],
          );
          const first = await feed();
          assert.equal(first.status, 200, JSON.stringify(first.body));
          assert.equal(first.body.items[0].id, post.id);
          assert.equal(first.body.items[0].author.kind, 'named');
          assert.ok(!JSON.stringify(first.body).includes(author.accountId));
          assert.ok(!JSON.stringify(first.body).includes(anonymousId));
          await publish('Second named post');
          const page = await feed();
          assert.equal(page.status, 200, JSON.stringify(page.body));
          assert.ok(page.body.nextCursor);
          const next = await feed(page.body.nextCursor);
          assert.equal(next.status, 200, JSON.stringify(next.body));
          assert.equal(next.body.items[0].id, post.id);
          const staleIntent = randomUUID();
          await set(true, staleIntent).expect(200);
          await set(false).expect(200);
          await set(true, staleIntent).expect(200);
          assert.equal(
            (await request(http).get(endpoint).set('Authorization', auth()))
              .body.following,
            false,
          );
          await set(true).expect(200);
          await feed(page.body.nextCursor).expect(400);
        },
      );
      await t.test(
        'hidden profile, incoming block, deleted post and inactive account never appear',
        async () => {
          const hide = async (value: boolean) => {
            const current = await request(http)
              .get('/v1/me/profile')
              .set('Authorization', auth(author));
            await request(http)
              .patch('/v1/me/preferences')
              .set('Authorization', auth(author))
              .send({
                expectedRevision: current.body.revision,
                preferences: { hideProfilePosts: value },
              })
              .expect(200);
          };
          await hide(true);
          const hidden = await feed();
          assert.equal(hidden.status, 200, JSON.stringify(hidden.body));
          assert.deepEqual(hidden.body.items, []);
          await hide(false);
          const readerOwn = await request(http)
            .get('/v1/me/profile')
            .set('Authorization', auth());
          await request(http)
            .patch('/v1/me/profile')
            .set('Authorization', auth())
            .send({
              expectedRevision: readerOwn.body.revision,
              nickname: 'Reader',
            })
            .expect(200);
          const readerProfile = (
            await request(http)
              .get('/v1/me/public-profile-ref')
              .set('Authorization', auth())
          ).body.profileId;
          const blocked = await request(http)
            .put('/v1/me/safety/blocks')
            .set('Authorization', auth(author))
            .send({
              clientRequestId: randomUUID(),
              source: { kind: 'profile', id: readerProfile },
              blocked: true,
            });
          assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
          const blockedFeed = await feed();
          assert.equal(
            blockedFeed.status,
            200,
            JSON.stringify(blockedFeed.body),
          );
          assert.deepEqual(blockedFeed.body.items, []);
          await set(false).expect(200);
          await pool.query(
            "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
            [author.accountId],
          );
          const rejected = await set(true);
          assert.equal(rejected.status, 200, JSON.stringify(rejected.body));
          assert.equal(rejected.body.outcome, 'rejected');
          assert.equal(rejected.body.code, 'POST_NOT_FOUND');
          await pool.query(
            'UPDATE whaleu_community.posts SET deleted_at=clock_timestamp() WHERE account_id=$1',
            [author.accountId],
          );
          assert.deepEqual((await feed()).body.items, []);
        },
      );
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
  },
);
