import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as nodeRequest } from 'node:http';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { AppModule } from '../../src/app.module.js';
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
import { configureHttp } from '../../src/http/http.js';
import { IDENTITY_PROVIDER } from '../../src/identity/contracts.js';
import type {
  SessionCredentials,
  SessionView,
} from '../../src/identity/contracts.js';
import { preferenceDefaults } from '../../src/profile/contracts.js';
import type { OwnProfile } from '../../src/profile/contracts.js';
import {
  setSyntheticSnapshot,
  syntheticAssertion,
} from '../support/verification-fixtures.js';

// Load the actual native sources through tsx, not built artifacts or fake gateways.
// Native is a CommonJS package; static TS imports would incorrectly compile all of
// its source under the API's incompatible verbatimModuleSyntax configuration.
const require = createRequire(import.meta.url);
const { ApiClient } = require('../../../wechat/src/api/client.ts');
const { ClientError } = require('../../../wechat/src/api/errors.ts');
const { responseError } = require('../../../wechat/src/api/envelopes.ts');
const { currentSession } = require('../../../wechat/src/api/identity.ts');
const { AuthService } = require('../../../wechat/src/auth/auth-service.ts');
const {
  HttpAuthGateway,
} = require('../../../wechat/src/auth/http-auth-gateway.ts');
const { SessionStore } = require('../../../wechat/src/auth/session.ts');
const { systemClock } = require('../../../wechat/src/platform/clock.ts');
const { Cancellation } = require('../../../wechat/src/platform/contracts.ts');
const {
  HttpProfileGateway,
} = require('../../../wechat/src/profile/gateway.ts');

const {
  HttpVerificationGateway,
} = require('../../../wechat/src/verification/gateway.ts');

const nativeOrigin = 'https://native-contract.invalid';

// Structural implementation of the native platform Transport contract. Only the
// platform I/O changes: native HTTPS URLs route to this suite's real loopback Nest
// listener. Paths, encoded queries, verbs, headers, JSON, statuses and responses
// cross the HTTP socket unchanged. Never send fixture credentials off loopback.
interface NativeRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly timeoutMs: number;
  readonly cancellation?: {
    readonly isCancelled: boolean;
    subscribe(listener: () => void): () => void;
  };
}
interface NativeResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}
interface Exchange {
  readonly path: string;
  readonly method: string;
  readonly authorized: boolean;
  readonly status: number;
}
class NodeHttpTransport {
  readonly exchanges: Exchange[] = [];

  constructor(private readonly port: number) {}

  send(input: NativeRequest): Promise<NativeResponse> {
    const url = new URL(input.url);
    assert.equal(url.origin, nativeOrigin, 'Refuse a non-fixture API origin');
    assert.equal(url.username, '');
    assert.equal(url.password, '');
    assert.equal(url.hash, '');
    if (input.cancellation?.isCancelled)
      return Promise.reject(new ClientError('cancelled', 'Request cancelled'));
    return new Promise((resolve, reject) => {
      const request = nodeRequest(
        {
          hostname: '127.0.0.1',
          port: this.port,
          path: `${url.pathname}${url.search}`,
          method: input.method,
          headers: input.headers,
          agent: false,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.once('error', () =>
            reject(new Error('Local HTTP read failed')),
          );
          response.once('end', () => {
            unsubscribe?.();
            try {
              const raw = Buffer.concat(chunks).toString('utf8');
              const headers: Record<string, string> = {};
              for (const [name, value] of Object.entries(response.headers)) {
                if (value !== undefined)
                  headers[name] = Array.isArray(value)
                    ? value.join(', ')
                    : value;
              }
              const status = response.statusCode ?? 0;
              // Deliberately record no request/response bodies or credential values.
              this.exchanges.push({
                path: `${url.pathname}${url.search}`,
                method: input.method,
                authorized: input.headers['Authorization'] !== undefined,
                status,
              });
              resolve({
                status,
                headers,
                body: raw === '' ? '' : JSON.parse(raw),
              });
            } catch {
              reject(new Error('Local HTTP response was not JSON'));
            }
          });
        },
      );
      request.once('error', () => {
        unsubscribe?.();
        reject(new Error('Local HTTP request failed'));
      });
      request.setTimeout(input.timeoutMs, () => request.destroy());
      const unsubscribe = input.cancellation?.subscribe(() =>
        request.destroy(),
      );
      if (input.body !== undefined) request.write(JSON.stringify(input.body));
      request.end();
    });
  }
}

