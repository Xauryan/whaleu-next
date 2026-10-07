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
import { COMMUNITY_VISIBILITY } from '../../src/community/community-policy.js';
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
import { IDENTITY_PROVIDER } from '../../src/identity/contracts.js';
import { IdentityService } from '../../src/identity/identity.service.js';
import { LocalStudentIdentitySource } from '../../src/verification/student-identity.source.js';
import {
  revokeAssertion,
  VerificationConflict,
} from '../../src/verification/revocation.js';
import type { AssertionRecord } from '../../src/verification/contracts.js';
import {
  setSyntheticSnapshot,
  syntheticAssertion,
} from '../support/verification-fixtures.js';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitForHeadLock(pool: Pool): Promise<void> {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const pending = (
      await pool.query<{ waiting: boolean }>(
        "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%FROM whaleu_verification.account_heads%') AS waiting",
      )
    ).rows[0]!.waiting;
    if (pending) return;
    await wait(10);
  }
  assert.fail('Expected real wait on verification account head');
}

test(
  'real canonical verification ledger to developer API and own-account summary',
  { timeout: 120000 },
  async (t) => {
    const connectionString = process.env['TEST_DATABASE_URL'];
    assert.ok(
      connectionString,
      'Set TEST_DATABASE_URL to disposable local whaleu_test; no silent skip',
    );
    const url = new URL(connectionString);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: connectionString,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '12',
      PG_STATEMENT_TIMEOUT_MS: '10000',
    });
    const pool = new Pool(poolOptions(config));
    let suite: PoolClient | undefined, app: INestApplication | undefined;
    let owns = false,
      locked = false;
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) AS locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert.equal(locked, true, 'Run disposable suites serially');
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
            "SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
          )
        ).rows[0]!.count,
        0,
        'Refusing existing WhaleU schemas',
      );
      owns = true;
      const migrations = await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      );
      await runMigrations(pool, migrations, { mode: 'up' });
      await runMigrations(pool, migrations, { mode: 'up' });
      const module = await Test.createTestingModule({
        imports: [AppModule.register(config)],
      })
        .overrideProvider(IDENTITY_PROVIDER)
        .useValue({
          exchange: async (code: string) => ({
            provider: 'wechat',
            appId: 'synthetic-verification',
            subject: code,
          }),
        })
        .overrideProvider(COMMUNITY_VISIBILITY)
        .useValue({ check: async () => ({ kind: 'allow', value: undefined }) })
        .compile();
      app = module.createNestApplication({ logger: false });
      configureHttp(app);
      await app.init();
      const identity = app.get(IdentityService),
        source = app.get(LocalStudentIdentitySource);
      const author = await identity.login('synthetic-verification-author'),
        developer = await identity.login('synthetic-verification-developer'),
        other = await identity.login('synthetic-verification-other');
      const http = app.getHttpServer(),
        institution = randomUUID(),
        otherInstitution = randomUUID(),
        region = randomUUID(),
        space = randomUUID(),
        post = randomUUID(),
        otherPost = randomUUID();
      const bearer = (token: string) => `Bearer ${token}`;
      const own = (token = author.accessToken, suffix = '') =>
        request(http)
          .get(`/v1/me/verification${suffix}`)
          .set('Authorization', bearer(token));
      const view = (
        targets: { kind: string; id: string }[] = [{ kind: 'post', id: post }],
      ) =>
        request(http)
          .post('/v1/identity-privacy/content-identities')
          .set('Authorization', bearer(developer.accessToken))
          .send({ targets });
      const facts = (override: Partial<AssertionRecord> = {}) => [
        syntheticAssertion(author.accountId, institution, 'affiliation'),
        syntheticAssertion(
          author.accountId,
          institution,
          'student_number',
          override,
        ),
        syntheticAssertion(author.accountId, institution, 'phone'),
      ];
      const set = (override: Partial<AssertionRecord> = {}) =>
        setSyntheticSnapshot(pool, author.accountId, facts(override));

      await t.test(
        'empty target and new login create no assertion/grant; own summary is minimized and scoped',
        async () => {
          assert.equal(
            (
              await pool.query(
                'SELECT id FROM whaleu_authorization.role_grants',
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (await pool.query('SELECT id FROM whaleu_verification.assertions'))
              .rowCount,
            0,
          );
          assert.equal(
            (await pool.query('SELECT id FROM whaleu_verification.raw_records'))
              .rowCount,
            0,
          );
          const response = await own().expect(200);
          assert.deepEqual(response.body, {
            affiliation: { status: 'unavailable' },
            studentNumber: { status: 'unavailable' },
            phone: { status: 'unavailable' },
            application: { status: 'unavailable' },
          });
          assert.equal(response.headers['cache-control'], 'no-store');
          assert.equal(response.headers['vary'], 'Authorization');
          await request(http).get('/v1/me/verification').expect(401);
          for (const path of [
            '/v1/verification/attest',
            '/v1/verification/revoke',
            '/v1/me/verification',
            '/v1/verification/applications',
          ])
            await request(http)
              .post(path)
              .set('Authorization', bearer(developer.accessToken))
              .send({ accountId: author.accountId, studentNumber: '00004721' })
              .expect(404);
        },
      );
      await pool.query(
        "INSERT INTO whaleu_campus.institutions(id,name) VALUES($1,'Synthetic Issuer'),($2,'Synthetic Other Issuer')",
        [institution, otherInstitution],
      );
      await pool.query(
        "INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES($1,'Synthetic Region',true)",
        [region],
      );
      await pool.query(
        "INSERT INTO whaleu_community.spaces(id,kind,operating_region_id,name,is_active) VALUES($1,'regional',$2,'Synthetic Space',true)",
        [space, region],
      );
      await pool.query(
        "INSERT INTO whaleu_profile.profiles(account_id,nickname) VALUES($1,'PrivateWhale')",
        [author.accountId],
      );
      await pool.query(
        "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'discussion','synthetic post','anonymous','open'),($4,$2,$5,'discussion','synthetic other','named','open')",
        [post, space, author.accountId, otherPost, other.accountId],
      );
      await pool.query(
        "INSERT INTO whaleu_community.thread_personas(id,post_id,account_id,display_name) VALUES($1,$2,$3,'匿名鲸鱼')",
        [randomUUID(), post, author.accountId],
      );
      await pool.query(
        "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,approved_by_account_id,approval_reference) VALUES($1,$2,'developer',$2,'synthetic-fixture-only')",
        [randomUUID(), developer.accountId],
      );

      await t.test(
        'real default adapter exposes exact verified number only in audited developer response',
        async () => {
          await set();
          const response = await view().expect(200);
          assert.deepEqual(response.body.items[0].identity, {
            accountId: author.accountId,
            nickname: 'PrivateWhale',
            avatar: null,
            studentNumber: '00004721',
            studentNumberStatus: 'verified',
          });
          const summary = await own().expect(200);
          assert.deepEqual(summary.body, {
            affiliation: { status: 'verified' },
            studentNumber: { status: 'verified' },
            phone: { status: 'verified' },
            application: { status: 'none' },
          });
          const wrongAccount = await own(
            other.accessToken,
            `?accountId=${author.accountId}`,
          ).expect(200);
          assert.equal(wrongAccount.body.studentNumber.status, 'unavailable');
          const audit = await pool.query(
            'SELECT * FROM whaleu_authorization.identity_view_audit WHERE request_id=$1',
            [response.headers['x-request-id']],
          );
          assert.deepEqual(audit.rows[0].disclosed_fields, [
            'accountId',
            'nickname',
            'studentNumber',
          ]);
          const publicResponse = await request(http)
            .get(`/v1/community/posts/${post}`)
            .set('Authorization', bearer(developer.accessToken))
            .expect(200);
          for (const serialized of [
            JSON.stringify(summary.body),
            JSON.stringify(audit.rows),
            JSON.stringify(publicResponse.body),
          ]) {
            for (const secret of [
              '00004721',
              'synthetic-record-only',
              'phone_binding_reference',
              'source_reference',
              'source_account_id',
              'student_number',
            ])
              assert.equal(serialized.includes(secret), false);
          }
          for (const field of [
            'phone',
            'email',
            'realName',
            'issuer',
            'evidence',
          ])
            assert.equal(
              JSON.stringify(response.body).includes(`"${field}"`),
              false,
            );
          await request(http)
            .post('/v1/identity-privacy/content-identities')
            .set('Authorization', bearer(other.accessToken))
            .send({ targets: [{ kind: 'post', id: post }] })
            .expect(403);
        },
      );
      await t.test(
        'affiliation-only and absent coverage differ, with explicit pending/rejected summaries',
        async () => {
          await set({
            assertion_state: 'unverified',
            student_number: null,
            verified_at: null,
            expiry_kind: 'unknown',
            expires_at: null,
          });
          let response = await view().expect(200);
          assert.equal(
            response.body.items[0].identity.studentNumberStatus,
            'unverified',
          );
          assert.equal(response.body.items[0].identity.studentNumber, null);
          assert.equal(
            (await own().expect(200)).body.affiliation.status,
            'verified',
          );
          for (const application of ['pending', 'rejected'] as const) {
            await setSyntheticSnapshot(
              pool,
              author.accountId,
              [
                syntheticAssertion(
                  author.accountId,
                  institution,
                  'affiliation',
                ),
              ],
              application,
            );
            const summary = await own().expect(200);
            assert.equal(summary.body.studentNumber.status, 'unavailable');
            assert.equal(summary.body.application.status, application);
          }
          response = await view().expect(200);
          assert.equal(
            response.body.items[0].identity.studentNumberStatus,
            'unavailable',
          );
          await setSyntheticSnapshot(
            pool,
            author.accountId,
            [],
            'pending',
            'missing',
          );
          assert.equal(
            (await own().expect(200)).body.application.status,
            'unavailable',
          );
        },
      );
      await t.test(
        'coverage/provenance/account/issuer conflicts and email candidates stay unavailable',
        async () => {
          for (const patch of [
            { coverage_state: 'missing' as const },
            { coverage_state: 'conflict' as const },
            { provenance_state: 'unknown' as const },
            { provenance_state: 'conflict' as const },
            { source_account_id: other.accountId },
            { source_issuer_institution_id: otherInstitution },
            {
              issuer_institution_id: otherInstitution,
              source_issuer_institution_id: otherInstitution,
            },
            { expiry_kind: 'unknown' as const, expires_at: null },
            { method: 'institutional_email' as const },
            { student_number: 'someone@school.invalid' },
            { student_number: 'unsafe\nnumber' },
            { policy_reference: null },
          ]) {
            await set(patch);
            const response = await view().expect(200);
            assert.equal(
              response.body.items[0].identity.studentNumberStatus,
              'unavailable',
            );
            assert.equal(response.body.items[0].identity.studentNumber, null);
          }
        },
      );
      await t.test(
        'snapshot cannot select another account and history/head rules reject mutation or silent rewinds',
        async () => {
          await set();
          const foreign = syntheticAssertion(
            other.accountId,
            institution,
            'student_number',
          );
          await setSyntheticSnapshot(pool, other.accountId, [foreign]);
          await assert.rejects(
            pool.query(
              "INSERT INTO whaleu_verification.snapshots(id,account_id,revision,student_number_assertion_id,application_state,application_coverage) VALUES($1,$2,999,$3,'none','complete')",
              [randomUUID(), author.accountId, foreign.id],
            ),
          );
          for (const sql of [
            'UPDATE whaleu_verification.assertions SET student_number=student_number',
            'DELETE FROM whaleu_verification.assertions',
            'UPDATE whaleu_verification.snapshots SET revision=revision',
            'DELETE FROM whaleu_verification.snapshots',
            'UPDATE whaleu_verification.events SET reason_code=reason_code',
            'DELETE FROM whaleu_verification.events',
            'UPDATE whaleu_verification.account_heads SET revision=revision',
            'DELETE FROM whaleu_verification.account_heads',
          ])
            await assert.rejects(pool.query(sql));
        },
      );
      await t.test(
        'expiry behind unchanged UPDATE lock is evaluated after wait in real API',
        async () => {
          const expires = new Date(Date.now() + 450);
          await set({ expires_at: expires });
          const holder = await pool.connect();
          let pending: Promise<request.Response> | undefined;
          try {
            await holder.query('BEGIN');
            await holder.query(
              'SELECT account_id FROM whaleu_verification.account_heads WHERE account_id=$1 FOR UPDATE',
              [author.accountId],
            );
            pending = view()
              .expect(200)
              .then((response) => response);
            await waitForHeadLock(pool);
            await holder.query(
              'SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM ($1::timestamptz-clock_timestamp())))+0.02)',
              [expires],
            );
            await holder.query('COMMIT');
            const response = await pending;
            assert.equal(response.body.items[0].identity.studentNumber, null);
            assert.equal(
              response.body.items[0].identity.studentNumberStatus,
              'unverified',
            );
            assert.equal(
              (await own().expect(200)).body.studentNumber.status,
              'expired',
            );
          } finally {
            await holder.query('ROLLBACK');
            holder.release();
            await pending;
          }
        },
      );
      await t.test(
        'earlier number is rechecked after later account wait in a batch',
        async () => {
          const expires = new Date(Date.now() + 450);
          await set({ expires_at: expires });
          const holder = await pool.connect();
          let pending: Promise<request.Response> | undefined;
          try {
            await holder.query('BEGIN');
            await holder.query(
              'SELECT account_id FROM whaleu_verification.account_heads WHERE account_id=$1 FOR UPDATE',
              [other.accountId],
            );
            pending = view([
              { kind: 'post', id: post },
              { kind: 'post', id: otherPost },
            ])
              .expect(200)
              .then((response) => response);
            await waitForHeadLock(pool);
            await holder.query(
              'SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM ($1::timestamptz-clock_timestamp())))+0.02)',
              [expires],
            );
            await holder.query('COMMIT');
            const response = await pending;
            assert.equal(response.body.items[0].identity.studentNumber, null);
            assert.equal(
              response.body.items[0].identity.studentNumberStatus,
              'unverified',
            );
          } finally {
            await holder.query('ROLLBACK');
            holder.release();
            await pending;
          }
        },
      );
      await t.test(
        'number, role and session expiry while audit INSERT waits abort disclosure and rollback audit',
        async () => {
          for (const expiring of ['number', 'role', 'session'] as const) {
            const expires = new Date(Date.now() + 650);
            await set(expiring === 'number' ? { expires_at: expires } : {});
            let expiringGrant: string | undefined;
            let tokenExpiry: Date | undefined;
            if (expiring === 'role') {
              await pool.query(
                'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$1 WHERE account_id=$1 AND revoked_at IS NULL',
                [developer.accountId],
              );
              expiringGrant = randomUUID();
              await pool.query(
                "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,approved_by_account_id,approval_reference,expires_at) VALUES($1,$2,'developer',$2,'synthetic-audit-expiry',$3)",
                [expiringGrant, developer.accountId, expires],
              );
            }
            if (expiring === 'session') {
              tokenExpiry = (
                await pool.query<{ expires_at: Date }>(
                  'SELECT expires_at FROM whaleu_identity.access_tokens WHERE session_id=$1',
                  [developer.sessionId],
                )
              ).rows[0]!.expires_at;
              await pool.query(
                'UPDATE whaleu_identity.access_tokens SET expires_at=$2 WHERE session_id=$1',
                [developer.sessionId, expires],
              );
            }
            const holder = await pool.connect();
            let pending: Promise<request.Response> | undefined;
            const before = (
              await pool.query(
                'SELECT count(*)::integer AS count FROM whaleu_authorization.identity_view_audit',
              )
            ).rows[0].count;
            try {
              await holder.query('BEGIN');
              await holder.query(
                'LOCK TABLE whaleu_authorization.identity_view_audit IN SHARE MODE',
              );
              pending = view()
                .expect(
                  expiring === 'number' ? 503 : expiring === 'role' ? 403 : 401,
                )
                .then((response) => response);
              const deadline = Date.now() + 4000;
              let waiting = false;
              while (Date.now() < deadline) {
                waiting = (
                  await pool.query<{ waiting: boolean }>(
                    "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%INSERT INTO whaleu_authorization.identity_view_audit%') AS waiting",
                  )
                ).rows[0]!.waiting;
                if (waiting) break;
                await wait(10);
              }
              assert.equal(
                waiting,
                true,
                'Request must actually reach blocked audit INSERT before expiry',
              );
              await holder.query(
                'SELECT pg_sleep(GREATEST(0,EXTRACT(epoch FROM ($1::timestamptz-clock_timestamp())))+0.02)',
                [expires],
              );
              await holder.query('COMMIT');
              const response = await pending;
              assert.equal(
                response.body.error.code,
                expiring === 'number'
                  ? 'IDENTITY_VIEW_UNAVAILABLE'
                  : expiring === 'role'
                    ? 'AUTHORIZATION_REQUIRED'
                    : 'ACCESS_TOKEN_EXPIRED',
              );
              assert.equal(
                JSON.stringify(response.body).includes('00004721'),
                false,
              );
              assert.equal(
                (
                  await pool.query(
                    'SELECT count(*)::integer AS count FROM whaleu_authorization.identity_view_audit',
                  )
                ).rows[0].count,
                before,
              );
            } finally {
              await holder.query('ROLLBACK');
              holder.release();
              await pending;
              if (expiringGrant) {
                await pool.query(
                  'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$2 WHERE id=$1',
                  [expiringGrant, developer.accountId],
                );
                await pool.query(
                  "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,approved_by_account_id,approval_reference) VALUES($1,$2,'developer',$2,'synthetic-restored-grant')",
                  [randomUUID(), developer.accountId],
                );
              }
              if (tokenExpiry)
                await pool.query(
                  'UPDATE whaleu_identity.access_tokens SET expires_at=$2 WHERE session_id=$1',
                  [developer.sessionId, tokenExpiry],
                );
            }
          }
        },
      );

      await t.test(
        'post-audit decision never reopens initially absent profiles or verification heads',
        async () => {
          const unmapped = await identity.login('synthetic-late-head');
          const unmappedPost = randomUUID();
          await pool.query(
            "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'discussion','synthetic absent head','named','open')",
            [unmappedPost, space, unmapped.accountId],
          );
          for (const kind of ['profile', 'head'] as const) {
            const accountId =
              kind === 'profile' ? other.accountId : unmapped.accountId;
            const contentId = kind === 'profile' ? otherPost : unmappedPost;
            const blocker = await pool.connect(),
              lateRow = await pool.connect();
            let pending: Promise<request.Response> | undefined;
            try {
              await blocker.query('BEGIN');
              await blocker.query(
                'LOCK TABLE whaleu_authorization.identity_view_audit IN SHARE MODE',
              );
              pending = view([{ kind: 'post', id: contentId }])
                .expect(200)
                .then((response) => response);
              const deadline = Date.now() + 4000;
              let waiting = false;
              while (Date.now() < deadline) {
                waiting = (
                  await pool.query<{ waiting: boolean }>(
                    "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%INSERT INTO whaleu_authorization.identity_view_audit%') AS waiting",
                  )
                ).rows[0]!.waiting;
                if (waiting) break;
                await wait(10);
              }
              assert.equal(
                waiting,
                true,
                'Initial profile/head snapshot must finish before introducing the new row',
              );
              // Commit a new row, THEN lock its visible tuple. Uncommitted INSERTs
              // alone are invisible to READ COMMITTED SELECT and do not reproduce this race.
              if (kind === 'profile')
                await pool.query(
                  "INSERT INTO whaleu_profile.profiles(account_id,nickname) VALUES($1,'LatePrivateName')",
                  [accountId],
                );
              else
                await pool.query(
                  'INSERT INTO whaleu_verification.account_heads(account_id) VALUES($1)',
                  [accountId],
                );
              await lateRow.query('BEGIN');
              await lateRow.query(
                kind === 'profile'
                  ? 'SELECT account_id FROM whaleu_profile.profiles WHERE account_id=$1 FOR UPDATE'
                  : 'SELECT account_id FROM whaleu_verification.account_heads WHERE account_id=$1 FOR UPDATE',
                [accountId],
              );
              await blocker.query('COMMIT');
              // The old repeated-read guard blocks here and can cross any deadline.
              // The final-clock snapshot guard must finish while this lock stays held.
              const result = await Promise.race([
                pending,
                wait(700).then(() => null),
              ]);
              assert.ok(
                result,
                'Disclosure must not re-open a new profile/head after audit',
              );
              assert.equal(result.body.items[0].identity.nickname, null);
              assert.equal(
                result.body.items[0].identity.studentNumberStatus,
                kind === 'profile' ? 'verified' : 'unavailable',
              );
              assert.equal(
                JSON.stringify(result.body).includes('LatePrivateName'),
                false,
              );
            } finally {
              await blocker.query('ROLLBACK');
              await lateRow.query('ROLLBACK');
              blocker.release();
              lateRow.release();
              await pending;
            }
          }
        },
      );

      await t.test(
        'revocation is exact-once, preserves history and separate facts, rejects changed intent',
        async () => {
          const { revision } = await set();
          const command = {
            accountId: author.accountId,
            actorAccountId: developer.accountId,
            operationId: randomUUID(),
            fact: 'student_number' as const,
            expectedRevision: revision,
            reasonCode: 'synthetic_revocation',
          };
          const [one, two] = await Promise.all([
            inTransaction(pool, (tx) => revokeAssertion(tx, command)),
            inTransaction(pool, (tx) => revokeAssertion(tx, command)),
          ]);
          assert.deepEqual(one, two);
          await assert.rejects(
            inTransaction(pool, (tx) =>
              revokeAssertion(tx, { ...command, reasonCode: 'changed_intent' }),
            ),
            VerificationConflict,
          );
          await assert.rejects(
            inTransaction(pool, (tx) =>
              revokeAssertion(tx, { ...command, operationId: randomUUID() }),
            ),
            VerificationConflict,
          );
          const summary = await own().expect(200);
          assert.equal(summary.body.studentNumber.status, 'revoked');
          assert.equal(summary.body.affiliation.status, 'verified');
          assert.equal(summary.body.phone.status, 'verified');
          const response = await view().expect(200);
          assert.equal(response.body.items[0].identity.studentNumber, null);
          assert.equal(
            response.body.items[0].identity.studentNumberStatus,
            'unverified',
          );
          assert.equal(
            (
              await pool.query(
                "SELECT id FROM whaleu_verification.assertions WHERE account_id=$1 AND assertion_state='verified' AND student_number='00004721'",
                [author.accountId],
              )
            ).rowCount! > 0,
            true,
          );
        },
      );
      await t.test(
        'a read that locks first completes before revoke; next read sees revoke immediately',
        async () => {
          const { revision } = await set();
          const holder = await pool.connect();
          let revoking: ReturnType<typeof revokeAssertion> | undefined;
          try {
            await holder.query('BEGIN');
            const result = await source.resolve(author.accountId, holder);
            assert.equal(result.status, 'verified');
            if (result.status === 'verified') {
              assert.equal(result.studentNumber, '00004721');
              assert.equal(typeof result.validUntil, 'number');
            }
            revoking = inTransaction(pool, (tx) =>
              revokeAssertion(tx, {
                accountId: author.accountId,
                actorAccountId: developer.accountId,
                operationId: randomUUID(),
                fact: 'student_number',
                expectedRevision: revision,
                reasonCode: 'synthetic_race',
              }),
            );
            await waitForHeadLock(pool);
            await holder.query('COMMIT');
            await revoking;
            assert.deepEqual(
              await inTransaction(pool, (tx) =>
                source.resolve(author.accountId, tx),
              ),
              { status: 'unverified' },
            );
          } finally {
            await holder.query('ROLLBACK');
            holder.release();
            await revoking;
          }
        },
      );
      await t.test(
        'revocation winning the lock precedes blocked read; competing changed operations cannot both commit',
        async () => {
          let { revision } = await set();
          const holder = await pool.connect();
          let pending: Promise<request.Response> | undefined;
          try {
            await holder.query('BEGIN');
            await revokeAssertion(holder, {
              accountId: author.accountId,
              actorAccountId: developer.accountId,
              operationId: randomUUID(),
              fact: 'student_number',
              expectedRevision: revision,
              reasonCode: 'synthetic_revoke_first',
            });
            pending = view()
              .expect(200)
              .then((response) => response);
            await waitForHeadLock(pool);
            await holder.query('COMMIT');
            assert.equal(
              (await pending).body.items[0].identity.studentNumber,
              null,
            );
          } finally {
            await holder.query('ROLLBACK');
            holder.release();
            await pending;
          }
          ({ revision } = await set());
          const command = {
            accountId: author.accountId,
            actorAccountId: developer.accountId,
            fact: 'student_number' as const,
            expectedRevision: revision,
            reasonCode: 'synthetic_conflict',
          };
          const results = await Promise.allSettled(
            [0, 1].map(() =>
              inTransaction(pool, (tx) =>
                revokeAssertion(tx, { ...command, operationId: randomUUID() }),
              ),
            ),
          );
          assert.equal(
            results.filter((result) => result.status === 'fulfilled').length,
            1,
          );
          const rejected = results.find(
            (result) => result.status === 'rejected',
          );
          assert.ok(
            rejected?.status === 'rejected' &&
              rejected.reason instanceof VerificationConflict,
          );
          // A deliberate replacement also wins over a stale earlier revocation.
          ({ revision } = await set());
          await set({ student_number: '00009999' });
          await assert.rejects(
            inTransaction(pool, (tx) =>
              revokeAssertion(tx, {
                ...command,
                expectedRevision: revision,
                operationId: randomUUID(),
              }),
            ),
            VerificationConflict,
          );
          assert.equal(
            (await view().expect(200)).body.items[0].identity.studentNumber,
            '00009999',
          );
        },
      );

      await t.test(
        'event insertion failure rolls back revocation and original head remains authoritative',
        async () => {
          const { revision } = await set();
          const before = (
            await pool.query(
              'SELECT count(*)::integer AS count FROM whaleu_verification.assertions',
            )
          ).rows[0].count;
          await pool.query(
            "CREATE FUNCTION whaleu_verification.synthetic_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$; CREATE TRIGGER synthetic_event_failure BEFORE INSERT ON whaleu_verification.events FOR EACH ROW EXECUTE FUNCTION whaleu_verification.synthetic_failure()",
          );
          try {
            await assert.rejects(
              inTransaction(pool, (tx) =>
                revokeAssertion(tx, {
                  accountId: author.accountId,
                  actorAccountId: developer.accountId,
                  operationId: randomUUID(),
                  fact: 'student_number',
                  expectedRevision: revision,
                  reasonCode: 'synthetic_failure',
                }),
              ),
            );
          } finally {
            await pool.query(
              'DROP TRIGGER synthetic_event_failure ON whaleu_verification.events',
            );
          }
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer AS count FROM whaleu_verification.assertions',
              )
            ).rows[0].count,
            before,
          );
          assert.equal(
            (await view().expect(200)).body.items[0].identity.studentNumber,
            '00004721',
          );
        },
      );
      await t.test(
        'real-adapter identity audit failure leaks no identity and commits no disclosure',
        async () => {
          const before = (
            await pool.query(
              'SELECT count(*)::integer AS count FROM whaleu_authorization.identity_view_audit',
            )
          ).rows[0].count;
          await pool.query(
            'CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON whaleu_authorization.identity_view_audit FOR EACH ROW EXECUTE FUNCTION whaleu_verification.synthetic_failure()',
          );
          try {
            const response = await view().expect(503);
            assert.equal(
              response.body.error.code,
              'IDENTITY_AUDIT_UNAVAILABLE',
            );
            for (const secret of ['00004721', 'PrivateWhale', author.accountId])
              assert.equal(
                JSON.stringify(response.body).includes(secret),
                false,
              );
          } finally {
            await pool.query(
              'DROP TRIGGER synthetic_audit_failure ON whaleu_authorization.identity_view_audit',
            );
          }
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer AS count FROM whaleu_authorization.identity_view_audit',
              )
            ).rows[0].count,
            before,
          );
        },
      );
      await t.test(
        'own summary requires a current session, including account blocking and logout',
        async () => {
          await identity.logout(author.accessToken);
          await own().expect(401);
          await pool.query(
            "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
            [other.accountId],
          );
          await own(other.accessToken).expect(403);
        },
      );
    } finally {
      try {
        await app?.close();
        if (owns)
          for (const schema of [
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
