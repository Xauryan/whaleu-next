import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { request as nodeRequest } from 'node:http';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import { AppModule } from '../../src/app.module.js';
import type {
  CommentView,
  PostView,
  PublicationReceipt,
  PublishPost,
  PublishComment,
} from '../../src/community/contracts.js';
import type { PublishReply } from '../../src/community/discussion/contracts.js';
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
import type { SessionCredentials } from '../../src/identity/contracts.js';
import { hashToken } from '../../src/identity/tokens.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import {
  createRuntimeActor,
  setRuntimeVerification,
  postApprovalEnvelope,
  discussionApprovalEnvelope,
} from '../support/community-runtime-fixtures.js';
import {
  seedCommunityScope,
  appendIdentitySelection,
  setRegionPolicy,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';
import {
  seedReviewPolicy,
  approveEnvelope,
  setReviewState,
} from '../support/community-approval-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

// Execute real native gateways, strict decoders and controllers through loopback
// HTTP into the ordinary AppModule. There are NO application provider overrides.
// Test-only canonical records provide synthetic authority; neither production
// startup nor any public endpoint can issue those records. Media stays unavailable.
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
  HttpBlockGateway,
} = require('../../../wechat/src/community/block-gateway.ts');
const {
  HttpReportGateway,
} = require('../../../wechat/src/community/report-gateway.ts');
const {
  createCommunityRuntime,
} = require('../../../wechat/src/community/runtime.ts');
const {
  ComposeController,
  initialComposeView,
} = require('../../../wechat/src/pages/community-compose/controller.ts');
const {
  DetailController,
  initialDetailView,
} = require('../../../wechat/src/pages/community-detail/controller.ts');
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
  dropSuccess: { path: string; method: string } | null = null;
  corruptNext: { path: string; extra: Record<string, unknown> } | null = null;
  failNext: string | null = null;
  private gate: {
    path: string;
    method: string;
    received: () => void;
    release: Promise<void>;
  } | null = null;
  holdNext(path: string, method = 'GET') {
    let received!: () => void, release!: () => void;
    const arrived = new Promise<void>((resolve) => {
      received = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.gate = { path, method, received, release: released };
    return { arrived, release };
  }
  checkResponse:
    ((path: string, status: number, body: unknown) => void) | null = null;

  constructor(private readonly port: number) {}

  send(input: NativeRequest): Promise<NativeResponse> {
    const url = new URL(input.url);
    assert.equal(url.origin, nativeOrigin, 'Refuse a non-fixture API origin');
    assert.equal(url.username, '');
    assert.equal(url.password, '');
    assert.equal(url.hash, '');
    if (input.cancellation?.isCancelled)
      return Promise.reject(new ClientError('cancelled', 'Request cancelled'));
    if (this.failNext === url.pathname) {
      this.failNext = null;
      return Promise.reject(
        new ClientError('network', 'Synthetic offline read'),
      );
    }
    const body =
      input.body === undefined ? undefined : JSON.stringify(input.body);
    return new Promise((resolve, reject) => {
      const request = nodeRequest(
        {
          hostname: '127.0.0.1',
          port: this.port,
          path: `${url.pathname}${url.search}`,
          method: input.method,
          // DELETE carries a receipt key too. Node otherwise omits framing for
          // DELETE bodies; the native transport always sends the complete JSON.
          headers: {
            ...input.headers,
            ...(body === undefined
              ? {}
              : { 'content-length': Buffer.byteLength(body) }),
          },
          agent: false,
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.once('error', () =>
            reject(new Error('Local HTTP read failed')),
          );
          response.once('end', async () => {
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
              if (
                status >= 200 &&
                status < 300 &&
                this.dropSuccess?.path === url.pathname &&
                this.dropSuccess.method === input.method
              ) {
                this.dropSuccess = null;
                reject(
                  new ClientError(
                    'network',
                    'Synthetic response loss after commit',
                  ),
                );
                return;
              }
              if (
                this.gate?.path === url.pathname &&
                this.gate.method === input.method
              ) {
                const gate = this.gate;
                this.gate = null;
                gate.received();
                // Deliberately hold a fully received real response even after cancellation.
                // Controllers must reject stale callbacks, not rely on cooperative I/O.
                await gate.release;
              }
              let result = raw === '' ? '' : JSON.parse(raw);
              // Check the real server payload before deliberate decoder corruption.
              this.checkResponse?.(url.pathname, status, result);
              if (this.corruptNext?.path === url.pathname) {
                result = { ...result, ...this.corruptNext.extra };
                this.corruptNext = null;
              }
              if (
                status === 200 &&
                (url.pathname.includes('/safety/report') ||
                  url.pathname.includes('/safety/jury') ||
                  url.pathname.includes('/system-notices'))
              ) {
                assert.equal(headers['cache-control'], 'no-store');
                assert.equal(headers['vary'], 'Authorization');
              }
              resolve({ status, headers, body: result });
            } catch (error) {
              reject(error);
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
      if (body !== undefined) request.write(body);
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

function platformStorage() {
  const values = new Map<string, unknown>();
  return {
    getStorageSync: (key: string) => structuredClone(values.get(key)),
    setStorageSync: (key: string, value: unknown) =>
      values.set(key, structuredClone(value)),
    removeStorageSync: (key: string) => {
      values.delete(key);
    },
    getRandomValues: (input: {
      length: number;
      success(value: { randomValues: ArrayBuffer }): void;
    }) =>
      input.success({
        randomValues: Uint8Array.from(randomBytes(input.length)).buffer,
      }),
  };
}
function created(
  receipt: PublicationReceipt,
): Extract<PublicationReceipt, { outcome: 'created' }> {
  assert.equal(receipt.outcome, 'created');
  assert.ok(receipt.outcome === 'created');
  assert.deepEqual(Object.keys(receipt).sort(), [
    'createdAt',
    'operation',
    'outcome',
    'requestId',
    'resourceId',
  ]);
  return receipt;
}
function rejected(receipt: PublicationReceipt, code: string): void {
  assert.equal(receipt.outcome, 'rejected');
  assert.ok(receipt.outcome === 'rejected');
  assert.equal(receipt.code, code);
  assert.deepEqual(Object.keys(receipt).sort(), [
    'code',
    'operation',
    'outcome',
    'requestId',
  ]);
}
function noPrivateFields(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(
      ![
        'accountId',
        'account_id',
        'phone',
        'phoneNumber',
        'studentNumber',
        'studentNumberStatus',
        'affiliationAssertionId',
        'affiliationSnapshotId',
        'identityCampusId',
        'identitySelectionId',
        'identityRegionId',
        'topologySnapshotId',
        'approvalDecisionId',
        'decisionId',
        'digest',
        'provenance',
        'provenanceRef',
        'policyRevisionId',
        'scope',
        'envelope',
      ].includes(key),
      `Public community DTO leaked ${key}`,
    );
    noPrivateFields(child);
  }
}
interface ComposeView {
  loaded: boolean;
  canSubmit: boolean;
  blocker: string;
  text: string;
}
interface DetailView {
  post: PostView | null;
  comments: CommentView[];
  loaded: boolean;
}

test(
  'real native → normal AppModule → PostgreSQL canonical community runtime contract',
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
      'Require loopback',
    );
    assert.equal(
      url.pathname,
      '/whaleu_test',
      'Require the dedicated disposable database',
    );
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: connectionString,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '4',
      PG_CONNECTION_TIMEOUT_MS: '2000',
      PG_STATEMENT_TIMEOUT_MS: '10000',
    });
    const pool = new Pool(poolOptions(config));
    let suite: PoolClient | undefined, app: INestApplication | undefined;
    let locked = false,
      ownsSchemas = false;
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
        'Another suite owns this disposable database; run serially',
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
        'Refuse existing application or fixture schemas',
      );
      ownsSchemas = true;
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
      await app.listen(0, '127.0.0.1');
      const transport = new NodeHttpTransport(
        Number(new URL(await app.getUrl()).port),
      );
      const cancel = new Cancellation();
      const makeClient = async (saved?: SessionCredentials) => {
        const credentials = saved ?? (await createRuntimeActor(app!));
        const sessions = new SessionStore();
        sessions.completeLogin(sessions.beginLogin(), credentials);
        const auth = new AuthService(
          sessions,
          new HttpAuthGateway(nativeOrigin, transport, systemClock),
          { login: async () => 'no-real-provider-configured' },
          systemClock,
        );
        const api = new ApiClient(nativeOrigin, transport, sessions, auth);
        return {
          credentials,
          sessions,
          auth,
          api,
          community: new HttpCommunityGateway(api),
          blocks: new HttpBlockGateway(api),
          reports: new HttpReportGateway(api),
        };
      };
      type Actor = Awaited<ReturnType<typeof makeClient>>;
      const privateIds = new Set<string>();
      transport.checkResponse = (path, _status, body) => {
        if (
          path.startsWith('/v1/community/') ||
          path.startsWith('/v1/me/community/') ||
          path.startsWith('/v1/me/safety/')
        ) {
          noPrivateFields(body);
          const serialized = JSON.stringify(body);
          for (const value of privateIds)
            assert.ok(
              !serialized.includes(value),
              'Internal canonical fact ID leaked over HTTP',
            );
        }
      };
      const author = await makeClient(),
        peer = await makeClient(),
        phoneOnly = await makeClient(),
        reader = await makeClient();
      await t.test(
        'startup and owner session creation fabricate no proof, policy, approval or grants; real login remains disabled',
        async () => {
          for (const table of [
            'whaleu_authorization.role_grants',
            'whaleu_verification.assertions',
            'whaleu_campus.community_topology_snapshots',
            'whaleu_campus.community_identity_selections',
            'whaleu_community.region_policy_revisions',
            'whaleu_community.content_approval_decisions',
          ]) {
            assert.equal(
              (
                await pool.query(
                  `SELECT count(*)::integer AS count FROM ${table}`,
                )
              ).rows[0].count,
              0,
              table,
            );
          }
          const stored = await pool.query(
            'SELECT token_hash FROM whaleu_identity.access_tokens WHERE session_id=$1',
            [author.credentials.sessionId],
          );
          assert.equal(
            stored.rows[0].token_hash,
            hashToken(author.credentials.accessToken),
          );
          assert.notEqual(
            stored.rows[0].token_hash,
            author.credentials.accessToken,
          );
          const gateway = new HttpAuthGateway(
            nativeOrigin,
            transport,
            systemClock,
          );
          await assert.rejects(
            gateway.login('synthetic-disabled'),
            clientFailure('http', 503, 'AUTH_NOT_CONFIGURED'),
          );
        },
      );
      const scope = await seedCommunityScope(pool);
      privateIds.add(scope.topologySnapshotId);
      for (const id of [
        scope.institutionId,
        scope.home.campusId,
        scope.related.campusId,
        scope.foreign.campusId,
      ])
        privateIds.add(id);
      const verify = async (
        actor: Actor,
        origin = scope.home,
        affiliation: 'verified' | 'unverified' | 'unavailable' = 'verified',
        phone: 'verified' | 'unverified' | 'unavailable' = 'verified',
        selection = true,
      ) => {
        privateIds.add(actor.credentials.accountId);
        const facts = await setRuntimeVerification(
          pool,
          actor.credentials.accountId,
          scope.institutionId,
          origin.regionId,
          affiliation,
          phone,
        );
        privateIds.add(facts.assertionId);
        privateIds.add(facts.snapshotId);
        if (affiliation === 'verified' && selection)
          privateIds.add(
            await appendIdentitySelection(
              pool,
              actor.credentials.accountId,
              facts,
              scope,
              origin.campusId,
            ),
          );
        return facts;
      };
      await verify(author);
      await verify(peer);
      await verify(phoneOnly, scope.home, 'unavailable');
      await verify(reader, scope.home, 'unavailable', 'unverified');
      await seedReviewPolicy(pool);
      const postIntent = (
        text: string,
        spaceId = scope.home.spaceId,
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
      const commentIntent = (
        text: string,
        authorMode: 'named' | 'anonymous' = 'named',
      ): PublishComment => ({
        clientRequestId: randomUUID(),
        text,
        imageAssetIds: [],
        authorMode,
      });
      const approvePost = async (
        actor: Actor,
        body: PublishPost,
        options: Parameters<typeof approveEnvelope>[2] = {},
      ) => {
        const approval = await approveEnvelope(
          pool,
          await postApprovalEnvelope(
            app!,
            pool,
            actor.credentials.accountId,
            body,
          ),
          options,
        );
        privateIds.add(approval.decisionId);
        return approval;
      };
      const publish = async (
        actor: Actor,
        body: PublishPost,
        options: Parameters<typeof approveEnvelope>[2] = {},
      ) => {
        const approval = await approvePost(actor, body, options);
        return {
          intent: body,
          approval,
          receipt: created(await actor.community.publishPost(body, cancel)),
        };
      };
      const approveComment = async (
        actor: Actor,
        postId: string,
        body: PublishComment | PublishReply,
        rootId: string | null = null,
      ) => {
        const approval = await approveEnvelope(
          pool,
          await discussionApprovalEnvelope(
            app!,
            pool,
            actor.credentials.accountId,
            postId,
            body,
            rootId,
          ),
        );
        privateIds.add(approval.decisionId);
        return approval;
      };
      const runtimeFor = (actor: Actor) =>
        createCommunityRuntime(
          actor,
          platformStorage(),
          nativeOrigin,
          systemClock,
        );
      let named!: Awaited<ReturnType<typeof publish>>,
        anonymous!: Awaited<ReturnType<typeof publish>>,
        foreign!: Awaited<ReturnType<typeof publish>>;
      let root!: Extract<PublicationReceipt, { outcome: 'created' }>,
        reply!: Extract<PublicationReceipt, { outcome: 'created' }>;

      await t.test(
        'affiliation without student number has eligible identity modes, but native composer stays unavailable without review issuance',
        async () => {
          const capability = await author.community.capabilities(
            scope.home.spaceId,
            'discussion',
            cancel,
          );
          assert.equal(capability.publish.availability, 'unavailable');
          assert.equal(capability.publish.reason, 'CONTENT_REVIEW_UNAVAILABLE');
          assert.deepEqual(capability.authorModes, ['named', 'anonymous']);
          let view: ComposeView = initialComposeView();
          const controller = new ComposeController(
            runtimeFor(author),
            {
              operation: 'publish_post',
              spaceId: scope.home.spaceId,
              category: 'discussion',
            },
            (next: ComposeView) => {
              view = next;
            },
          );
          await controller.load();
          controller.setText('Synthetic composer cannot issue an approval');
          assert.equal(view.loaded, true);
          assert.equal(view.canSubmit, false);
          assert.match(view.blocker, /审核/);
          const before = transport.exchanges.filter(
            (x) => x.method === 'POST' && x.path === '/v1/community/posts',
          ).length;
          await controller.submit();
          assert.equal(
            transport.exchanges.filter(
              (x) => x.method === 'POST' && x.path === '/v1/community/posts',
            ).length,
            before,
          );
          controller.dispose();
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::integer AS count FROM whaleu_verification.assertions WHERE fact_kind='student_number'",
              )
            ).rows[0].count,
            0,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer AS count FROM whaleu_community.region_policy_revisions',
              )
            ).rows[0].count,
            0,
            'Verified publication does not need unrelated unverified-channel configuration',
          );
        },
      );

      await t.test(
        'missing exact review remains unavailable and does not create a durable rejection; actor, scope, mode and text cannot reuse approval',
        async () => {
          const intent = postIntent('Exact native text 🐳');
          await assert.rejects(
            author.community.publishPost(intent, cancel),
            clientFailure('http', 503, 'CONTENT_REVIEW_UNAVAILABLE'),
          );
          await assert.rejects(
            author.community.receipt(intent.clientRequestId, cancel),
            clientFailure('http', 404, 'REQUEST_NOT_FOUND'),
          );
          await approvePost(author, intent);
          for (const [actor, changed] of [
            [peer, { ...intent, clientRequestId: randomUUID() }],
            [
              author,
              {
                ...intent,
                clientRequestId: randomUUID(),
                spaceId: scope.related.spaceId,
              },
            ],
            [
              author,
              {
                ...intent,
                clientRequestId: randomUUID(),
                authorMode: 'anonymous',
              },
            ],
            [
              author,
              {
                ...intent,
                clientRequestId: randomUUID(),
                text: intent.text + ' changed',
              },
            ],
          ] as const)
            await assert.rejects(
              actor.community.publishPost(changed, cancel),
              clientFailure('http', 503, 'CONTENT_REVIEW_UNAVAILABLE'),
            );
          transport.dropSuccess = {
            path: '/v1/community/posts',
            method: 'POST',
          };
          await assert.rejects(
            author.community.publishPost(intent, cancel),
            (error: unknown) =>
              error instanceof ClientError &&
              (error as { kind: string }).kind === 'network',
          );
          const receipt = created(
            await author.community.receipt(intent.clientRequestId, cancel),
          );
          assert.deepEqual(
            await author.community.publishPost(intent, cancel),
            receipt,
          );
          await assert.rejects(
            author.community.publishPost(
              { ...intent, text: 'Conflicting retry' },
              cancel,
            ),
            clientFailure('business', 409, 'REQUEST_CONFLICT'),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer AS count FROM whaleu_community.content_approval_bindings WHERE content_id=$1',
                [receipt.resourceId],
              )
            ).rows[0].count,
            1,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer AS count FROM whaleu_community.outbox WHERE resource_id=$1',
                [receipt.resourceId],
              )
            ).rows[0].count,
            1,
          );
        },
      );

      await t.test(
        'canonical home and related anonymous posts succeed, foreign posts are named only, and browsing supplies no identity authority',
        async () => {
          named = await publish(
            author,
            postIntent('Native canonical named post'),
          );
          anonymous = await publish(
            author,
            postIntent(
              'Native canonical anonymous post',
              scope.home.spaceId,
              'anonymous',
            ),
          );
          const related = await publish(
            author,
            postIntent(
              'Native related anonymous post',
              scope.related.spaceId,
              'anonymous',
            ),
          );
          foreign = await publish(
            author,
            postIntent('Native foreign named post', scope.foreign.spaceId),
          );
          assert.equal(
            (await reader.community.post(related.receipt.resourceId, cancel))
              .author.kind,
            'anonymous',
          );
          rejected(
            await author.community.publishPost(
              postIntent(
                'Foreign anonymous denied',
                scope.foreign.spaceId,
                'anonymous',
              ),
              cancel,
            ),
            'AUTHOR_MODE_NOT_ALLOWED',
          );
          assert.equal(
            (await author.community.spaces(scope.foreign.campusId, cancel))
              .regional.id,
            scope.foreign.spaceId,
          );
          rejected(
            await author.community.publishPost(
              postIntent(
                'Browse campus cannot change identity',
                scope.foreign.spaceId,
                'anonymous',
              ),
              cancel,
            ),
            'AUTHOR_MODE_NOT_ALLOWED',
          );
          const unsigned = await makeClient();
          await verify(unsigned, scope.home, 'verified', 'verified', false);
          await unsigned.community.spaces(scope.home.campusId, cancel);
          const unknown = await unsigned.community.capabilities(
            scope.home.spaceId,
            'discussion',
            cancel,
          );
          assert.equal(unknown.publish.availability, 'unavailable');
          await assert.rejects(
            unsigned.community.publishPost(
              postIntent('Unknown identity selection'),
              cancel,
            ),
            clientFailure('http', 503, 'COMMUNITY_UNAVAILABLE'),
          );
          const post: PostView = await reader.community.post(
            anonymous.receipt.resourceId,
            cancel,
          );
          assert.ok(Object.isFrozen(post));
          assert.ok(Object.isFrozen(post.author));
          assert.deepEqual(Object.keys(post.author).sort(), [
            'avatar',
            'displayName',
            'isPostAuthor',
            'kind',
            'personaId',
          ]);
          assert.equal(post.viewer.isSelf, false);
          const readOnlyFeed = await reader.community.feed(
            { spaceId: scope.foreign.spaceId },
            cancel,
          );
          assert.ok(
            readOnlyFeed.items.some(
              (item: PostView) => item.id === foreign.receipt.resourceId,
            ),
          );
          rejected(
            await reader.community.publishPost(
              postIntent('Reading is not membership'),
              cancel,
            ),
            'PHONE_VERIFICATION_REQUIRED',
          );
        },
      );

      await t.test(
        'exact root/reply ancestry and effective anonymity cross native HTTP without leaking owner facts',
        async () => {
          const body = commentIntent('Foreign anonymous root', 'anonymous');
          await approveComment(peer, foreign.receipt.resourceId, body);
          await assert.rejects(
            peer.community.publishComment(
              named.receipt.resourceId,
              { ...body, clientRequestId: randomUUID() },
              cancel,
            ),
            clientFailure('http', 503, 'CONTENT_REVIEW_UNAVAILABLE'),
          );
          root = created(
            await peer.community.publishComment(
              foreign.receipt.resourceId,
              body,
              cancel,
            ),
          );
          const replyBody: PublishReply = {
            ...commentIntent('Foreign anonymous reply', 'anonymous'),
            targetReplyId: null,
          };
          await approveComment(
            author,
            foreign.receipt.resourceId,
            replyBody,
            root.resourceId,
          );
          reply = created(
            await author.community.publishReply(
              root.resourceId,
              replyBody,
              cancel,
            ),
          );
          assert.equal(
            (await reader.community.comment(root.resourceId, cancel)).author
              .kind,
            'anonymous',
          );
          assert.equal(
            (await reader.community.reply(reply.resourceId, cancel)).author
              .kind,
            'anonymous',
          );
          const forced = commentIntent(
            'Own anonymous post forces mode',
            'named',
          );
          await approveComment(author, anonymous.receipt.resourceId, forced);
          const ownRoot = created(
            await author.community.publishComment(
              anonymous.receipt.resourceId,
              forced,
              cancel,
            ),
          );
          const ownView = await author.community.comment(
            ownRoot.resourceId,
            cancel,
          );
          assert.equal(ownView.author.kind, 'anonymous');
          assert.equal(ownView.author.isPostAuthor, true);
          assert.equal(
            (
              await reader.community.comments(
                foreign.receipt.resourceId,
                null,
                cancel,
              )
            ).items[0].replyPreview.items[0].id,
            reply.resourceId,
          );
          await assert.rejects(
            reader.community.comment(named.receipt.resourceId, cancel),
            clientFailure('http', 404, 'COMMENT_NOT_FOUND'),
          );
          await assert.rejects(
            reader.community.reply(root.resourceId, cancel),
            clientFailure('http', 404, 'REPLY_NOT_FOUND'),
          );
        },
      );

      await t.test(
        'phone-only actor with unknown affiliation can read, like, save, set updates and vote while publication remains unavailable',
        async () => {
          await assert.rejects(
            phoneOnly.community.publishPost(
              postIntent('Unknown affiliation is not unverified'),
              cancel,
            ),
            clientFailure('http', 503, 'COMMUNITY_UNAVAILABLE'),
          );
          assert.equal(
            (
              await phoneOnly.community.like(
                {
                  requestId: randomUUID(),
                  operation: 'set_post_like',
                  postId: named.receipt.resourceId,
                  liked: true,
                },
                cancel,
              )
            ).outcome,
            'applied',
          );
          assert.equal(
            (await phoneOnly.community.post(named.receipt.resourceId, cancel))
              .viewer.isLiked,
            true,
          );
          assert.equal(
            (
              await phoneOnly.community.discussionLike(
                'reply',
                reply.resourceId,
                true,
                randomUUID(),
                cancel,
              )
            ).outcome,
            'applied',
          );
          const saved = {
            clientRequestId: randomUUID(),
            operation: 'set_post_saved',
            postId: named.receipt.resourceId,
            desired: true,
            channel: null,
          };
          assert.equal(
            (await phoneOnly.community.applySaved(saved, cancel)).outcome,
            'applied',
          );
          assert.equal(
            (await phoneOnly.community.saved(null, cancel)).items[0].post.id,
            named.receipt.resourceId,
          );
          assert.equal(
            (
              await phoneOnly.community.applySaved(
                {
                  ...saved,
                  clientRequestId: randomUUID(),
                  operation: 'set_post_update_preference',
                  channel: 'saved',
                },
                cancel,
              )
            ).outcome,
            'applied',
          );
          const poll = await publish(author, {
            ...postIntent('Native poll canonical content'),
            component: {
              kind: 'poll',
              question: 'Which synthetic option?',
              options: ['One', 'Two'],
              selectionMode: 'single',
            },
          });
          const view = await phoneOnly.community.poll(
            poll.receipt.resourceId,
            cancel,
          );
          assert.equal(view.viewer.canVote, true);
          const ballot = await phoneOnly.community.castBallot(
            poll.receipt.resourceId,
            { clientRequestId: randomUUID(), optionIds: [view.options[0].id] },
            cancel,
          );
          assert.equal(ballot.outcome, 'created');
          assert.equal(
            (await phoneOnly.community.poll(poll.receipt.resourceId, cancel))
              .voterCount,
            1,
          );
          const changed = {
            ...postIntent('Exact poll option order'),
            component: {
              kind: 'poll' as const,
              question: 'Ordered?',
              options: ['First', 'Second'],
              selectionMode: 'single' as const,
            },
          };
          await approvePost(author, changed);
          await assert.rejects(
            author.community.publishPost(
              {
                ...changed,
                component: {
                  ...changed.component,
                  options: ['Second', 'First'],
                },
              },
              cancel,
            ),
            clientFailure('http', 503, 'CONTENT_REVIEW_UNAVAILABLE'),
          );
        },
      );

      await t.test(
        'known unverified policy differs from missing affiliation and missing configuration',
        async () => {
          const unverified = await makeClient();
          await verify(unverified, scope.home, 'unverified');
          await assert.rejects(
            unverified.community.publishPost(
              postIntent('Missing regional switch'),
              cancel,
            ),
            clientFailure('http', 503, 'COMMUNITY_UNAVAILABLE'),
          );
          await setRegionPolicy(pool, scope.home.regionId, {
            unverifiedPostEnabled: false,
            unverifiedCategories: ['discussion'],
          });
          rejected(
            await unverified.community.publishPost(
              postIntent('Explicit off'),
              cancel,
            ),
            'STUDENT_VERIFICATION_REQUIRED',
          );
          await setRegionPolicy(pool, scope.home.regionId, {
            unverifiedPostEnabled: true,
            unverifiedCommentEnabled: true,
          });
          await publish(
            unverified,
            postIntent('Known unverified configured named publication'),
          );
          rejected(
            await unverified.community.publishPost(
              postIntent(
                'Known unverified anonymous',
                scope.home.spaceId,
                'anonymous',
              ),
              cancel,
            ),
            'AUTHOR_MODE_NOT_ALLOWED',
          );
          rejected(
            await unverified.community.publishComment(
              anonymous.receipt.resourceId,
              commentIntent('Unverified needs named parent'),
              cancel,
            ),
            'AUTHOR_MODE_NOT_ALLOWED',
          );
          await assert.rejects(
            phoneOnly.community.publishPost(
              postIntent('Missing affiliation still unavailable'),
              cancel,
            ),
            clientFailure('http', 503, 'COMMUNITY_UNAVAILABLE'),
          );
        },
      );

      await t.test(
        'guest preview stops at ten while phone-only affiliation-unknown actor can continue the feed',
        async () => {
          for (let i = 0; i < 10; i++)
            await publish(
              author,
              postIntent(
                'Synthetic continuation post ' + i,
                scope.related.spaceId,
              ),
            );
          const guest = await makeClient();
          guest.sessions.logout();
          const preview = await guest.community.feed(
            { spaceId: scope.related.spaceId },
            cancel,
          );
          assert.equal(preview.items.length, 10);
          assert.equal(preview.continuation, 'login_required');
          assert.equal(preview.nextCursor, null);
          assert.equal(transport.exchanges.at(-1)?.authorized, false);
          const first = await phoneOnly.community.feed(
            { spaceId: scope.related.spaceId },
            cancel,
          );
          assert.equal(first.items.length, 10);
          assert.equal(first.continuation, 'available');
          assert.ok(first.nextCursor);
          const next = await phoneOnly.community.feed(
            { spaceId: scope.related.spaceId, cursor: first.nextCursor },
            cancel,
          );
          assert.equal(next.items.length, 1);
          assert.equal(next.continuation, 'end');
          const ids = new Set(first.items.map((item: PostView) => item.id));
          assert.ok(next.items.every((item: PostView) => !ids.has(item.id)));
          await assert.rejects(
            reader.community.feed(
              { spaceId: scope.related.spaceId, cursor: first.nextCursor },
              cancel,
            ),
            clientFailure(
              'phone-verification-required',
              403,
              'PHONE_VERIFICATION_REQUIRED',
            ),
          );
          await assert.rejects(
            guest.community.feed(
              { spaceId: scope.related.spaceId, cursor: first.nextCursor },
              cancel,
            ),
            clientFailure('auth-required', 401, 'AUTHENTICATION_REQUIRED'),
          );
        },
      );

      await t.test(
        'media and client-supplied policy/proof claims never create authority',
        async () => {
          const image = {
            ...postIntent('Unavailable image'),
            imageAssetIds: [randomUUID()],
          };
          await approvePost(author, { ...image, imageAssetIds: [] });
          await assert.rejects(
            author.community.publishPost(image, cancel),
            clientFailure('http', 503, 'MEDIA_UNAVAILABLE'),
          );
          for (const extra of [
            { approvalDecisionId: randomUUID() },
            { identityCampusId: scope.home.campusId },
            { studentVerified: true },
            { relatedSync: true },
          ]) {
            const response = await transport.send({
              url: nativeOrigin + '/v1/community/posts',
              method: 'POST',
              headers: {
                Authorization: 'Bearer ' + author.credentials.accessToken,
                'content-type': 'application/json',
              },
              body: { ...postIntent('No public policy claims'), ...extra },
              timeoutMs: 10000,
            });
            assert.equal(response.status, 400);
          }
          transport.corruptNext = {
            path: '/v1/community/posts/' + named.receipt.resourceId,
            extra: { approvalDecisionId: randomUUID() },
          };
          await assert.rejects(
            reader.community.post(named.receipt.resourceId, cancel),
            (error: unknown) =>
              error instanceof ClientError &&
              (error as { kind: string }).kind === 'protocol',
          );
        },
      );

      await t.test(
        'normal named-block wrapper filters named content while anonymous owner remains noninterfering',
        async () => {
          const blocked = await phoneOnly.blocks.apply(
            {
              clientRequestId: randomUUID(),
              operation: 'block_named',
              source: { kind: 'post', id: named.receipt.resourceId },
              blocked: true,
            },
            cancel,
          );
          assert.equal(blocked.receipt.outcome, 'applied');
          await assert.rejects(
            phoneOnly.community.post(named.receipt.resourceId, cancel),
            clientFailure('http', 404, 'POST_BLOCKED_BY_YOU'),
          );
          assert.equal(
            (
              await phoneOnly.community.post(
                anonymous.receipt.resourceId,
                cancel,
              )
            ).id,
            anonymous.receipt.resourceId,
          );
          assert.equal(
            (
              await phoneOnly.community.like(
                {
                  requestId: randomUUID(),
                  operation: 'set_post_like',
                  postId: anonymous.receipt.resourceId,
                  liked: true,
                },
                cancel,
              )
            ).outcome,
            'applied',
          );
          assert.equal(
            (
              await phoneOnly.community.post(
                anonymous.receipt.resourceId,
                cancel,
              )
            ).viewer.isLiked,
            true,
          );
          const feed = await phoneOnly.community.feed(
            { spaceId: scope.home.spaceId },
            cancel,
          );
          assert.ok(
            !feed.items.some(
              (item: PostView) => item.id === named.receipt.resourceId,
            ),
          );
          assert.ok(
            feed.items.some(
              (item: PostView) => item.id === anonymous.receipt.resourceId,
            ),
          );
          assert.equal(
            (await phoneOnly.community.saved(null, cancel)).items.length,
            0,
          );
          const noTarget = await phoneOnly.blocks.apply(
            {
              clientRequestId: randomUUID(),
              operation: 'block_named',
              source: { kind: 'post', id: anonymous.receipt.resourceId },
              blocked: true,
            },
            cancel,
          );
          assert.equal(noTarget.receipt.code, 'BLOCK_TARGET_NOT_ALLOWED');
          await phoneOnly.blocks.apply(
            {
              clientRequestId: randomUUID(),
              operation: 'unblock_named',
              relationshipId: blocked.current.relationshipId,
              expectedRevision: blocked.current.revision,
              blocked: false,
            },
            cancel,
          );
          assert.equal(
            (await phoneOnly.community.post(named.receipt.resourceId, cancel))
              .id,
            named.receipt.resourceId,
          );
        },
      );

      await t.test(
        'one-use consume deadline does not expire approved visibility, and current held/revoked state controls all native reads',
        async () => {
          const consumeUntil = new Date(Date.now() + 1500);
          const bounded = await publish(
            author,
            postIntent('Durable after consume deadline'),
            { consumeUntil },
          );
          await pool.query(
            'SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp())))+0.02)',
            [consumeUntil],
          );
          assert.equal(
            (await reader.community.post(bounded.receipt.resourceId, cancel))
              .text,
            bounded.intent.text,
          );
          await assert.rejects(
            author.community.publishPost(
              { ...bounded.intent, clientRequestId: randomUUID() },
              cancel,
            ),
            clientFailure('http', 503, 'CONTENT_REVIEW_UNAVAILABLE'),
          );
          await setReviewState(pool, bounded.approval.decisionId, 'held');
          await assert.rejects(
            reader.community.post(bounded.receipt.resourceId, cancel),
            clientFailure('http', 404, 'POST_NOT_FOUND'),
          );
          assert.deepEqual(
            await author.community.receipt(
              bounded.intent.clientRequestId,
              cancel,
            ),
            bounded.receipt,
          );
          await setReviewState(pool, bounded.approval.decisionId, 'allow');
          assert.equal(
            (await reader.community.post(bounded.receipt.resourceId, cancel))
              .id,
            bounded.receipt.resourceId,
          );
          await setReviewState(pool, bounded.approval.decisionId, 'revoked');
          const deniedLikeIntent = {
            requestId: randomUUID(),
            operation: 'set_post_like' as const,
            postId: bounded.receipt.resourceId,
            liked: true,
          };
          assert.deepEqual(
            await phoneOnly.community.like(deniedLikeIntent, cancel),
            {
              ...deniedLikeIntent,
              outcome: 'rejected',
              code: 'POST_NOT_FOUND',
            },
          );
          assert.deepEqual(
            await author.community.publishPost(bounded.intent, cancel),
            bounded.receipt,
          );
        },
      );

      await t.test(
        'normal report eligibility and bound native origin remove discussion after ten distinct reports without privileged grants',
        async () => {
          const target = commentIntent(
            'Native reviewed discussion removal target',
          );
          await approveComment(author, named.receipt.resourceId, target);
          const victim = created(
            await author.community.publishComment(
              named.receipt.resourceId,
              target,
              cancel,
            ),
          );
          let first: unknown;
          for (let i = 0; i < 10; i++) {
            const reporter = await makeClient();
            await verify(reporter, scope.home, 'verified', 'verified', false);
            const receipt = await reporter.reports.apply(
              {
                clientRequestId: randomUUID(),
                operation: 'report',
                target: { kind: 'comment', id: victim.resourceId },
              },
              cancel,
            );
            assert.equal(receipt.outcome, 'accepted');
            if (i === 0) first = receipt;
          }
          assert.ok(first);
          await assert.rejects(
            reader.community.comment(victim.resourceId, cancel),
            clientFailure('http', 404, 'COMMENT_NOT_FOUND'),
          );
          assert.deepEqual(
            await author.community.receipt(target.clientRequestId, cancel),
            victim,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer AS count FROM whaleu_authorization.role_grants',
              )
            ).rows[0].count,
            0,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::integer AS count FROM whaleu_safety.report_decisions d JOIN whaleu_safety.report_cases c ON c.id=d.case_id WHERE c.target_id=$1 AND d.outcome='removed'",
                [victim.resourceId],
              )
            ).rows[0].count,
            1,
          );
        },
      );

      await t.test(
        'native detail clears on account switch, logout and stale real HTTP callbacks; server rechecks active sessions',
        async () => {
          const lifecycle = await makeClient();
          await verify(lifecycle, scope.home, 'unavailable');
          const runtime = runtimeFor(lifecycle);
          let view: DetailView = initialDetailView();
          const detail = new DetailController(
            runtime,
            named.receipt.resourceId,
            (next: DetailView) => {
              view = next;
            },
          );
          await detail.load();
          assert.equal((view as DetailView).post?.id, named.receipt.resourceId);
          const held = transport.holdNext(
            '/v1/community/posts/' + named.receipt.resourceId,
          );
          const loading = detail.load();
          await held.arrived;
          lifecycle.sessions.completeLogin(
            lifecycle.sessions.beginLogin(),
            reader.credentials,
          );
          held.release();
          await loading;
          assert.equal(view.post, null);
          assert.deepEqual(view.comments, []);
          assert.equal(view.loaded, false);
          await detail.load();
          assert.equal((view as DetailView).post?.id, named.receipt.resourceId);
          lifecycle.sessions.logout();
          assert.equal(view.post, null);
          assert.deepEqual(view.comments, []);
          detail.dispose();
          const revoked = await makeClient();
          await assert.rejects(
            revoked.auth.logout(),
            clientFailure('http', 503, 'AUTH_NOT_CONFIGURED'),
          );
          assert.equal(revoked.sessions.snapshot().credentials, null);
          // Exercise the actual owner lifecycle facade for server-side revocation.
          // Provider setup remains genuinely unavailable, including its rate limiter.
          await app!
            .get(IdentityRepository)
            .revoke(hashToken(revoked.credentials.accessToken));
          const stale = await makeClient(revoked.credentials);
          await assert.rejects(
            stale.community.post(named.receipt.resourceId, cancel),
            clientFailure('auth-required', 401, 'SESSION_REVOKED'),
          );
          const blocked = await makeClient();
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
              [blocked.credentials.accountId],
            ),
          );
          await assert.rejects(
            blocked.community.post(named.receipt.resourceId, cancel),
            clientFailure('forbidden', 403, 'ACCOUNT_BLOCKED'),
          );
        },
      );

      await t.test(
        'minimal successful receipt survives later affiliation loss and content removal without recreating payload',
        async () => {
          await verify(author, scope.home, 'unavailable');
          await author.community.deletePost(named.receipt.resourceId, cancel);
          const original = await author.community.receipt(
            named.intent.clientRequestId,
            cancel,
          );
          assert.deepEqual(original, named.receipt);
          assert.deepEqual(
            await author.community.publishPost(named.intent, cancel),
            named.receipt,
          );
          await assert.rejects(
            reader.community.post(named.receipt.resourceId, cancel),
            clientFailure('http', 404, 'POST_NOT_FOUND'),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer AS count FROM whaleu_community.posts WHERE id=$1 AND deleted_at IS NULL',
                [named.receipt.resourceId],
              )
            ).rows[0].count,
            0,
          );
        },
      );

      await t.test(
        'legacy approved rows and wrong-kind UUID collisions never borrow a bound approval',
        async () => {
          // Preserve a synthetic historical row, including origin-like metadata. It
          // deliberately has no approval binding; its existence is not review proof.
          const legacy = randomUUID();
          await withCommunityScopeWriter(pool, async (tx) => {
            await tx.query(
              "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'discussion','Synthetic unreviewed history','named','open')",
              [legacy, scope.foreign.spaceId, peer.credentials.accountId],
            );
            await tx.query(
              "INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode) VALUES($1,$2,$3,'Same UUID in a different content kind','named')",
              [
                anonymous.receipt.resourceId,
                foreign.receipt.resourceId,
                peer.credentials.accountId,
              ],
            );
          });
          await assert.rejects(
            reader.community.post(legacy, cancel),
            clientFailure('http', 503, 'COMMUNITY_UNAVAILABLE'),
          );
          await assert.rejects(
            reader.community.comment(anonymous.receipt.resourceId, cancel),
            clientFailure('http', 503, 'COMMUNITY_UNAVAILABLE'),
          );
          assert.equal(
            (await reader.community.post(anonymous.receipt.resourceId, cancel))
              .id,
            anonymous.receipt.resourceId,
          );
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::integer AS count FROM whaleu_community.content_approval_bindings WHERE content_kind='comment' AND content_id=$1",
                [anonymous.receipt.resourceId],
              )
            ).rows[0].count,
            0,
          );
          assert.ok(
            transport.exchanges.some(
              (exchange) => exchange.authorized && exchange.status === 201,
            ),
          );
        },
      );
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
