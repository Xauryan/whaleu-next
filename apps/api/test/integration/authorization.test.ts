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
import { AuthorizationService } from '../../src/authorization/authorization.service.js';
import type { PrivilegedRole } from '../../src/authorization/contracts.js';
import { COMMUNITY_VISIBILITY } from '../../src/community/community-policy.js';
import type { VisibilitySubject } from '../../src/community/community-policy.js';
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
import { ApplicationError } from '../../src/http/application-error.js';
import { configureHttp } from '../../src/http/http.js';
import { IDENTITY_PROVIDER } from '../../src/identity/contracts.js';
import { IdentityService } from '../../src/identity/identity.service.js';
import { STUDENT_IDENTITY_SOURCE } from '../../src/identity-privacy/contracts.js';
import type {
  StudentIdentitySource,
  VerifiedStudentIdentity,
} from '../../src/identity-privacy/contracts.js';

const errorIs = (code: string) => (error: unknown) =>
  error instanceof ApplicationError && error.code === code;
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class FixtureStudents implements StudentIdentitySource {
  afterRead: (() => Promise<void>) | null = null;
  async resolve(
    accountId: string,
    transaction: PoolClient,
  ): Promise<VerifiedStudentIdentity> {
    const row = (
      await transaction.query<{ verified: boolean; student_number: string }>(
        'SELECT verified,student_number FROM whaleu_authorization_test.students WHERE account_id=$1 FOR SHARE',
        [accountId],
      )
    ).rows[0];
    await this.afterRead?.();
    return row?.verified
      ? {
          status: 'verified',
          studentNumber: row.student_number,
          validUntil: null,
        }
      : { status: 'unverified' };
  }
}

