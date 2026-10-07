import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
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
import { hashToken } from '../../src/identity/tokens.js';
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
  setReviewState,
} from '../support/community-approval-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

// Real AppModule and canonical owner records only, with deterministic database
// waits. No provider, application policy or visibility replacements are installed.
test(
  'public discovery owner locks, live policy, deadlines and bounded scans',
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
      const post = await publish();
      const profileId = (
        await request(http)
          .get('/v1/me/public-profile-ref')
          .set('Authorization', auth(author))
      ).body.profileId as string;
      assert.ok(profileId);
      assert.notEqual(profileId, author.accountId);
      const profile = () =>
        request(http)
          .get(`/v1/profiles/${profileId}`)
          .set('Authorization', auth());
      const list = () =>
        request(http)
          .get(`/v1/profiles/${profileId}/posts`)
          .set('Authorization', auth());
      const own = () =>
        request(http).get('/v1/me/profile').set('Authorization', auth(author));
      const hide = async (value: boolean) => {
        const current = await own();
        const response = await request(http)
          .patch('/v1/me/preferences')
          .set('Authorization', auth(author))
          .send({
            expectedRevision: current.body.revision,
            preferences: { hideProfilePosts: value },
          });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        return response;
      };
      const waitQuery = async (pattern: string) => {
        for (let attempt = 0; attempt < 200; attempt++) {
          if (
            (
              await pool.query<{ waiting: boolean }>(
                "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE query LIKE $1 AND wait_event_type='Lock') waiting",
                [pattern],
              )
            ).rows[0]!.waiting
          )
            return;
          await sleep(5);
        }
        assert.fail(`Expected deterministic database lock wait for ${pattern}`);
      };
      const contentLock = async () => {
        const tx = await pool.connect();
        await tx.query('BEGIN');
        await tx.query(
          'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
          [post.id],
        );
        return tx;
      };
      const noPublicPrivateData = (body: unknown) => {
        const text = JSON.stringify(body);
        for (const forbidden of [
          author.accountId,
          reader.accountId,
          author.sessionId,
          reader.sessionId,
          'accountId',
          'sessionId',
          'studentNumber',
          'openid',
          'unionid',
          'phone',
          'wechat',
          'developer',
        ])
          assert.ok(!text.includes(forbidden), forbidden);
      };
      await t.test(
        'read-only self reference preserves absent profile and rejects account redirects',
        async () => {
          const untouched = await createRuntimeActor(app!);
          const before = (
            await pool.query(
              'SELECT 1 FROM whaleu_profile.profiles WHERE account_id=$1',
              [untouched.accountId],
            )
          ).rowCount;
          assert.equal(before, 0);
          assert.deepEqual(
            (
              await request(http)
                .get('/v1/me/public-profile-ref')
                .set('Authorization', auth(untouched))
            ).body,
            { profileId: null },
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_profile.profiles WHERE account_id=$1',
                [untouched.accountId],
              )
            ).rowCount,
            0,
          );
          for (const path of [
            '/v1/me/public-profile-ref',
            `/v1/profiles/${profileId}`,
            `/v1/profiles/${profileId}/posts`,
          ]) {
            assert.equal(
              (
                await request(http)
                  .get(path)
                  .set('Authorization', auth())
                  .query({ accountId: author.accountId })
              ).status,
              400,
            );
            assert.equal(
              (
                await request(http)
                  .get(path)
                  .set('Authorization', auth())
                  .send({ accountId: author.accountId })
              ).status,
              400,
            );
          }
          assert.equal(
            (await request(http).get('/v1/me/public-profile-ref')).status,
            401,
          );
          assert.equal(
            (await request(http).get(`/v1/profiles/${author.accountId}`)).body
              .status,
            'unavailable',
          );
          const result = await profile();
          assert.equal(result.status, 200);
          noPublicPrivateData(result.body);
          assert.equal(result.headers['cache-control'], 'no-store');
          assert.equal(result.headers['vary'], 'Authorization');
        },
      );
      await t.test(
        'privacy committed ahead of a read controls its count and page',
        async () => {
          const writer = await pool.connect();
          await writer.query('BEGIN');
          await writer.query(
            "UPDATE whaleu_profile.profiles SET preferences=jsonb_set(preferences,'{hideProfilePosts}','true'),revision=revision+1 WHERE account_id=$1",
            [author.accountId],
          );
          try {
            const pending = list().then((response) => response);
            await waitQuery(
              '%FROM whaleu_profile.profiles WHERE public_id=$1 FOR SHARE%',
            );
            await writer.query('COMMIT');
            const result = await pending;
            assert.equal(result.status, 200, JSON.stringify(result.body));
            assert.deepEqual(result.body, {
              status: 'hidden',
              profileId,
              items: [],
              total: 0,
              nextCursor: null,
            });
            const basic = await profile();
            assert.equal(basic.body.postCount, 0);
            assert.equal(basic.body.tradeCount, 0);
          } finally {
            await writer.query('ROLLBACK');
            writer.release();
          }
          await hide(false);
        },
      );
      await t.test(
        'privacy cannot change between eligible count and page serialization',
        async () => {
          const blocker = await contentLock();
          try {
            const pending = list().then((response) => response);
            await waitQuery(
              '%SELECT * FROM whaleu_community.posts WHERE id=$1 FOR SHARE%',
            );
            let saved = false;
            const hiding = hide(true).then((response) => {
              saved = true;
              return response;
            });
            await waitQuery(
              '%FROM whaleu_profile.profiles WHERE account_id = $1 FOR UPDATE%',
            );
            assert.equal(saved, false);
            await blocker.query('COMMIT');
            const result = await pending;
            assert.equal(result.status, 200, JSON.stringify(result.body));
            assert.equal(result.body.status, 'available');
            assert.equal(result.body.total, 1);
            assert.deepEqual(
              result.body.items.map((item: { id: string }) => item.id),
              [post.id],
            );
            await hiding;
            assert.equal((await list()).body.status, 'hidden');
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
          }
          await hide(false);
        },
      );
      await t.test(
        'active target account is checked afresh after lifecycle lock waits',
        async () => {
          const writer = await pool.connect();
          await writer.query('BEGIN');
          await writer.query(
            "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
            [author.accountId],
          );
          try {
            const pending = profile().then((response) => response);
            await waitQuery(
              '%SELECT status FROM whaleu_identity.accounts WHERE id=$1 FOR SHARE%',
            );
            await writer.query('COMMIT');
            const result = await pending;
            assert.equal(result.status, 200);
            assert.deepEqual(result.body, { status: 'unavailable', profileId });
            noPublicPrivateData(result.body);
            assert.deepEqual((await list()).body, result.body);
          } finally {
            await writer.query('ROLLBACK');
            writer.release();
          }
          await pool.query(
            "UPDATE whaleu_identity.accounts SET status='active' WHERE id=$1",
            [author.accountId],
          );
        },
      );
      await t.test(
        'unknown, expired and conflicting bilateral coverage never becomes a confirmed empty page',
        async () => {
          for (const patch of [
            "block_coverage='missing'",
            "block_coverage='conflict'",
            "valid_until=clock_timestamp()-interval '1 second'",
          ]) {
            await pool.query(
              `UPDATE whaleu_safety.account_heads SET ${patch} WHERE account_id=$1`,
              [author.accountId],
            );
            for (const route of [profile, list]) {
              const result = await route();
              assert.equal(result.status, 503, JSON.stringify(result.body));
              assert.equal(result.body.error.code, 'SAFETY_UNAVAILABLE');
              noPublicPrivateData(result.body);
            }
            await pool.query(
              "UPDATE whaleu_safety.account_heads SET block_coverage='complete',valid_until=NULL WHERE account_id=$1",
              [author.accountId],
            );
          }
        },
      );
      await t.test(
        'policy deadline expiring while a content lock waits fails closed after the wait',
        async () => {
          const until = new Date(Date.now() + 600);
          await pool.query(
            'UPDATE whaleu_safety.account_heads SET valid_until=$2 WHERE account_id=$1',
            [author.accountId, until],
          );
          const blocker = await contentLock();
          try {
            const pending = list().then((response) => response);
            await waitQuery(
              '%SELECT * FROM whaleu_community.posts WHERE id=$1 FOR SHARE%',
            );
            await sleep(Math.max(1, until.getTime() - Date.now() + 30));
            await blocker.query('COMMIT');
            const result = await pending;
            assert.equal(result.status, 503, JSON.stringify(result.body));
            assert.ok(
              ['COMMUNITY_UNAVAILABLE', 'SAFETY_UNAVAILABLE'].includes(
                result.body.error.code,
              ),
            );
            noPublicPrivateData(result.body);
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
            await pool.query(
              'UPDATE whaleu_safety.account_heads SET valid_until=NULL WHERE account_id=$1',
              [author.accountId],
            );
          }
        },
      );
      await t.test(
        'presented access-token deadline is checked after policy/content waits',
        async () => {
          const transient = await createRuntimeActor(app!);
          const until = new Date(Date.now() + 600);
          await pool.query(
            'UPDATE whaleu_identity.access_tokens SET expires_at=$2 WHERE token_hash=$1',
            [hashToken(transient.accessToken), until],
          );
          const blocker = await contentLock();
          try {
            const pending = request(http)
              .get(`/v1/profiles/${profileId}/posts`)
              .set('Authorization', auth(transient))
              .then((response) => response);
            await waitQuery(
              '%SELECT * FROM whaleu_community.posts WHERE id=$1 FOR SHARE%',
            );
            await sleep(Math.max(1, until.getTime() - Date.now() + 30));
            await blocker.query('COMMIT');
            const result = await pending;
            assert.equal(result.status, 401, JSON.stringify(result.body));
            assert.equal(result.body.error.code, 'ACCESS_TOKEN_EXPIRED');
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
          }
        },
      );
      await t.test(
        'current approval revocation, unknown provenance and target fields are never unfiltered counts',
        async () => {
          await setReviewState(pool, post.approval.decisionId, 'revoked');
          assert.equal((await list()).body.total, 0);
          assert.equal((await profile()).body.postCount, 0);
          await setReviewState(pool, post.approval.decisionId, 'allow');
          assert.equal((await list()).body.total, 1);
          const unknownId = randomUUID();
          await pool.query(
            "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'discussion','Synthetic unknown review','named','open')",
            [unknownId, scope.home.spaceId, author.accountId],
          );
          for (const route of [profile, list]) {
            const result = await route();
            assert.equal(result.status, 503);
            assert.equal(result.body.error.code, 'COMMUNITY_UNAVAILABLE');
            noPublicPrivateData(result.body);
          }
          await pool.query(
            'UPDATE whaleu_community.posts SET deleted_at=clock_timestamp() WHERE id=$1',
            [unknownId],
          );
          assert.equal((await list()).body.total, 1);
        },
      );
      await t.test(
        'more than the explicit candidate bound fails honestly before projections or totals',
        async () => {
          const overflow = await createRuntimeActor(app!);
          await request(http)
            .patch('/v1/me/profile')
            .set('Authorization', auth(overflow))
            .send({ expectedRevision: 0, nickname: 'Overflow' })
            .expect(200);
          const id = (
            await request(http)
              .get('/v1/me/public-profile-ref')
              .set('Authorization', auth(overflow))
          ).body.profileId;
          await pool.query(
            "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy,published_at) SELECT gen_random_uuid(),$1,$2,'discussion','Synthetic bounded scan','named','open','2001-01-01'::timestamptz FROM generate_series(1,1025)",
            [scope.home.spaceId, overflow.accountId],
          );
          for (const suffix of ['', '/posts']) {
            const result = await request(http)
              .get(`/v1/profiles/${id}${suffix}`)
              .set('Authorization', auth());
            assert.equal(result.status, 503, JSON.stringify(result.body));
            assert.equal(result.body.error.code, 'COMMUNITY_UNAVAILABLE');
            assert.ok(!JSON.stringify(result.body).includes('1025'));
          }
          const current = await request(http)
            .get('/v1/me/profile')
            .set('Authorization', auth(overflow));
          await request(http)
            .patch('/v1/me/preferences')
            .set('Authorization', auth(overflow))
            .send({
              expectedRevision: current.body.revision,
              preferences: { hideProfilePosts: true },
            })
            .expect(200);
          assert.equal(
            (await request(http).get(`/v1/profiles/${id}/posts`)).body.status,
            'hidden',
          );
        },
      );
      await t.test(
        'oldest approved content remains reachable without an invented date cutoff',
        async () => {
          const historic = await createRuntimeActor(app!);
          const historicalFacts = await setRuntimeVerification(
            pool,
            historic.accountId,
            scope.institutionId,
            scope.home.regionId,
          );
          await appendIdentitySelection(
            pool,
            historic.accountId,
            historicalFacts,
            scope,
            scope.home.campusId,
          );
          // Fixture-only creation time. The actual normal publication/review path
          // still owns every row, immutable binding and entitlement decision.
          await pool.query(
            "ALTER TABLE whaleu_community.posts ALTER COLUMN published_at SET DEFAULT '2001-01-01T00:00:00.000Z'::timestamptz",
          );
          let oldId: string;
          try {
            oldId = (await publish('Synthetic old approved post', historic)).id;
          } finally {
            await pool.query(
              "ALTER TABLE whaleu_community.posts ALTER COLUMN published_at SET DEFAULT date_trunc('milliseconds',clock_timestamp())",
            );
          }
          const newId = (
            await publish('Synthetic recent approved post', historic)
          ).id;
          const publicId = (
            await request(http)
              .get('/v1/me/public-profile-ref')
              .set('Authorization', auth(historic))
          ).body.profileId;
          const first = await request(http)
            .get(`/v1/profiles/${publicId}/posts`)
            .query({ limit: '1' });
          assert.equal(first.status, 200, JSON.stringify(first.body));
          assert.equal(first.body.total, 2);
          assert.equal(first.body.items[0].id, newId);
          const last = await request(http)
            .get(`/v1/profiles/${publicId}/posts`)
            .query({ limit: '1', cursor: first.body.nextCursor });
          assert.equal(last.status, 200, JSON.stringify(last.body));
          assert.equal(last.body.total, 2);
          assert.equal(last.body.nextCursor, null);
          assert.equal(last.body.items[0].id, oldId);
          assert.equal(
            last.body.items[0].publishedAt,
            '2001-01-01T00:00:00.000Z',
          );
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