function clientFailure(kind: string, status: number, code: string) {
  return (error: unknown): boolean => {
    assert.ok(
      error instanceof ClientError,
      'Use the native typed error boundary',
    );
    const failure = error as Error & {
      kind: string;
      details: { httpStatus?: number; serverCode?: string; requestId?: string };
    };
    assert.equal(failure.kind, kind);
    assert.equal(failure.details.httpStatus, status);
    assert.equal(failure.details.serverCode, code);
    assert.match(failure.details.requestId ?? '', /^[a-f0-9-]{36}$/i);
    return true;
  };
}

test(
  'real native gateways, Nest HTTP and PostgreSQL campus/profile contract',
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
      PG_POOL_MAX: '4',
      PG_CONNECTION_TIMEOUT_MS: '2000',
      PG_STATEMENT_TIMEOUT_MS: '10000',
      // Explicit, unusable local fixtures enable the real auth HTTP/rate-limit
      // path. The provider override below makes no production provider calls.
      WECHAT_APP_ID: 'wx0000000000000000',
      WECHAT_APP_SECRET: 'synthetic-local-contract-secret-only',
      AUTH_RATE_LIMIT_KEY: 'ab'.repeat(32),
    });
    const pool = new Pool(poolOptions(config));
    let suiteClient: PoolClient | undefined;
    let suiteLocked = false;
    let ownsSchemas = false;
    let app: INestApplication | undefined;
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
      ).rows[0]?.version;
      assert.ok(
        supportedPostgresVersion(version ?? 0),
        'PostgreSQL 18.6+ required',
      );
      const existing = await pool.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname IN ('whaleu_meta','whaleu_identity','whaleu_campus','whaleu_profile','whaleu_community','whaleu_authorization','whaleu_verification')",
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
      const module = await Test.createTestingModule({
        imports: [AppModule.register(config)],
      })
        .overrideProvider(IDENTITY_PROVIDER)
        .useValue({
          // Only the external provider is mocked; accounts, sessions and business
          // operations all use the application's real PostgreSQL repositories.
          exchange: async (code: string) => ({
            provider: 'wechat',
            appId: 'synthetic-local-native-contract',
            subject: code,
          }),
        })
        .compile();
      app = module.createNestApplication({ logger: false });
      configureHttp(app);
      await app.listen(0, '127.0.0.1');
      const port = Number(new URL(await app.getUrl()).port);
      assert.ok(Number.isInteger(port) && port > 0);
      const transport = new NodeHttpTransport(port);
      const sessions = new SessionStore();
      const auth = new AuthService(
        sessions,
        new HttpAuthGateway(nativeOrigin, transport, systemClock),
        { login: async () => 'synthetic-native-contract-login' },
        systemClock,
      );
      const api = new ApiClient(nativeOrigin, transport, sessions, auth);
      const gateway = new HttpProfileGateway(api);
      const verification = new HttpVerificationGateway(api);
      const cancellation = new Cancellation();
      let credentials: SessionCredentials;
      let profile: OwnProfile;
      const campusId = randomUUID();
      const literalId = randomUUID();
      const unicodeId = randomUUID();
      const inactiveId = randomUUID();
      const institutionId = randomUUID();
      const unicodeQuery = '𠀀'.repeat(100);
      const literalQuery = "%_\\'&/?#";

      await t.test(
        'login and session decode actual HTTP credentials and timestamps',
        async () => {
          const ticket = await auth.login();
          assert.ok(
            ticket.credentials,
            'Login must commit native session state',
          );
          credentials = ticket.credentials;
          const session: SessionView = await api.request(currentSession);
          assert.equal(session.accountId, credentials.accountId);
          assert.equal(session.sessionId, credentials.sessionId);
          assert.ok(session.expiresAt > Date.now());
          assert.ok(session.refreshExpiresAt > session.expiresAt);
          profile = await gateway.profile(cancellation);
          assert.deepEqual(profile, {
            accountId: credentials.accountId,
            nickname: null,
            bio: '',
            selectedCampus: null,
            revision: 0,
            preferences: preferenceDefaults,
          });
          assert.equal(
            (await pool.query('SELECT account_id FROM whaleu_profile.profiles'))
              .rowCount,
            0,
            'Reading the default profile must not create a row',
          );
        },
      );

      await t.test(
        'default blank filters reach the public directory with no auth or empty district',
        async () => {
          const page: CampusPage = await gateway.campuses(
            { q: '', district: '', page: 1, pageSize: 20 },
            cancellation,
          );
          assert.deepEqual(page, {
            items: [],
            page: 1,
            pageSize: 20,
            total: 0,
          });
          assert.deepEqual(transport.exchanges.at(-1), {
            path: '/v1/campuses?page=1&pageSize=20',
            method: 'GET',
            authorized: false,
            status: 200,
          });
        },
      );

      // Synthetic fixture data only; no real campus, account or provider records.
      await pool.query(
        'INSERT INTO whaleu_campus.institutions(id,name) VALUES ($1,$2)',
        [institutionId, 'Synthetic 测试 University'],
      );
      await pool.query(
        `INSERT INTO whaleu_campus.campuses(id,institution_id,full_name,short_name,district,is_active,sort_order)
        VALUES ($1,$5,'Synthetic North','N','Test District',true,40),
          ($2,$5,$6,NULL,'Literal District',true,30),
          ($3,$5,$7,NULL,$7,true,20),
          ($4,$5,'Synthetic Inactive',NULL,'Test District',false,10)`,
        [
          campusId,
          literalId,
          unicodeId,
          inactiveId,
          institutionId,
          `Literal ${literalQuery} Campus`,
          unicodeQuery,
        ],
      );

      await t.test(
        'real native verification gateway and strict decoder read unavailable, affiliation-only and revoked states over HTTP',
        async () => {
          assert.deepEqual(await verification.summary(cancellation), {
            affiliation: { status: 'unavailable' },
            studentNumber: { status: 'unavailable' },
            phone: { status: 'unavailable' },
            application: { status: 'unavailable' },
          });
          for (const status of [
            'unavailable',
            'unverified',
            'revoked',
            'expired',
            'verified',
          ] as const) {
            await setSyntheticSnapshot(
              pool,
              credentials.accountId,
              [
                syntheticAssertion(
                  credentials.accountId,
                  institutionId,
                  'affiliation',
                ),
                ...(status === 'unavailable'
                  ? []
                  : [
                      syntheticAssertion(
                        credentials.accountId,
                        institutionId,
                        'student_number',
                        {
                          assertion_state: status,
                          student_number:
                            status === 'unverified' ? null : '00004721',
                        },
                      ),
                    ]),
              ],
              'pending',
            );
            const summary = await verification.summary(cancellation);
            assert.deepEqual(summary, {
              affiliation: { status: 'verified' },
              studentNumber: { status },
              phone: { status: 'unavailable' },
              application: { status: 'pending' },
            });
            assert.equal(JSON.stringify(summary).includes('00004721'), false);
            assert.deepEqual(transport.exchanges.at(-1), {
              path: '/v1/me/verification',
              method: 'GET',
              authorized: true,
              status: 200,
            });
          }
        },
      );

      await t.test(
        'encoded literal, district and 100-codepoint queries preserve pagination and strict campus DTOs',
        async () => {
          for (const [q, district, expectedId] of [
            ['north', 'Test District', campusId],
            [literalQuery, '', literalId],
            [unicodeQuery, unicodeQuery, unicodeId],
          ] as const) {
            const page: CampusPage = await gateway.campuses(
              { q, district, page: 1, pageSize: 20 },
              cancellation,
            );
            assert.equal(page.total, 1);
            assert.equal(page.items[0]?.id, expectedId);
            assert.equal(
              page.items[0]?.institutionName,
              'Synthetic 测试 University',
            );
          }
          const sql: CampusPage = await gateway.campuses(
            { q: "' OR 1=1 --", district: '', page: 1, pageSize: 20 },
            cancellation,
          );
          assert.equal(sql.total, 0);
          const second: CampusPage = await gateway.campuses(
            { q: '', district: '', page: 2, pageSize: 2 },
            cancellation,
          );
          assert.equal(second.total, 4);
          assert.deepEqual(
            second.items.map(({ id }) => id),
            [unicodeId, inactiveId],
          );
          const empty: CampusPage = await gateway.campuses(
            { q: '', district: '', page: 3, pageSize: 2 },
            cancellation,
          );
          assert.equal(empty.total, 4);
          assert.deepEqual(empty.items, []);
          assert.ok(
            transport.exchanges
              .filter(({ path }) => path.startsWith('/v1/campuses'))
              .every(({ authorized, status }) => !authorized && status === 200),
          );
        },
      );

      await t.test(
        'selection and Unicode profile writes return the native exact profile contract',
        async () => {
          profile = await gateway.selectCampus(
            { expectedRevision: 0, campusId },
            cancellation,
          );
          assert.equal(profile.selectedCampus?.id, campusId);
          assert.equal(profile.revision, 1);
          profile = await gateway.updateProfile(
            {
              expectedRevision: 1,
              nickname: '鲸鱼_#&@.+-123',
              bio: '🐳'.repeat(100),
            },
            cancellation,
          );
          assert.equal(profile.nickname, '鲸鱼_#&@.+-123');
          assert.equal(profile.bio, '🐳'.repeat(100));
          assert.equal(profile.selectedCampus?.id, campusId);
          assert.equal(profile.revision, 2);
          const saved = await pool.query<{ bio: string; revision: number }>(
            'SELECT bio,revision FROM whaleu_profile.profiles WHERE account_id=$1',
            [profile.accountId],
          );
          assert.equal(saved.rows[0]?.bio, profile.bio);
          assert.equal(saved.rows[0]?.revision, 2);
        },
      );

      await t.test(
        'partial preferences merge, invalid merged flags return typed 400, explicit switching succeeds',
        async () => {
          profile = await gateway.updatePreferences(
            {
              expectedRevision: 2,
              preferences: {
                defaultCommentAnonymousEnabled: true,
                hideProfilePosts: true,
              },
            },
            cancellation,
          );
          assert.equal(profile.revision, 3);
          assert.deepEqual(profile.preferences, {
            ...preferenceDefaults,
            defaultCommentAnonymousEnabled: true,
            hideProfilePosts: true,
          });
          await assert.rejects(
            gateway.updatePreferences(
              {
                expectedRevision: 3,
                preferences: { defaultCommentNonAnonymousEnabled: true },
              },
              cancellation,
            ),
            clientFailure('business', 400, 'BAD_REQUEST'),
          );
          const unchanged: OwnProfile = await gateway.profile(cancellation);
          assert.deepEqual(unchanged, profile);
          profile = await gateway.updatePreferences(
            {
              expectedRevision: 3,
              preferences: {
                defaultCommentAnonymousEnabled: false,
                defaultCommentNonAnonymousEnabled: true,
              },
            },
            cancellation,
          );
          assert.equal(profile.revision, 4);
          assert.equal(profile.preferences.hideProfilePosts, true);
          assert.equal(
            profile.preferences.defaultCommentAnonymousEnabled,
            false,
          );
          assert.equal(
            profile.preferences.defaultCommentNonAnonymousEnabled,
            true,
          );
        },
      );

      await t.test(
        'stale revisions and unavailable/missing campus errors retain HTTP status and server code without writes',
        async () => {
          const before = transport.exchanges.length;
          await assert.rejects(
            gateway.updateProfile(
              { expectedRevision: 3, nickname: 'Stale' },
              cancellation,
            ),
            clientFailure('business', 409, 'PROFILE_REVISION_CONFLICT'),
          );
          assert.equal(
            transport.exchanges.length,
            before + 1,
            'Never replay a conflicting mutation',
          );
          await assert.rejects(
            gateway.selectCampus(
              { expectedRevision: 4, campusId: inactiveId },
              cancellation,
            ),
            clientFailure('business', 409, 'CAMPUS_UNAVAILABLE'),
          );
          await assert.rejects(
            gateway.selectCampus(
              { expectedRevision: 4, campusId: randomUUID() },
              cancellation,
            ),
            clientFailure('http', 404, 'CAMPUS_NOT_FOUND'),
          );
          const authoritative: OwnProfile = await gateway.profile(cancellation);
          assert.deepEqual(authoritative, profile);
        },
      );

      await t.test(
        'invalid scalar text is rejected before native dispatch and raw HTTP invalid input never writes',
        async () => {
          const invalidValues = [
            'bad\0value',
            '\ud800',
            '\udfff',
            '🐳'.repeat(101),
          ];
          for (const value of invalidValues) {
            const before = transport.exchanges.length;
            for (const field of ['q', 'district'] as const) {
              await assert.rejects(
                gateway.campuses(
                  {
                    q: '',
                    district: '',
                    page: 1,
                    pageSize: 20,
                    [field]: value,
                  },
                  cancellation,
                ),
                (error: unknown) =>
                  error instanceof ClientError &&
                  (error as { kind: string }).kind === 'business',
              );
            }
            await assert.rejects(
              async () =>
                gateway.updateProfile(
                  { expectedRevision: 4, bio: value },
                  cancellation,
                ),
              (error: unknown) =>
                error instanceof ClientError &&
                (error as { kind: string }).kind === 'business',
            );
            assert.equal(
              transport.exchanges.length,
              before,
              'Invalid native input must not dispatch',
            );
            const response = await transport.send({
              url: `${nativeOrigin}/v1/me/profile`,
              method: 'PATCH',
              headers: {
                'content-type': 'application/json',
                Authorization: `Bearer ${credentials.accessToken}`,
              },
              body: { expectedRevision: 4, bio: value },
              timeoutMs: 5000,
            });
            clientFailure(
              'business',
              400,
              'BAD_REQUEST',
            )(responseError(response));
          }
          // Lone surrogates have no valid UTF-8 URL encoding. Their raw HTTP
          // rejection is tested through JSON above; query rejection uses NUL and
          // valid Unicode over the wire, with no URL replacement ambiguity.
          for (const value of ['bad\0value', '🐳'.repeat(101)]) {
            for (const field of ['q', 'district']) {
              const response = await transport.send({
                url: `${nativeOrigin}/v1/campuses?${field}=${encodeURIComponent(value)}`,
                method: 'GET',
                headers: {},
                timeoutMs: 5000,
              });
              clientFailure(
                'business',
                400,
                'BAD_REQUEST',
              )(responseError(response));
            }
          }
          const authoritative: OwnProfile = await gateway.profile(cancellation);
          assert.deepEqual(authoritative, profile);
        },
      );

      await t.test(
        'expired access refreshes through the actual gateway once and retries only the profile read',
        async () => {
          await pool.query(
            "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()-interval '1 minute' WHERE session_id=$1",
            [credentials.sessionId],
          );
          const before = transport.exchanges.length;
          const refreshed: OwnProfile = await gateway.profile(cancellation);
          assert.deepEqual(refreshed, profile);
          assert.deepEqual(
            transport.exchanges
              .slice(before)
              .map(({ path, method, status }) => ({ path, method, status })),
            [
              { path: '/v1/me/profile', method: 'GET', status: 401 },
              { path: '/v1/auth/refresh', method: 'POST', status: 200 },
              { path: '/v1/me/profile', method: 'GET', status: 200 },
            ],
          );
          const rotated: SessionCredentials = sessions.snapshot().credentials;
          assert.ok(
            rotated.accessToken !== credentials.accessToken,
            'Access credential rotates',
          );
          assert.ok(
            rotated.refreshToken !== credentials.refreshToken,
            'Refresh credential rotates',
          );
          assert.equal(rotated.sessionId, credentials.sessionId);
          credentials = rotated;
        },
      );

      await t.test(
        'logout confirms HTTP 204, clears native state, and revokes server access while directory remains public',
        async () => {
          await auth.logout();
          assert.equal(sessions.snapshot().credentials, null);
          assert.deepEqual(transport.exchanges.at(-1), {
            path: '/v1/auth/logout',
            method: 'POST',
            authorized: true,
            status: 204,
          });
          const revoked = new SessionStore();
          revoked.completeLogin(revoked.beginLogin(), credentials);
          const revokedGateway = new HttpProfileGateway(
            new ApiClient(nativeOrigin, transport, revoked, auth),
          );
          await assert.rejects(
            revokedGateway.profile(cancellation),
            clientFailure('auth-required', 401, 'SESSION_REVOKED'),
          );
          const page: CampusPage = await gateway.campuses(
            { q: '', district: '', page: 1, pageSize: 20 },
            cancellation,
          );
          assert.equal(page.total, 4);
          assert.equal(transport.exchanges.at(-1)?.authorized, false);
        },
      );
    } finally {
      try {
        await app?.close();
      } finally {
        try {
          if (ownsSchemas) {
            await pool.query(
              'DROP SCHEMA IF EXISTS whaleu_verification CASCADE',
            );
            await pool.query(
              'DROP SCHEMA IF EXISTS whaleu_authorization CASCADE',
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
    }
  },
);
