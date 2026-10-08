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
import {
  COMMUNITY_AUTHORIZATION,
  COMMUNITY_VISIBILITY,
  CONTENT_PUBLICATION_GATE,
  MEDIA_ATTACHMENT,
} from '../../src/community/community-policy.js';
import type {
  CommentView,
  FeedPage,
  PostView,
  PublicationReceipt,
  PublishPost,
} from '../../src/community/contracts.js';
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
import type { SessionCredentials } from '../../src/identity/contracts.js';
import { STUDENT_IDENTITY_SOURCE } from '../../src/identity-privacy/contracts.js';
import type {
  PrivateIdentity,
  StudentIdentitySource,
  VerifiedStudentIdentity,
} from '../../src/identity-privacy/contracts.js';
import {
  FixtureAuthorization,
  FixtureVisibility,
  FixtureContent,
  FixtureMedia,
  approve,
  fixtureSchema,
  grant,
  verified,
} from '../support/community-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

// Execute the real native sources. Only platform I/O and unavailable external
// providers are substituted, in this test module only; no runtime bypass exists.
const require = createRequire(import.meta.url);
const { ApiClient } = require('../../../wechat/src/api/client.ts');
const { ClientError } = require('../../../wechat/src/api/errors.ts');
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
  decodePost,
  decodeReceipt,
} = require('../../../wechat/src/community/contract.ts');
const {
  HttpIdentityPrivacyGateway,
  IdentityOverlayController,
} = require('../../../wechat/src/identity-privacy/overlay.ts');

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

class FixtureStudents implements StudentIdentitySource {
  async resolve(
    accountId: string,
    tx: PoolClient,
  ): Promise<VerifiedStudentIdentity> {
    const row = (
      await tx.query<{ student_number: string }>(
        'SELECT student_number FROM whaleu_community_test.students WHERE account_id=$1 FOR SHARE',
        [accountId],
      )
    ).rows[0];
    return row
      ? {
          status: 'verified',
          studentNumber: row.student_number,
          validUntil: null,
        }
      : { status: 'unverified' };
  }
}
function created(
  receipt: PublicationReceipt,
): Extract<PublicationReceipt, { outcome: 'created' }> {
  assert.equal(receipt.outcome, 'created');
  assert.ok(receipt.outcome === 'created');
  return receipt;
}
interface OverlayView {
  developerEnabled: boolean;
  items: Readonly<Record<string, PrivateIdentity>>;
  notice: string;
}
function noPrivateFields(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(
      ![
        'accountId',
        'studentNumber',
        'studentNumberStatus',
        'identity',
        'identities',
      ].includes(key),
      `Ordinary DTO contains private field ${key}`,
    );
    noPrivateFields(child);
  }
}

