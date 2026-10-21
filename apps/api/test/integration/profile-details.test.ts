import {
  createRuntimeActor,
  setRuntimeVerification,
} from '../support/community-runtime-fixtures.js';
import { seedCommunityScope } from '../support/community-scope-fixtures.js';
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

import { migrationSchemaNames } from '../support/migration-schemas.js';

// Real AppModule and canonical owner records only, with deterministic database
// waits. No provider, application policy or visibility replacements are installed.
test(
  'Profile details HTTP privacy defaults, explicit consent, stale revisions and current access',
  { timeout: 120000 },
  async () => {
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
      const owner = await createRuntimeActor(app),
        viewer = await createRuntimeActor(app);
      const scope = await seedCommunityScope(pool);
      // Named safety commands require genuine canonical verified-phone facts.
      // Seed synthetic test facts rather than replacing the production guard.
      for (const actor of [owner, viewer])
        await setRuntimeVerification(
          pool,
          actor.accountId,
          scope.institutionId,
          scope.home.regionId,
        );
      const auth = (actor = owner) => `Bearer ${actor.accessToken}`;
      await request(http)
        .patch('/v1/me/profile')
        .set('Authorization', auth())
        .send({ expectedRevision: 0, nickname: 'ProfileOwner' })
        .expect(200);
      const profileId = (
        await request(http)
          .get('/v1/me/public-profile-ref')
          .set('Authorization', auth())
      ).body.profileId;
      const own = () =>
        request(http)
          .get('/v1/me/profile-details')
          .set('Authorization', auth());
      const publicView = () =>
        request(http)
          .get(`/v1/profiles/${profileId}/details`)
          .set('Authorization', auth(viewer));
      const fields = {
        region: '北京',
        gender: 'female',
        age: 24,
        showRegion: false,
        showGender: false,
        showAge: false,
      };
      await request(http).get('/v1/me/profile-details').expect(401);
      const initial = await own();
      assert.equal(initial.status, 200, JSON.stringify(initial.body));
      assert.equal(initial.body.revision, 0);
      assert.equal(initial.body.region, null);
      assert.equal(initial.body.showAge, false);
      await request(http)
        .patch('/v1/me/profile-details')
        .set('Authorization', auth())
        .send({ expectedRevision: 0, ...fields, birthDate: '2000-01-01' })
        .expect(400);
      await request(http)
        .patch('/v1/me/profile-details')
        .set('Authorization', auth())
        .send({ expectedRevision: 0, ...fields })
        .expect(200);
      assert.deepEqual((await publicView()).body, {
        status: 'available',
        profileId,
        region: null,
        gender: null,
        age: null,
      });
      const concurrent = await Promise.all(
        [true, false].map((showAge) =>
          request(http)
            .patch('/v1/me/profile-details')
            .set('Authorization', auth())
            .send({
              expectedRevision: 1,
              ...fields,
              showRegion: true,
              showAge,
            }),
        ),
      );
      assert.deepEqual(concurrent.map((r) => r.status).sort(), [200, 409]);
      const current = await own();
      assert.equal(current.body.revision, 2);
      const shown = await publicView();
      assert.equal(shown.body.region, '北京');
      assert.equal(shown.body.gender, null);
      assert.equal(shown.body.age, current.body.showAge ? 24 : null);
      assert.ok(!JSON.stringify(shown.body).includes(owner.accountId));
      await request(http)
        .put('/v1/me/safety/blocks')
        .set('Authorization', auth(viewer))
        .send({
          clientRequestId: randomUUID(),
          source: { kind: 'profile', id: profileId },
          blocked: true,
        })
        .expect(200);
      assert.deepEqual((await publicView()).body, {
        status: 'unavailable',
        profileId,
      });
      await request(http)
        .get(`/v1/profiles/${profileId}/details`)
        .set('Authorization', 'Bearer bad')
        .expect(401);
      const incomingViewer = await createRuntimeActor(app);
      await request(http)
        .patch('/v1/me/profile')
        .set('Authorization', auth(incomingViewer))
        .send({ expectedRevision: 0, nickname: 'IncomingViewer' })
        .expect(200);
      const incomingId = (
        await request(http)
          .get('/v1/me/public-profile-ref')
          .set('Authorization', auth(incomingViewer))
      ).body.profileId;
      await request(http)
        .put('/v1/me/safety/blocks')
        .set('Authorization', auth())
        .send({
          clientRequestId: randomUUID(),
          source: { kind: 'profile', id: incomingId },
          blocked: true,
        })
        .expect(200);
      assert.deepEqual(
        (
          await request(http)
            .get(`/v1/profiles/${profileId}/details`)
            .set('Authorization', auth(incomingViewer))
        ).body,
        { status: 'unavailable', profileId },
      );
      await request(http).get('/v1/me/profile-stats').expect(401);
      const stats = () =>
        request(http).get('/v1/me/profile-stats').set('Authorization', auth());
      const initialStats = await stats();
      assert.equal(initialStats.status, 200, JSON.stringify(initialStats.body));
      assert.deepEqual(initialStats.body.following, {
        status: 'known',
        value: 0,
      });
      const social = await createRuntimeActor(app);
      await request(http)
        .patch('/v1/me/profile')
        .set('Authorization', auth(social))
        .send({ expectedRevision: 0, nickname: 'SocialProfile' })
        .expect(200);
      const socialId = (
        await request(http)
          .get('/v1/me/public-profile-ref')
          .set('Authorization', auth(social))
      ).body.profileId;
      await request(http)
        .post(`/v1/profiles/${socialId}/follow`)
        .set('Authorization', auth())
        .send({ requestId: randomUUID() })
        .expect(200);
      await request(http)
        .post(`/v1/profiles/${profileId}/follow`)
        .set('Authorization', auth(social))
        .send({ requestId: randomUUID() })
        .expect(200);
      const populated = await stats();
      assert.equal(populated.status, 200, JSON.stringify(populated.body));
      assert.deepEqual(populated.body.following, { status: 'known', value: 1 });
      assert.deepEqual(populated.body.followers, { status: 'known', value: 1 });
      assert.deepEqual(populated.body.receivedInteractions, {
        status: 'unavailable',
        value: null,
      });
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM pg_indexes WHERE schemaname='whaleu_community' AND indexname='user_follows_followed' AND indexdef LIKE '%(followed_id, follower_id)%'",
          )
        ).rowCount,
        1,
      );
      const graphWriter = await pool.connect();
      try {
        await graphWriter.query('BEGIN');
        await graphWriter.query(
          'LOCK TABLE whaleu_community.user_follows IN ROW EXCLUSIVE MODE',
        );
        const contended = await stats();
        assert.equal(contended.status, 200, JSON.stringify(contended.body));
        assert.deepEqual(contended.body.following, {
          status: 'unavailable',
          value: null,
        });
        assert.deepEqual(contended.body.followers, {
          status: 'unavailable',
          value: null,
        });
      } finally {
        await graphWriter.query('ROLLBACK');
        graphWriter.release();
      }
      const profileWriter = await pool.connect();
      try {
        await profileWriter.query('BEGIN');
        await profileWriter.query(
          'SELECT account_id FROM whaleu_profile.profiles WHERE account_id=$1 FOR UPDATE',
          [social.accountId],
        );
        const contended = await stats();
        assert.equal(contended.status, 200, JSON.stringify(contended.body));
        assert.deepEqual(contended.body.following, {
          status: 'unavailable',
          value: null,
        });
        assert.deepEqual(contended.body.followers, {
          status: 'unavailable',
          value: null,
        });
      } finally {
        await profileWriter.query('ROLLBACK');
        profileWriter.release();
      }
      await request(http)
        .put('/v1/me/safety/blocks')
        .set('Authorization', auth())
        .send({
          clientRequestId: randomUUID(),
          source: { kind: 'profile', id: socialId },
          blocked: true,
        })
        .expect(200);
      const filtered = await stats();
      assert.equal(filtered.status, 200, JSON.stringify(filtered.body));
      assert.deepEqual(filtered.body.following, { status: 'known', value: 0 });
      assert.deepEqual(filtered.body.followers, { status: 'known', value: 0 });
      await pool.query(
        "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
        [owner.accountId],
      );
      assert.deepEqual(
        (await request(http).get(`/v1/profiles/${profileId}/details`)).body,
        { status: 'unavailable', profileId },
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
