import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { CampusService } from '../../src/campus/campus.service.js';
import type { CampusPage } from '../../src/campus/contracts.js';
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
import { ApplicationError } from '../../src/http/application-error.js';
import { configureHttp } from '../../src/http/http.js';
import { IDENTITY_PROVIDER } from '../../src/identity/contracts.js';
import { IdentityService } from '../../src/identity/identity.service.js';
import { preferenceDefaults } from '../../src/profile/contracts.js';
import type { OwnProfile } from '../../src/profile/contracts.js';
import { ProfileService } from '../../src/profile/profile.service.js';

const codeIs = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;

test(
  'real PostgreSQL campus directory and own profile transactional HTTP contract',
  { timeout: 60000 },
  async (t) => {
    const connectionString = process.env['TEST_DATABASE_URL'];
    assert.ok(
      connectionString,
      'Set TEST_DATABASE_URL to disposable local whaleu_test; no silent skips',
    );
    const url = new URL(connectionString);
    assert.ok(
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
      'Integration tests require loopback',
    );
    assert.equal(
      url.pathname,
      '/whaleu_test',
      'Integration tests require dedicated whaleu_test database',
    );
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: connectionString,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '8',
      PG_STATEMENT_TIMEOUT_MS: '10000',
    });
    const pool = new Pool(poolOptions(config));
    let suiteClient: PoolClient | undefined;
    let suiteLocked = false;
    let ownsSchemas = false;
    let app: INestApplication | undefined;
    const institutionId = randomUUID();
    const activeId = randomUUID();
    const secondId = randomUUID();
    const inactiveId = randomUUID();
    try {
      suiteClient = await pool.connect();
      suiteLocked =
        (
          await suiteClient.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_lock($1,$2) AS locked',
            [MIGRATION_LOCK[0], 2],
          )
        ).rows[0]?.locked === true;
      assert.equal(
        suiteLocked,
        true,
        'Another suite is using the disposable database; run serially',
      );
      const version = (
        await pool.query<{ version: number }>(
          "SELECT current_setting('server_version_num')::integer AS version",
        )
      ).rows[0]!.version;
      assert.ok(supportedPostgresVersion(version), 'PostgreSQL 18.6+ required');
      const existing = await pool.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname IN ('whaleu_meta','whaleu_identity','whaleu_campus','whaleu_profile','whaleu_notifications','whaleu_community','whaleu_authorization','whaleu_verification')",
      );
      assert.equal(
        existing.rows[0]?.count,
        0,
        'Refusing existing schemas; use a fresh disposable database',
      );
      const migrations = await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      );
      assert.ok(
        migrations.some(({ name }) => name === '0003_campus_profile.sql'),
      );
      ownsSchemas = true;
      await runMigrations(pool, migrations, { mode: 'up' });
      await runMigrations(pool, migrations, { mode: 'up' });
      const module = await Test.createTestingModule({
        imports: [AppModule.register(config)],
      })
        .overrideProvider(IDENTITY_PROVIDER)
        .useValue({
          exchange: async (code: string) => ({
            provider: 'wechat',
            appId: 'synthetic-local-campus-profile-test',
            subject: code,
          }),
        })
        .compile();
      app = module.createNestApplication({ logger: false });
      configureHttp(app);
      await app.init();
      const identity = app.get(IdentityService);
      const profiles = app.get(ProfileService);
      const campuses = app.get(CampusService);
      const first = await identity.login('first');
      const second = await identity.login('second');
      const auth = `Bearer ${first.accessToken}`;
      const http = app.getHttpServer();

      await t.test(
        'migration is empty of fictional campuses and profile GET is read-only with honest defaults',
        async () => {
          assert.equal(
            (await campuses.list({ page: 1, pageSize: 20 })).total,
            0,
          );
          const result = await request(http)
            .get('/v1/me/profile')
            .set('Authorization', auth)
            .expect(200);
          assert.deepEqual(result.body, {
            accountId: first.accountId,
            nickname: null,
            bio: '',
            selectedCampus: null,
            revision: 0,
            preferences: preferenceDefaults,
          });
          assert.equal(
            (
              await pool.query<{ count: number }>(
                'SELECT count(*)::integer AS count FROM whaleu_profile.profiles',
              )
            ).rows[0]?.count,
            0,
          );
        },
      );

      // Entirely synthetic local fixtures; never production campus names or IDs.
      await pool.query(
        'INSERT INTO whaleu_campus.institutions(id,name) VALUES ($1,$2)',
        [institutionId, 'Synthetic 测试 University'],
      );
      await pool.query(
        `INSERT INTO whaleu_campus.campuses(id,institution_id,full_name,short_name,district,is_active,sort_order)
      VALUES ($1,$4,'Synthetic North','N','Test District',true,20),
        ($2,$4,'Literal %_ Campus',NULL,'Other District',true,10),
        ($3,$4,'Inactive Campus','I','Test District',false,100)`,
        [activeId, secondId, inactiveId, institutionId],
      );

      await t.test(
        'directory is public, ordered, searchable and bounded with correct empty-page totals',
        async () => {
          const page = await campuses.list({ page: 1, pageSize: 2 });
          assert.deepEqual(
            page.items.map(({ id }) => id),
            [activeId, secondId],
          );
          assert.equal(page.total, 3);
          assert.equal(
            page.items[0]?.institutionName,
            'Synthetic 测试 University',
          );
          const response = await request(http)
            .get('/v1/campuses?page=2&pageSize=2')
            .expect(200);
          assert.deepEqual(
            (response.body as CampusPage).items.map(({ id }) => id),
            [inactiveId],
          );
          const empty = await campuses.list({ page: 3, pageSize: 2 });
          assert.deepEqual(empty.items, []);
          assert.equal(empty.total, 3);
          assert.equal(
            (
              await campuses.list({
                page: 1,
                pageSize: 20,
                district: 'Test District',
              })
            ).total,
            2,
          );
          assert.equal(
            (await campuses.list({ page: 1, pageSize: 20, q: '%_' })).total,
            1,
          );
          assert.equal(
            (await campuses.list({ page: 1, pageSize: 20, q: 'north' }))
              .items[0]?.id,
            activeId,
          );
          assert.equal(
            (await campuses.list({ page: 1, pageSize: 20, q: "' OR 1=1 --" }))
              .total,
            0,
          );
        },
      );

      await t.test(
        'profile update persists normalized values, uses only authenticated account and keeps bio SQL literal',
        async () => {
          const result = await request(http)
            .patch('/v1/me/profile')
            .set('Authorization', auth)
            .send({
              expectedRevision: 0,
              nickname: ' 测试_1 ',
              bio: " 甲\r\n乙'; DROP TABLE profiles; -- ",
            })
            .expect(200);
          const profile = result.body as OwnProfile;
          assert.equal(profile.nickname, '测试_1');
          assert.equal(profile.bio, "甲\n乙'; DROP TABLE profiles; --");
          assert.equal(profile.revision, 1);
          assert.equal((await profiles.get(second.accountId)).nickname, null);
          await request(http)
            .patch('/v1/me/profile')
            .set('Authorization', auth)
            .send({
              expectedRevision: 1,
              nickname: 'Victim',
              accountId: second.accountId,
            })
            .expect(400);
          await request(http)
            .patch('/v1/me/profile')
            .set('Authorization', auth)
            .send({
              expectedRevision: 1,
              nickname: 'Admin',
              verifiedInstitutionId: institutionId,
              adminScope: institutionId,
            })
            .expect(400);
          assert.equal((await profiles.get(first.accountId)).revision, 1);
        },
      );

      await t.test(
        'preference patch preserves defaults and validates merged mutually exclusive flags with rollback',
        async () => {
          const result = await request(http)
            .patch('/v1/me/preferences')
            .set('Authorization', auth)
            .send({
              expectedRevision: 1,
              preferences: {
                defaultCommentAnonymousEnabled: true,
                hideProfilePosts: true,
              },
            })
            .expect(200);
          const saved = result.body as OwnProfile;
          assert.equal(saved.revision, 2);
          assert.deepEqual(saved.preferences, {
            ...preferenceDefaults,
            defaultCommentAnonymousEnabled: true,
            hideProfilePosts: true,
          });
          await request(http)
            .patch('/v1/me/preferences')
            .set('Authorization', auth)
            .send({
              expectedRevision: 2,
              preferences: { defaultCommentNonAnonymousEnabled: true },
            })
            .expect(400);
          assert.equal((await profiles.get(first.accountId)).revision, 2);
          await request(http)
            .patch('/v1/me/preferences')
            .set('Authorization', auth)
            .send({
              expectedRevision: 2,
              preferences: {
                defaultCommentAnonymousEnabled: false,
                defaultCommentNonAnonymousEnabled: true,
              },
            })
            .expect(200);
          assert.equal((await profiles.get(first.accountId)).revision, 3);
        },
      );

      await t.test(
        'selection writes browsing context only and never grants verification or administration',
        async () => {
          const result = await request(http)
            .put('/v1/me/campus')
            .set('Authorization', auth)
            .send({ expectedRevision: 3, campusId: activeId })
            .expect(200);
          const saved = result.body as OwnProfile;
          assert.equal(saved.selectedCampus?.id, activeId);
          assert.equal(saved.revision, 4);
          assert.equal(saved.preferences.hideProfilePosts, true);
          assert.deepEqual(Object.keys(saved).sort(), [
            'accountId',
            'bio',
            'nickname',
            'preferences',
            'revision',
            'selectedCampus',
          ]);
          assert.equal(
            (await profiles.get(second.accountId)).selectedCampus,
            null,
          );
          const authorities = await pool.query<{ count: number }>(
            "SELECT count(*)::integer AS count FROM information_schema.columns WHERE table_schema='whaleu_profile' AND column_name ~ '(verified|admin)'",
          );
          assert.equal(authorities.rows[0]?.count, 0);
        },
      );

      await t.test(
        'missing and inactive selection fail with distinct codes, no writes or default-row side effects',
        async () => {
          for (const [id, code] of [
            [inactiveId, 'CAMPUS_UNAVAILABLE'],
            [randomUUID(), 'CAMPUS_NOT_FOUND'],
          ] as const)
            await assert.rejects(
              profiles.selectCampus(second.accountId, {
                expectedRevision: 0,
                campusId: id,
              }),
              codeIs(code),
            );
          assert.equal((await profiles.get(second.accountId)).revision, 0);
          assert.equal(
            (
              await pool.query<{ count: number }>(
                'SELECT count(*)::integer AS count FROM whaleu_profile.profiles WHERE account_id=$1',
                [second.accountId],
              )
            ).rows[0]?.count,
            0,
          );
          await request(http)
            .put('/v1/me/campus')
            .set('Authorization', auth)
            .send({ expectedRevision: 4, campusId: inactiveId })
            .expect(409);
          await request(http)
            .put('/v1/me/campus')
            .set('Authorization', auth)
            .send({ expectedRevision: 4, campusId: randomUUID() })
            .expect(404);
          assert.equal((await profiles.get(first.accountId)).revision, 4);
        },
      );

      await t.test(
        'concurrent first writes and later cross-operation writes have one winner without lost updates',
        async () => {
          const initial = await Promise.allSettled([
            profiles.update(second.accountId, {
              expectedRevision: 0,
              nickname: 'Alpha',
            }),
            profiles.update(second.accountId, {
              expectedRevision: 0,
              nickname: 'Beta',
            }),
          ]);
          assert.equal(
            initial.filter(({ status }) => status === 'fulfilled').length,
            1,
          );
          const initialFailure = initial.find(
            (result) => result.status === 'rejected',
          );
          assert.ok(
            initialFailure?.status === 'rejected' &&
              codeIs('PROFILE_REVISION_CONFLICT')(initialFailure.reason),
          );
          const race = await Promise.allSettled([
            profiles.update(first.accountId, {
              expectedRevision: 4,
              bio: 'winner',
            }),
            profiles.updatePreferences(first.accountId, {
              expectedRevision: 4,
              preferences: { showHotTopic: false },
            }),
          ]);
          assert.equal(
            race.filter(({ status }) => status === 'fulfilled').length,
            1,
          );
          const failure = race.find((result) => result.status === 'rejected');
          assert.ok(
            failure?.status === 'rejected' &&
              codeIs('PROFILE_REVISION_CONFLICT')(failure.reason),
          );
          const saved = await profiles.get(first.accountId);
          assert.equal(saved.revision, 5);
          assert.equal(saved.selectedCampus?.id, activeId);
          assert.equal(saved.preferences.hideProfilePosts, true);
          const conflict = await request(http)
            .patch('/v1/me/profile')
            .set('Authorization', auth)
            .send({ expectedRevision: 4, nickname: 'Stale' })
            .expect(409);
          assert.equal(
            (conflict.body as { error: { code: string } }).error.code,
            'PROFILE_REVISION_CONFLICT',
          );
        },
      );

      await t.test(
        'database enforces foreign keys, scalar bounds, exact preference shape and exclusivity',
        async () => {
          const invalidOperations = [
            [
              'INSERT INTO whaleu_profile.profiles(account_id) VALUES ($1)',
              [randomUUID()],
            ],
            [
              'UPDATE whaleu_profile.profiles SET nickname=$2 WHERE account_id=$1',
              [first.accountId, 'x'.repeat(21)],
            ],
            [
              'UPDATE whaleu_profile.profiles SET nickname=$2 WHERE account_id=$1',
              [first.accountId, 'space name'],
            ],
            [
              'UPDATE whaleu_profile.profiles SET bio=$2 WHERE account_id=$1',
              [first.accountId, '🐳'.repeat(101)],
            ],
            [
              'UPDATE whaleu_profile.profiles SET bio=$2 WHERE account_id=$1',
              [first.accountId, 'a\n'.repeat(6) + 'z'],
            ],
            [
              'UPDATE whaleu_profile.profiles SET selected_campus_id=$2 WHERE account_id=$1',
              [first.accountId, randomUUID()],
            ],
            [
              'UPDATE whaleu_profile.profiles SET preferences=$2::jsonb WHERE account_id=$1',
              [
                first.accountId,
                JSON.stringify({ ...preferenceDefaults, extra: true }),
              ],
            ],
            [
              'UPDATE whaleu_profile.profiles SET preferences=$2::jsonb WHERE account_id=$1',
              [first.accountId, '{}'],
            ],
            [
              'UPDATE whaleu_profile.profiles SET preferences=$2::jsonb WHERE account_id=$1',
              [
                first.accountId,
                JSON.stringify({
                  ...preferenceDefaults,
                  hideProfilePosts: null,
                }),
              ],
            ],
            [
              'UPDATE whaleu_profile.profiles SET preferences=$2::jsonb WHERE account_id=$1',
              [
                first.accountId,
                JSON.stringify({
                  ...preferenceDefaults,
                  defaultCommentAnonymousEnabled: true,
                  defaultCommentNonAnonymousEnabled: true,
                }),
              ],
            ],
          ] as const;
          for (const [sql, values] of invalidOperations)
            await assert.rejects(pool.query(sql, [...values]));
          assert.equal((await profiles.get(first.accountId)).revision, 5);
        },
      );

      await t.test(
        'selection eligibility row lock blocks concurrent deactivation until transaction finishes',
        async () => {
          const holder = await pool.connect();
          const updater = await pool.connect();
          try {
            await holder.query('BEGIN');
            await campuses.requireSelectable(secondId, holder);
            await updater.query('BEGIN');
            await updater.query("SET LOCAL lock_timeout = '75ms'");
            await assert.rejects(
              updater.query(
                'UPDATE whaleu_campus.campuses SET is_active=false WHERE id=$1',
                [secondId],
              ),
              (error: unknown) =>
                !!error &&
                typeof error === 'object' &&
                'code' in error &&
                error.code === '55P03',
            );
            await updater.query('ROLLBACK');
            await holder.query('COMMIT');
            await updater.query(
              'UPDATE whaleu_campus.campuses SET is_active=false WHERE id=$1',
              [secondId],
            );
            await assert.rejects(
              profiles.selectCampus(first.accountId, {
                expectedRevision: 5,
                campusId: secondId,
              }),
              codeIs('CAMPUS_UNAVAILABLE'),
            );
          } finally {
            await holder.query('ROLLBACK');
            await updater.query('ROLLBACK');
            holder.release();
            updater.release();
          }
        },
      );

      await t.test(
        'revoked and blocked sessions cannot read or mutate profile; account isolation remains',
        async () => {
          await identity.logout(second.accessToken);
          await request(http)
            .get('/v1/me/profile')
            .set('Authorization', `Bearer ${second.accessToken}`)
            .expect(401);
          await pool.query(
            "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
            [first.accountId],
          );
          await request(http)
            .get('/v1/me/profile')
            .set('Authorization', auth)
            .expect(403);
          await request(http)
            .patch('/v1/me/profile')
            .set('Authorization', auth)
            .send({ expectedRevision: 5, nickname: 'Blocked' })
            .expect(403);
          assert.equal((await profiles.get(first.accountId)).revision, 5);
        },
      );
    } finally {
      try {
        await app?.close();
        if (ownsSchemas) {
          await pool.query('DROP SCHEMA IF EXISTS whaleu_verification CASCADE');
          await pool.query(
            'DROP SCHEMA IF EXISTS whaleu_authorization CASCADE',
          );
          await pool.query(
            'DROP SCHEMA IF EXISTS whaleu_notifications CASCADE',
          );
          await pool.query('DROP SCHEMA IF EXISTS whaleu_community CASCADE');
          await pool.query('DROP SCHEMA IF EXISTS whaleu_profile CASCADE');
          await pool.query('DROP SCHEMA IF EXISTS whaleu_campus CASCADE');
          await pool.query('DROP SCHEMA IF EXISTS whaleu_identity CASCADE');
          await pool.query('DROP SCHEMA IF EXISTS whaleu_meta CASCADE');
        }
      } finally {
        if (suiteLocked)
          await suiteClient?.query('SELECT pg_advisory_unlock($1,$2)', [
            MIGRATION_LOCK[0],
            2,
          ]);
        suiteClient?.release();
        await pool.end();
      }
    }
  },
);