test(
  'real native community/privacy gateways, Nest HTTP and PostgreSQL contract',
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
      WECHAT_APP_ID: 'wx0000000000000000',
      WECHAT_APP_SECRET: 'synthetic-local-community-contract-only',
      AUTH_RATE_LIMIT_KEY: 'cd'.repeat(32),
    });
    const pool = new Pool(poolOptions(config));
    let suite: PoolClient | undefined;
    let locked = false,
      ownsSchemas = false;
    let app: INestApplication | undefined;
    const content = new FixtureContent();
    const startApp = async (port = 0): Promise<INestApplication> => {
      const module = await Test.createTestingModule({
        imports: [AppModule.register(config)],
      })
        .overrideProvider(IDENTITY_PROVIDER)
        .useValue({
          exchange: async (code: string) => ({
            provider: 'wechat',
            appId: 'synthetic-native-community',
            subject: code,
          }),
        })
        .overrideProvider(COMMUNITY_AUTHORIZATION)
        .useValue(new FixtureAuthorization())
        .overrideProvider(COMMUNITY_VISIBILITY)
        .useValue(new FixtureVisibility())
        .overrideProvider(CONTENT_PUBLICATION_GATE)
        .useValue(content)
        .overrideProvider(MEDIA_ATTACHMENT)
        .useValue(new FixtureMedia())
        .overrideProvider(STUDENT_IDENTITY_SOURCE)
        .useValue(new FixtureStudents())
        .compile();
      const next = module.createNestApplication({ logger: false });
      configureHttp(next);
      await next.listen(port, '127.0.0.1');
      return next;
    };
    try {
      suite = await pool.connect();
      locked =
        (
          await suite.query<{ locked: boolean }>(
            'SELECT pg_try_advisory_lock($1,$2) AS locked',
            [MIGRATION_LOCK[0], 2],
          )
        ).rows[0]?.locked === true;
      assert.equal(
        locked,
        true,
        'Another suite owns the disposable database; run serially',
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
        "SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
      );
      assert.equal(
        existing.rows[0]?.count,
        0,
        'Refusing existing whaleu schemas; use a fresh disposable database',
      );
      ownsSchemas = true;
      await runMigrations(
        pool,
        await readMigrations(
          fileURLToPath(new URL('../../migrations', import.meta.url)),
        ),
        { mode: 'up' },
      );
      await fixtureSchema(pool);
      await pool.query(
        'CREATE TABLE whaleu_community_test.students(account_id uuid PRIMARY KEY,student_number text NOT NULL)',
      );
      app = await startApp();
      const port = Number(new URL(await app.getUrl()).port);
      const transport = new NodeHttpTransport(port);
      const cancel = new Cancellation();
      const makeClient = async (code: string, saved?: SessionCredentials) => {
        const sessions = new SessionStore();
        const auth = new AuthService(
          sessions,
          new HttpAuthGateway(nativeOrigin, transport, systemClock),
          { login: async () => code },
          systemClock,
        );
        if (saved) sessions.completeLogin(sessions.beginLogin(), saved);
        else await auth.login();
        const credentials: SessionCredentials = sessions.snapshot().credentials;
        assert.ok(credentials);
        const api = new ApiClient(nativeOrigin, transport, sessions, auth);
        return {
          sessions,
          auth,
          credentials,
          api,
          community: new HttpCommunityGateway(api),
          privacy: new HttpIdentityPrivacyGateway(api),
        };
      };
      const author = await makeClient('synthetic-community-author');
      const developer = await makeClient('synthetic-community-developer');
      const other = await makeClient('synthetic-community-other');
      const region = randomUUID(),
        spaceId = randomUUID(),
        institution = randomUUID(),
        campus = randomUUID();
      const developerGrant = randomUUID();
      const studentNumber = 'SYNTHETIC-20260001';
      await pool.query(
        "INSERT INTO whaleu_campus.institutions(id,name) VALUES ($1,'Synthetic Native Contract University')",
        [institution],
      );
      await pool.query(
        "INSERT INTO whaleu_campus.campuses(id,institution_id,full_name,district,is_active) VALUES ($1,$2,'Synthetic Native Campus','Synthetic District',true)",
        [campus, institution],
      );
      await pool.query(
        "INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES ($1,'Synthetic Native Region',true)",
        [region],
      );
      await pool.query(
        'INSERT INTO whaleu_campus.campus_region_assignments(campus_id,operating_region_id) VALUES ($1,$2)',
        [campus, region],
      );
      await pool.query(
        "INSERT INTO whaleu_community.spaces(id,kind,name,is_active,operating_region_id) VALUES ($1,'regional','Synthetic Native Space',true,$2)",
        [spaceId, region],
      );
      for (const actor of [author, developer, other])
        await grant(
          pool,
          actor.credentials.accountId,
          spaceId,
          verified(region),
        );
      await pool.query(
        "INSERT INTO whaleu_profile.profiles(account_id,nickname) VALUES ($1,'SyntheticAuthor')",
        [author.credentials.accountId],
      );
      await pool.query(
        'INSERT INTO whaleu_community_test.students(account_id,student_number) VALUES ($1,$2)',
        [author.credentials.accountId, studentNumber],
      );
      await pool.query(
        "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,approved_by_account_id,approval_reference) VALUES ($1,$2,'developer',$2,'synthetic-fixture-only'),($3,$4,'super_admin',$2,'synthetic-fixture-only')",
        [
          developerGrant,
          developer.credentials.accountId,
          randomUUID(),
          other.credentials.accountId,
        ],
      );
      const intent = (
        text: string,
        authorMode: 'named' | 'anonymous' = 'named',
      ): PublishPost => ({
        clientRequestId: randomUUID(),
        spaceId,
        category: 'discussion',
        text,
        imageAssetIds: [],
        authorMode,
        commentsPolicy: 'open',
      });
      const namedIntent = intent('Synthetic named post 🐳');
      const anonymousIntent = intent('Synthetic anonymous post', 'anonymous');
      let named!: Extract<PublicationReceipt, { outcome: 'created' }>;
      let anonymous!: Extract<PublicationReceipt, { outcome: 'created' }>;
      let comment!: Extract<PublicationReceipt, { outcome: 'created' }>;

      await t.test(
        'native publication, feed, detail and comment decoders preserve named/anonymous DTO separation',
        async () => {
          assert.equal(
            (await author.community.spaces(campus, cancel)).regional.id,
            spaceId,
          );
          assert.equal(transport.exchanges.at(-1)?.authorized, false);
          const capabilities = await author.community.capabilities(
            spaceId,
            'discussion',
            cancel,
          );
          assert.deepEqual(capabilities.authorModes, ['named', 'anonymous']);
          assert.equal(capabilities.publish.availability, 'allowed');
          for (const body of [namedIntent, anonymousIntent])
            await approve(pool, author.credentials.accountId, body.text);
          named = created(
            await author.community.publishPost(namedIntent, cancel),
          );
          anonymous = created(
            await author.community.publishPost(anonymousIntent, cancel),
          );
          await approve(
            pool,
            author.credentials.accountId,
            'Synthetic anonymous root comment',
            'publish_comment',
          );
          comment = created(
            await author.community.publishComment(
              anonymous.resourceId,
              {
                clientRequestId: randomUUID(),
                text: 'Synthetic anonymous root comment',
                imageAssetIds: [],
                authorMode: 'anonymous',
              },
              cancel,
            ),
          );
          const namedPost: PostView = await author.community.post(
            named.resourceId,
            cancel,
          );
          const anonymousPost: PostView = await author.community.post(
            anonymous.resourceId,
            cancel,
          );
          assert.equal(namedPost.author.kind, 'named');
          assert.equal(namedPost.author.displayName, 'SyntheticAuthor');
          assert.deepEqual(Object.keys(namedPost.author).sort(), [
            'avatar',
            'displayName',
            'experienceDisplay',
            'kind',
            'profileId',
          ]);
          assert.equal(anonymousPost.author.kind, 'anonymous');
          assert.deepEqual(Object.keys(anonymousPost.author).sort(), [
            'avatar',
            'displayName',
            'isPostAuthor',
            'kind',
            'personaId',
          ]);
          assert.ok(anonymousPost.author.kind === 'anonymous');
          assert.notEqual(
            anonymousPost.author.personaId,
            author.credentials.accountId,
          );
          assert.notEqual(
            anonymousPost.author.displayName,
            namedPost.author.displayName,
          );
          assert.equal(anonymousPost.author.isPostAuthor, true);
          const comments: { items: CommentView[]; nextCursor: string | null } =
            await author.community.comments(anonymous.resourceId, null, cancel);
          assert.equal(comments.items.length, 1);
          assert.equal(comments.items[0]?.id, comment.resourceId);
          assert.deepEqual(comments.items[0]?.author, anonymousPost.author);
          const feed: FeedPage = await author.community.feed(
            { spaceId },
            cancel,
          );
          assert.deepEqual(
            new Set(feed.items.map((item) => item.id)),
            new Set([named.resourceId, anonymous.resourceId]),
          );
          assert.equal(feed.continuation, 'end');
          assert.equal(feed.nextCursor, null);
          for (const dto of [namedPost, anonymousPost, comments, feed])
            noPrivateFields(dto);
          assert.ok(
            Object.isFrozen(anonymousPost.author),
            'Real native decoder ran on the HTTP response',
          );
          assert.ok(
            !JSON.stringify(anonymousPost).includes(
              author.credentials.accountId,
            ),
          );
          assert.ok(!JSON.stringify(feed).includes(studentNumber));
        },
      );

      await t.test(
        'created and rejected publication receipts survive Nest restart and replay without duplicate writes',
        async () => {
          const deniedIntent = intent('Synthetic unapproved content');
          const denied: PublicationReceipt = await author.community.publishPost(
            deniedIntent,
            cancel,
          );
          assert.deepEqual(denied, {
            requestId: deniedIntent.clientRequestId,
            operation: 'publish_post',
            outcome: 'rejected',
            code: 'CONTENT_REJECTED',
          });
          await app!.close();
          app = undefined;
          app = await startApp(port);
          // A new server and new native client cannot satisfy this from process memory.
          const restored = await makeClient(
            'unused-restored-fixture',
            author.credentials,
          );
          assert.deepEqual(
            await restored.community.receipt(named.requestId, cancel),
            named,
          );
          assert.deepEqual(
            await restored.community.publishPost(namedIntent, cancel),
            named,
          );
          await approve(pool, author.credentials.accountId, deniedIntent.text);
          assert.deepEqual(
            await restored.community.publishPost(deniedIntent, cancel),
            denied,
          );
          assert.deepEqual(
            await restored.community.receipt(
              deniedIntent.clientRequestId,
              cancel,
            ),
            denied,
          );
          await assert.rejects(
            restored.community.publishPost(
              { ...namedIntent, text: 'Changed immutable intent' },
              cancel,
            ),
            clientFailure('business', 409, 'REQUEST_CONFLICT'),
          );
          const rows = await pool.query<{ receipt: PublicationReceipt }>(
            'SELECT receipt FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2',
            [author.credentials.accountId, named.requestId],
          );
          assert.deepEqual(rows.rows, [{ receipt: named }]);
          assert.equal(
            (
              await pool.query(
                'SELECT id FROM whaleu_community.posts WHERE account_id=$1',
                [author.credentials.accountId],
              )
            ).rowCount,
            2,
          );
        },
      );

      await t.test(
        'developer overlay displays verified fixture identity directly and ordinary HTTP DTOs stay private',
        async () => {
          const views: OverlayView[] = [];
          const overlay = new IdentityOverlayController(
            developer.sessions,
            developer.privacy,
            systemClock,
            (view: OverlayView) => views.push(view),
          );
          try {
            const before: FeedPage = await developer.community.feed(
              { spaceId },
              cancel,
            );
            await overlay.show([
              {
                kind: 'post',
                id: anonymous.resourceId,
                authorMode: 'anonymous',
              },
              {
                kind: 'comment',
                id: comment.resourceId,
                authorMode: 'anonymous',
              },
              { kind: 'post', id: named.resourceId, authorMode: 'named' },
            ]);
            const view = views.at(-1)!;
            assert.equal(
              view.developerEnabled,
              true,
              'show directly resolves identities without a separate toggle',
            );
            assert.deepEqual(
              Object.keys(view.items).sort(),
              [
                anonymous.resourceId,
                comment.resourceId,
                named.resourceId,
              ].sort(),
            );
            for (const identity of Object.values(view.items))
              assert.deepEqual(identity, {
                accountId: author.credentials.accountId,
                nickname: 'SyntheticAuthor',
                avatar: null,
                studentNumber,
                studentNumberStatus: 'verified',
              });
            const after: FeedPage = await developer.community.feed(
              { spaceId },
              cancel,
            );
            assert.deepEqual(
              after,
              before,
              'Private overlay must not augment ordinary community state',
            );
            noPrivateFields(after);
            const raw = await transport.send({
              url: `${nativeOrigin}/v1/community/posts/${anonymous.resourceId}`,
              method: 'GET',
              headers: {
                Authorization: `Bearer ${developer.credentials.accessToken}`,
              },
              timeoutMs: 5000,
            });
            assert.equal(raw.status, 200);
            noPrivateFields(raw.body);
            assert.ok(!JSON.stringify(raw.body).includes(studentNumber));
            assert.ok(
              !JSON.stringify(raw.body).includes(author.credentials.accountId),
            );
            const audit = await pool.query<{
              target_id: string;
              disclosed_fields: string[];
            }>(
              "SELECT target_id,disclosed_fields FROM whaleu_authorization.identity_view_audit WHERE actor_account_id=$1 AND outcome='disclosed' ORDER BY target_id",
              [developer.credentials.accountId],
            );
            assert.equal(
              audit.rowCount,
              3,
              'Every disclosed target is audited before HTTP success',
            );
            for (const row of audit.rows)
              assert.deepEqual(row.disclosed_fields, [
                'accountId',
                'nickname',
                'studentNumber',
              ]);
            // Account replacement immediately removes an already-visible overlay.
            developer.sessions.completeLogin(
              developer.sessions.beginLogin(),
              author.credentials,
            );
            assert.deepEqual(views.at(-1)?.items, {});
            assert.equal(views.at(-1)?.developerEnabled, false);
          } finally {
            overlay.dispose();
            developer.sessions.completeLogin(
              developer.sessions.beginLogin(),
              developer.credentials,
            );
          }
        },
      );

      await t.test(
        'member and super administrator cannot fetch identities or cause ordinary overlay disclosure',
        async () => {
          const target = [{ kind: 'post', id: anonymous.resourceId }];
          for (const [actor, role] of [
            [author, 'member'],
            [other, 'super_admin'],
          ] as const) {
            const authorization = await actor.privacy.authorization(cancel);
            assert.equal(authorization.role, role);
            assert.equal(authorization.identityView.allowed, false);
            await assert.rejects(
              actor.privacy.identities(target, cancel),
              clientFailure('forbidden', 403, 'AUTHORIZATION_REQUIRED'),
            );
            const views: OverlayView[] = [];
            const overlay = new IdentityOverlayController(
              actor.sessions,
              actor.privacy,
              systemClock,
              (view: OverlayView) => views.push(view),
            );
            try {
              const before = transport.exchanges.filter(
                (exchange) =>
                  exchange.path === '/v1/identity-privacy/content-identities',
              ).length;
              await overlay.show([{ ...target[0], authorMode: 'anonymous' }]);
              assert.equal(
                transport.exchanges.filter(
                  (exchange) =>
                    exchange.path === '/v1/identity-privacy/content-identities',
                ).length,
                before,
                'Nondevelopers never send the private batch from the overlay',
              );
              assert.ok(
                views.every(
                  (view) =>
                    !view.developerEnabled &&
                    Object.keys(view.items).length === 0,
                ),
              );
            } finally {
              overlay.dispose();
            }
          }
          const audit = await pool.query(
            "SELECT outcome,disclosed_fields FROM whaleu_authorization.identity_view_audit WHERE outcome='denied'",
          );
          assert.equal(audit.rowCount, 2);
          assert.ok(
            audit.rows.every(
              (row) =>
                row.outcome === 'denied' && row.disclosed_fields.length === 0,
            ),
          );
        },
      );

      await t.test(
        'malformed HTTP inputs preserve native error envelopes and no-write guarantees',
        async () => {
          const before = (
            await pool.query(
              'SELECT * FROM whaleu_community.publication_requests',
            )
          ).rowCount;
          // Deliberately bypass only native intent validation, retaining the real
          // ApiClient, HTTP request, Nest validation/filter and native error decoder.
          await assert.rejects(
            author.api.request(
              {
                path: '/v1/community/posts',
                method: 'POST',
                authentication: 'required',
                authReplay: 'never',
                successStatus: 201,
                decode: decodeReceipt,
              },
              {
                body: {
                  ...intent('Malformed overposting attempt'),
                  accountId: developer.credentials.accountId,
                },
                cancellation: cancel,
              },
            ),
            clientFailure('business', 400, 'BAD_REQUEST'),
          );
          await assert.rejects(
            author.api.request(
              {
                path: '/v1/identity-privacy/content-identities',
                method: 'POST',
                authentication: 'required',
                authReplay: 'never',
                successStatus: 200,
                decode: (value: unknown) => value,
              },
              {
                body: {
                  targets: [{ kind: 'post', id: anonymous.resourceId }],
                  accountId: author.credentials.accountId,
                },
                cancellation: cancel,
              },
            ),
            clientFailure('business', 400, 'BAD_REQUEST'),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM whaleu_community.publication_requests',
              )
            ).rowCount,
            before,
          );
          await assert.rejects(
            author.community.post(randomUUID(), cancel),
            clientFailure('http', 404, 'POST_NOT_FOUND'),
          );
          content.unavailable = true;
          try {
            const unavailable = intent('Synthetic unavailable moderation');
            await assert.rejects(
              author.community.publishPost(unavailable, cancel),
              clientFailure('http', 503, 'CONTENT_REVIEW_UNAVAILABLE'),
            );
            await assert.rejects(
              author.community.receipt(unavailable.clientRequestId, cancel),
              clientFailure('http', 404, 'REQUEST_NOT_FOUND'),
            );
          } finally {
            content.unavailable = false;
          }
          // The actual HTTP DTO is accepted; an unexpected private extension is not.
          const response = await transport.send({
            url: `${nativeOrigin}/v1/community/posts/${anonymous.resourceId}`,
            method: 'GET',
            headers: {
              Authorization: `Bearer ${author.credentials.accessToken}`,
            },
            timeoutMs: 5000,
          });
          assert.equal(response.status, 200);
          assert.equal(decodePost(response.body).id, anonymous.resourceId);
          assert.throws(
            () =>
              decodePost({
                ...(response.body as Record<string, unknown>),
                identity: { studentNumber },
              }),
            (error: unknown) =>
              error instanceof ClientError &&
              (error as { kind: string }).kind === 'protocol',
          );
        },
      );

      await t.test(
        'receipt and own-publication lookups are account scoped even when request IDs are reused',
        async () => {
          await assert.rejects(
            other.community.receipt(named.requestId, cancel),
            clientFailure('http', 404, 'REQUEST_NOT_FOUND'),
          );
          assert.deepEqual(
            (await other.community.mine(null, cancel)).items,
            [],
          );
          const authorMine: { items: { id: string }[] } =
            await author.community.mine(null, cancel);
          assert.deepEqual(
            new Set(authorMine.items.map((item) => item.id)),
            new Set([named.resourceId, anonymous.resourceId]),
          );
          await approve(pool, other.credentials.accountId, namedIntent.text);
          const second = created(
            await other.community.publishPost(namedIntent, cancel),
          );
          assert.equal(second.requestId, named.requestId);
          assert.notEqual(second.resourceId, named.resourceId);
          assert.deepEqual(
            await other.community.receipt(named.requestId, cancel),
            second,
          );
          assert.deepEqual(
            await author.community.receipt(named.requestId, cancel),
            named,
          );
          assert.deepEqual(
            (await other.community.mine(null, cancel)).items.map(
              (item: { id: string }) => item.id,
            ),
            [second.resourceId],
          );
          const count = await pool.query(
            'SELECT * FROM whaleu_community.publication_requests WHERE client_request_id=$1',
            [named.requestId],
          );
          assert.equal(count.rowCount, 2);
        },
      );

      await t.test(
        'revoked developer grants and sessions stop native private access and durable receipt replay',
        async () => {
          await pool.query(
            'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$2 WHERE id=$1',
            [developerGrant, developer.credentials.accountId],
          );
          assert.equal(
            (await developer.privacy.authorization(cancel)).identityView
              .allowed,
            false,
          );
          await assert.rejects(
            developer.privacy.identities(
              [{ kind: 'post', id: anonymous.resourceId }],
              cancel,
            ),
            clientFailure('forbidden', 403, 'AUTHORIZATION_REQUIRED'),
          );
          await author.auth.logout();
          const revoked = await makeClient(
            'unused-revoked-fixture',
            author.credentials,
          );
          for (const operation of [
            () => revoked.community.receipt(named.requestId, cancel),
            () => revoked.community.publishPost(namedIntent, cancel),
            () =>
              revoked.privacy.identities(
                [{ kind: 'post', id: anonymous.resourceId }],
                cancel,
              ),
          ]) {
            const before = transport.exchanges.length;
            await assert.rejects(
              operation(),
              clientFailure('auth-required', 401, 'SESSION_REVOKED'),
            );
            assert.equal(
              transport.exchanges.length,
              before + 1,
              'Revocation never triggers refresh or mutation replay',
            );
          }
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM whaleu_community.posts WHERE account_id=$1',
                [author.credentials.accountId],
              )
            ).rowCount,
            2,
          );
        },
      );
    } finally {
      try {
        await app?.close();
      } finally {
        try {
          if (ownsSchemas) {
            for (const schema of [
              'whaleu_community_test',
              ...migrationSchemaNames,
            ])
              await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
          }
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