test(
  'real PostgreSQL explicit role grants and fail-closed audited developer identity views',
  { timeout: 120000 },
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
      PG_POOL_MAX: '12',
      PG_STATEMENT_TIMEOUT_MS: '10000',
    });
    const pool = new Pool(poolOptions(config));
    let suite: PoolClient | undefined,
      app: INestApplication | undefined,
      ordinary: INestApplication | undefined;
    let locked = false,
      owns = false;
    const students = new FixtureStudents();
    const visibility = {
      blocked: new Set<string>(),
      unavailable: false,
      check: async (_actor: string, subject: VisibilitySubject) =>
        visibility.unavailable
          ? { kind: 'unavailable' }
          : visibility.blocked.has(subject.contentId)
            ? { kind: 'deny', reason: 'POST_NOT_FOUND' }
            : { kind: 'allow', value: undefined },
    };
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) AS locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert.equal(locked, true, 'Run synthetic integration suites serially');
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
          await pool.query<{ count: number }>(
            "SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname IN ('whaleu_meta','whaleu_identity','whaleu_campus','whaleu_profile','whaleu_community','whaleu_authorization','whaleu_verification','whaleu_authorization_test')",
          )
        ).rows[0]!.count,
        0,
        'Refusing existing schemas',
      );
      owns = true;
      const migrations = await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      );
      await runMigrations(pool, migrations, { mode: 'up' });
      await runMigrations(pool, migrations, { mode: 'up' });
      await pool.query(
        'CREATE SCHEMA whaleu_authorization_test; CREATE TABLE whaleu_authorization_test.students(account_id uuid PRIMARY KEY,verified boolean NOT NULL,student_number text NOT NULL)',
      );
      const provider = {
        exchange: async (code: string) => ({
          provider: 'wechat',
          appId: 'synthetic-local-authorization',
          subject: code,
        }),
      };
      const module = await Test.createTestingModule({
        imports: [AppModule.register(config)],
      })
        .overrideProvider(IDENTITY_PROVIDER)
        .useValue(provider)
        .overrideProvider(COMMUNITY_VISIBILITY)
        .useValue(visibility)
        .overrideProvider(STUDENT_IDENTITY_SOURCE)
        .useValue(students)
        .compile();
      app = module.createNestApplication({ logger: false });
      configureHttp(app);
      await app.init();
      const identity = app.get(IdentityService),
        authorization = app.get(AuthorizationService),
        database = app.get(DatabaseService);
      const developer = await identity.login('synthetic-developer'),
        superAdmin = await identity.login('synthetic-super'),
        school = await identity.login('synthetic-school'),
        member = await identity.login('synthetic-member'),
        author = await identity.login('synthetic-author');
      const region = randomUUID(),
        otherRegion = randomUUID(),
        space = randomUUID(),
        anonymousPost = randomUUID(),
        namedPost = randomUUID(),
        comment = randomUUID();
      const http = app.getHttpServer();
      const auth = (token: string) => `Bearer ${token}`;
      const target = { kind: 'post', id: anonymousPost };
      const view = (token: string, targets: unknown[] = [target]) =>
        request(http)
          .post('/v1/identity-privacy/content-identities')
          .set('Authorization', auth(token))
          .send({ targets });
      const grant = async (
        accountId: string,
        role: PrivilegedRole,
        regionId: string | null = null,
        validFrom: Date | null = null,
        expiresAt: Date | null = null,
      ) => {
        const id = randomUUID();
        await pool.query(
          `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference,valid_from,expires_at) VALUES ($1,$2,$3,$4,$5,'synthetic-fixture-only',coalesce($6,clock_timestamp()),$7)`,
          [
            id,
            accountId,
            role,
            regionId,
            developer.accountId,
            validFrom,
            expiresAt,
          ],
        );
        return id;
      };
      const revoke = async (grantId: string) =>
        pool.query(
          'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$2 WHERE id=$1',
          [grantId, developer.accountId],
        );

      await t.test(
        'migration and every fresh login remain member with no implicit developer assignment',
        async () => {
          assert.equal(
            (await pool.query('SELECT * FROM whaleu_authorization.role_grants'))
              .rowCount,
            0,
          );
          for (const actor of [developer, superAdmin, school, member, author]) {
            const response = await request(http)
              .get('/v1/me/authorization')
              .set('Authorization', auth(actor.accessToken))
              .expect(200);
            assert.deepEqual(response.body, {
              role: 'member',
              management: { global: false, operatingRegionIds: [] },
              identityView: { allowed: false, maxBatchSize: 20 },
            });
            assert.equal(response.headers['cache-control'], 'no-store');
          }
          await request(http).get('/v1/me/authorization').expect(401);
          await request(http)
            .post('/v1/identity-privacy/content-identities')
            .send({ targets: [target] })
            .expect(401);
          for (const path of [
            '/v1/authorization/grants',
            '/v1/authorization/bootstrap',
            '/v1/me/role',
          ])
            await request(http)
              .post(path)
              .send({ role: 'developer' })
              .expect(404);
        },
      );
      await pool.query(
        "INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES ($1,'Synthetic scope A',true),($2,'Synthetic scope B',true)",
        [region, otherRegion],
      );
      await pool.query(
        "INSERT INTO whaleu_community.spaces(id,kind,operating_region_id,name,is_active) VALUES ($1,'regional',$2,'Synthetic space',true)",
        [space, region],
      );
      await pool.query(
        "INSERT INTO whaleu_profile.profiles(account_id,nickname) VALUES ($1,'PrivateWhale')",
        [author.accountId],
      );
      await pool.query(
        "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES ($1,$3,$4,'discussion','synthetic anonymous','anonymous','open'),($2,$3,$4,'discussion','synthetic named','named','open')",
        [anonymousPost, namedPost, space, author.accountId],
      );
      await pool.query(
        "INSERT INTO whaleu_community.thread_personas(id,post_id,account_id,display_name) VALUES ($1,$2,$3,'匿名鲸鱼')",
        [randomUUID(), anonymousPost, author.accountId],
      );
      await pool.query(
        "INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode) VALUES ($1,$2,$3,'synthetic comment','anonymous')",
        [comment, anonymousPost, author.accountId],
      );
      await pool.query(
        "INSERT INTO whaleu_authorization_test.students VALUES ($1,true,'00004721')",
        [author.accountId],
      );
      let developerGrant = await grant(developer.accountId, 'developer');
      await grant(superAdmin.accountId, 'super_admin');
      const schoolGrant = await grant(school.accountId, 'school_admin', region);

      await t.test(
        'grant hierarchy and fixed operating-region scope do not confer developer identity capability',
        async () => {
          assert.equal(
            (await authorization.capabilities(developer.accessToken)).role,
            'developer',
          );
          assert.equal(
            (await authorization.capabilities(superAdmin.accessToken))
              .management.global,
            true,
          );
          assert.deepEqual(
            (await authorization.capabilities(school.accessToken)).management,
            { global: false, operatingRegionIds: [region] },
          );
          await database.transaction((tx) =>
            authorization.requireRegionManagement(school.accountId, region, tx),
          );
          await assert.rejects(
            database.transaction((tx) =>
              authorization.requireRegionManagement(
                school.accountId,
                otherRegion,
                tx,
              ),
            ),
            errorIs('AUTHORIZATION_REQUIRED'),
          );
          await assert.rejects(
            database.transaction((tx) =>
              authorization.requireRegionManagement(school.accountId, null, tx),
            ),
            errorIs('AUTHORIZATION_REQUIRED'),
          );
          for (const actor of [member, superAdmin, school]) {
            const denied = await view(actor.accessToken).expect(403);
            assert.equal(denied.body.error.code, 'AUTHORIZATION_REQUIRED');
            assert.equal(
              JSON.stringify(denied.body).includes(author.accountId),
              false,
            );
          }
          assert.equal(
            (
              await pool.query(
                "SELECT * FROM whaleu_authorization.identity_view_audit WHERE outcome='denied'",
              )
            ).rowCount,
            3,
          );
          await pool.query(
            'UPDATE whaleu_campus.operating_regions SET is_active=false WHERE id=$1',
            [region],
          );
          assert.equal(
            (await authorization.capabilities(school.accessToken)).role,
            'member',
          );
          await pool.query(
            'UPDATE whaleu_campus.operating_regions SET is_active=true WHERE id=$1',
            [region],
          );
        },
      );

      await t.test(
        'developer-only separate batch projection reveals verified numbers for named and anonymous authors with metadata-only audit',
        async () => {
          const response = await view(developer.accessToken, [
            target,
            { kind: 'post', id: namedPost },
            { kind: 'comment', id: comment },
          ])
            .set('x-request-id', randomUUID())
            .expect(200);
          assert.equal(response.headers['cache-control'], 'no-store');
          assert.equal(response.headers['vary'], 'Authorization');
          assert.equal(response.body.items.length, 3);
          for (const item of response.body.items)
            assert.deepEqual(item.identity, {
              accountId: author.accountId,
              nickname: 'PrivateWhale',
              avatar: null,
              studentNumber: '00004721',
              studentNumberStatus: 'verified',
            });
          assert.deepEqual(
            response.body.items.map(
              (item: { authorMode: string }) => item.authorMode,
            ),
            ['anonymous', 'named', 'anonymous'],
          );
          const audit = await pool.query(
            'SELECT * FROM whaleu_authorization.identity_view_audit WHERE request_id=$1',
            [response.headers['x-request-id']],
          );
          assert.equal(audit.rowCount, 3);
          const serialized = JSON.stringify(audit.rows);
          for (const privateValue of [
            '00004721',
            'PrivateWhale',
            author.accountId,
            developer.accessToken,
          ])
            assert.equal(serialized.includes(privateValue), false);
          const publicPost = await request(http)
            .get(`/v1/community/posts/${anonymousPost}`)
            .set('Authorization', auth(developer.accessToken))
            .expect(200);
          const publicSerialized = JSON.stringify(publicPost.body);
          for (const secret of [
            'accountId',
            'studentNumber',
            'PrivateWhale',
            author.accountId,
            '00004721',
          ])
            assert.equal(publicSerialized.includes(secret), false);
        },
      );

      await t.test(
        'strict bounded request rejects attacker supplied identity or roles before source access',
        async () => {
          const before = (
            await pool.query(
              'SELECT * FROM whaleu_authorization.identity_view_audit',
            )
          ).rowCount;
          for (const body of [
            { targets: [target], role: 'developer' },
            { targets: [{ ...target, accountId: member.accountId }] },
            { targets: [] },
            { targets: [target, target] },
            {
              targets: Array.from({ length: 21 }, () => ({
                kind: 'post',
                id: randomUUID(),
              })),
            },
          ])
            await request(http)
              .post('/v1/identity-privacy/content-identities')
              .set('Authorization', auth(developer.accessToken))
              .send(body)
              .expect(400);
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM whaleu_authorization.identity_view_audit',
              )
            ).rowCount,
            before,
          );
        },
      );

      await t.test(
        'hidden/deleted/blocked content and parent/scope cannot be revealed by a valid developer grant',
        async () => {
          for (const change of [
            "visibility='hidden'",
            'deleted_at=clock_timestamp()',
          ]) {
            await pool.query(
              `UPDATE whaleu_community.posts SET ${change} WHERE id=$1`,
              [anonymousPost],
            );
            const result = await view(developer.accessToken, [
              target,
              { kind: 'comment', id: comment },
            ]).expect(200);
            assert.ok(
              result.body.items.every(
                (item: { status: string }) => item.status === 'unavailable',
              ),
            );
            await pool.query(
              "UPDATE whaleu_community.posts SET visibility='approved',deleted_at=NULL WHERE id=$1",
              [anonymousPost],
            );
          }
          visibility.blocked.add(anonymousPost);
          assert.equal(
            (await view(developer.accessToken).expect(200)).body.items[0]
              .status,
            'unavailable',
          );
          visibility.blocked.clear();
          await pool.query(
            'UPDATE whaleu_campus.operating_regions SET is_active=false WHERE id=$1',
            [region],
          );
          assert.equal(
            (await view(developer.accessToken).expect(200)).body.items[0]
              .status,
            'unavailable',
          );
          await pool.query(
            'UPDATE whaleu_campus.operating_regions SET is_active=true WHERE id=$1',
            [region],
          );
          assert.equal(
            (
              await view(developer.accessToken, [
                { kind: 'post', id: randomUUID() },
              ]).expect(200)
            ).body.items[0].status,
            'unavailable',
          );
        },
      );

      await t.test(
        'unverified student fields and unavailable default adapter remain null, never fabricated from UID',
        async () => {
          await pool.query(
            'UPDATE whaleu_authorization_test.students SET verified=false WHERE account_id=$1',
            [author.accountId],
          );
          const unverified = await view(developer.accessToken).expect(200);
          assert.equal(unverified.body.items[0].identity.studentNumber, null);
          assert.equal(
            unverified.body.items[0].identity.studentNumberStatus,
            'unverified',
          );
          await pool.query(
            'UPDATE whaleu_authorization_test.students SET verified=true WHERE account_id=$1',
            [author.accountId],
          );
          const ordinaryModule = await Test.createTestingModule({
            imports: [AppModule.register(config)],
          })
            .overrideProvider(IDENTITY_PROVIDER)
            .useValue(provider)
            .overrideProvider(COMMUNITY_VISIBILITY)
            .useValue(visibility)
            .compile();
          ordinary = ordinaryModule.createNestApplication({ logger: false });
          configureHttp(ordinary);
          await ordinary.init();
          const missing = await request(ordinary.getHttpServer())
            .post('/v1/identity-privacy/content-identities')
            .set('Authorization', auth(developer.accessToken))
            .send({ targets: [target] })
            .expect(200);
          assert.equal(missing.body.items[0].identity.studentNumber, null);
          assert.equal(
            missing.body.items[0].identity.studentNumberStatus,
            'unavailable',
          );
        },
      );

      await t.test(
        'immutable grant constraints reject scope widening, unrevocation, duplicate active roles and audit mutation',
        async () => {
          const invalid = [
            [
              'UPDATE whaleu_authorization.role_grants SET operating_region_id=$2 WHERE id=$1',
              [schoolGrant, otherRegion],
            ],
            [
              "UPDATE whaleu_authorization.role_grants SET role='developer',operating_region_id=NULL WHERE id=$1",
              [schoolGrant],
            ],
            [
              'DELETE FROM whaleu_authorization.role_grants WHERE id=$1',
              [schoolGrant],
            ],
            [
              'UPDATE whaleu_authorization.identity_view_audit SET target_id=$1',
              [randomUUID()],
            ],
            ['DELETE FROM whaleu_authorization.identity_view_audit', []],
          ] as const;
          for (const [sql, values] of invalid)
            await assert.rejects(pool.query(sql, [...values]));
          await assert.rejects(
            grant(school.accountId, 'school_admin', otherRegion),
          );
          await assert.rejects(grant(member.accountId, 'developer', region));
          await assert.rejects(grant(member.accountId, 'school_admin'));
        },
      );

      await t.test(
        'revoked/future/expired grants and expiry during batch all deny fresh requests',
        async () => {
          await revoke(developerGrant);
          await assert.rejects(
            pool.query(
              'UPDATE whaleu_authorization.role_grants SET revoked_at=NULL,revoked_by_account_id=NULL WHERE id=$1',
              [developerGrant],
            ),
          );
          await view(developer.accessToken).expect(403);
          const future = await grant(
            developer.accountId,
            'developer',
            null,
            new Date(Date.now() + 60000),
          );
          await view(developer.accessToken).expect(403);
          await revoke(future);
          const expired = await grant(
            developer.accountId,
            'developer',
            null,
            new Date(Date.now() - 20000),
            new Date(Date.now() - 10000),
          );
          await view(developer.accessToken).expect(403);
          await revoke(expired);
          const expiring = await grant(
            developer.accountId,
            'developer',
            null,
            new Date(Date.now() - 1000),
            new Date(Date.now() + 250),
          );
          students.afterRead = async () => {
            await new Promise((resolve) => setTimeout(resolve, 350));
          };
          try {
            await view(developer.accessToken).expect(403);
          } finally {
            students.afterRead = null;
          }
          await revoke(expiring);
          developerGrant = await grant(developer.accountId, 'developer');
        },
      );

      await t.test(
        'grant expiring behind an unchanged FOR UPDATE lock cannot authorize capabilities or management',
        async () => {
          await revoke(developerGrant);
          const expiresAt = new Date(Date.now() + 1000);
          const expiring = await grant(
            developer.accountId,
            'developer',
            null,
            new Date(Date.now() - 1000),
            expiresAt,
          );
          const holder = await pool.connect();
          let capabilities:
            ReturnType<typeof authorization.capabilities> | undefined;
          try {
            await holder.query('BEGIN');
            await holder.query(
              'SELECT id FROM whaleu_authorization.role_grants WHERE id=$1 FOR UPDATE',
              [expiring],
            );
            capabilities = authorization.capabilities(developer.accessToken);
            const deadline = Date.now() + 3000;
            let waiting = false;
            while (Date.now() < deadline) {
              waiting = (
                await pool.query<{ waiting: boolean }>(
                  "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM whaleu_authorization.role_grants%') AS waiting",
                )
              ).rows[0]!.waiting;
              if (waiting) break;
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            assert.equal(
              waiting,
              true,
              'Capability check must actually wait on the unchanged grant row',
            );
            await holder.query(
              'SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM ($1::timestamptz-clock_timestamp())))+0.02)',
              [expiresAt],
            );
            await holder.query('COMMIT');
            assert.equal((await capabilities).role, 'member');
            await assert.rejects(
              database.transaction((tx) =>
                authorization.requireRegionManagement(
                  developer.accountId,
                  null,
                  tx,
                ),
              ),
              errorIs('AUTHORIZATION_REQUIRED'),
            );
          } finally {
            await holder.query('ROLLBACK');
            holder.release();
            await capabilities;
          }
          await revoke(expiring);
          developerGrant = await grant(developer.accountId, 'developer');
        },
      );

      await t.test(
        'permission/session/verification locks serialize revocation and conceal no data after revocation wins',
        async () => {
          const held = deferred(),
            resume = deferred();
          students.afterRead = async () => {
            students.afterRead = null;
            held.resolve();
            await resume.promise;
          };
          const pending = view(developer.accessToken)
            .expect(200)
            .then((result) => result);
          await held.promise;
          const contender = await pool.connect();
          try {
            for (const [sql, values] of [
              [
                'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$2 WHERE id=$1',
                [developerGrant, developer.accountId],
              ],
              [
                "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=$1",
                [developer.sessionId],
              ],
              [
                'UPDATE whaleu_authorization_test.students SET verified=false WHERE account_id=$1',
                [author.accountId],
              ],
              [
                "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
                [anonymousPost],
              ],
            ] as const) {
              await contender.query('BEGIN');
              await contender.query("SET LOCAL lock_timeout='60ms'");
              await assert.rejects(
                contender.query(sql, [...values]),
                (error: unknown) =>
                  !!error &&
                  typeof error === 'object' &&
                  'code' in error &&
                  error.code === '55P03',
              );
              await contender.query('ROLLBACK');
            }
          } finally {
            await contender.query('ROLLBACK');
            contender.release();
            resume.resolve();
          }
          await pending;
          await revoke(developerGrant);
          await view(developer.accessToken).expect(403);
          developerGrant = await grant(developer.accountId, 'developer');
        },
      );

      await t.test(
        'audit INSERT failure and deferred COMMIT failure return no identities',
        async () => {
          const count = (
            await pool.query(
              'SELECT * FROM whaleu_authorization.identity_view_audit',
            )
          ).rowCount;
          await pool.query(
            `CREATE FUNCTION whaleu_authorization_test.fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$; CREATE TRIGGER fail_audit BEFORE INSERT ON whaleu_authorization.identity_view_audit FOR EACH ROW EXECUTE FUNCTION whaleu_authorization_test.fail_audit()`,
          );
          try {
            const response = await view(developer.accessToken).expect(503);
            assert.equal(
              response.body.error.code,
              'IDENTITY_AUDIT_UNAVAILABLE',
            );
            assert.equal(
              JSON.stringify(response.body).includes('00004721'),
              false,
            );
          } finally {
            await pool.query(
              'DROP TRIGGER fail_audit ON whaleu_authorization.identity_view_audit',
            );
          }
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM whaleu_authorization.identity_view_audit',
              )
            ).rowCount,
            count,
          );
          await pool.query(
            'CREATE CONSTRAINT TRIGGER fail_commit AFTER INSERT ON whaleu_authorization.identity_view_audit DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_authorization_test.fail_audit()',
          );
          try {
            const response = await view(developer.accessToken).expect(500);
            assert.equal(
              JSON.stringify(response.body).includes('00004721'),
              false,
            );
          } finally {
            await pool.query(
              'DROP TRIGGER fail_commit ON whaleu_authorization.identity_view_audit',
            );
          }
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM whaleu_authorization.identity_view_audit',
              )
            ).rowCount,
            count,
          );
        },
      );

      await t.test(
        'unavailable visibility and revoked/blocked sessions fail closed',
        async () => {
          visibility.unavailable = true;
          await view(developer.accessToken).expect(503);
          visibility.unavailable = false;
          await identity.logout(developer.accessToken);
          await view(developer.accessToken).expect(401);
          await pool.query(
            "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
            [superAdmin.accountId],
          );
          await request(http)
            .get('/v1/me/authorization')
            .set('Authorization', auth(superAdmin.accessToken))
            .expect(403);
        },
      );
    } finally {
      students.afterRead = null;
      try {
        await ordinary?.close();
        await app?.close();
        if (owns)
          for (const schema of [
            'whaleu_authorization_test',
            'whaleu_verification',
            'whaleu_authorization',
            'whaleu_community',
            'whaleu_profile',
            'whaleu_campus',
            'whaleu_identity',
            'whaleu_meta',
          ])
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
