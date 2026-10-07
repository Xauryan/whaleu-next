import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
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
  COMMUNITY_BASE_VISIBILITY,
  CONTENT_PUBLICATION_GATE,
  MEDIA_ATTACHMENT,
} from '../../src/community/community-policy.js';
import { publishPostSchema } from '../../src/community/contracts.js';
import type {
  PublishPost,
  PublicationReceipt,
  PostView,
  CommentView,
} from '../../src/community/contracts.js';
import type { PublishReply } from '../../src/community/discussion/contracts.js';
import type {
  BlockResult,
  OwnBlock,
  OwnBlocksPage,
} from '../../src/safety/contracts.js';
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
import {
  FixtureAuthorization,
  FixtureVisibility,
  FixtureContent,
  FixtureMedia,
  approve,
  approvePoll,
  approveReply,
  fixtureSchema,
  grant,
  verified,
} from '../support/community-fixtures.js';
import {
  setSyntheticSnapshot,
  syntheticAssertion,
} from '../support/verification-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

// The real native gateways/decoders/controllers connect over an actual HTTP
// socket to Nest and real PostgreSQL. Only platform I/O, provider exchange and
// unavailable community authorities are explicitly synthetic fixtures. This is
// NOT a claim that runtime publication/base visibility policy is complete.
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
  createCommunityRuntime,
} = require('../../../wechat/src/community/runtime.ts');
const {
  BlockMutationController,
  initialBlockMutationView,
} = require('../../../wechat/src/community/block-controller.ts');
const {
  BlocksController,
  initialBlocksView,
} = require('../../../wechat/src/pages/community-blocks/controller.ts');
const {
  DetailController,
  initialDetailView,
} = require('../../../wechat/src/pages/community-detail/controller.ts');
const {
  TradingContactsController,
  initialTradingContactsView,
} = require('../../../wechat/src/community/trading-controller.ts');
const {
  FormationContactsController,
  initialFormationContactsView,
} = require('../../../wechat/src/community/formation-controller.ts');
const {
  IdentityOverlayController,
  initialOverlayView,
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
  dropSuccess: { path: string; method: string } | null = null;
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
              const result = raw === '' ? '' : JSON.parse(raw);
              this.checkResponse?.(url.pathname, status, result);
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
  let failRemoval = false;
  return {
    getStorageSync: (key: string) => structuredClone(values.get(key)),
    setStorageSync: (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    },
    removeStorageSync: (key: string) => {
      if (failRemoval) throw new Error('Synthetic journal cleanup failure');
      values.delete(key);
    },
    setRemoveFailure: (value: boolean) => {
      failRemoval = value;
    },
    getRandomValues: (input: {
      length: number;
      success(value: { randomValues: ArrayBuffer }): void;
    }) => {
      const bytes = Uint8Array.from(randomBytes(input.length));
      input.success({ randomValues: bytes.buffer });
    },
  };
}
function applied(
  result: BlockResult,
  blocked: boolean,
): Extract<BlockResult['receipt'], { outcome: 'applied' }> {
  assert.equal(result.receipt.outcome, 'applied', JSON.stringify(result));
  assert.ok(result.receipt.outcome === 'applied');
  assert.equal(result.receipt.blocked, blocked);
  assert.ok(result.current);
  assert.ok(
    Object.isFrozen(result) &&
      Object.isFrozen(result.receipt) &&
      Object.isFrozen(result.current),
    'Actual native exact decoders ran',
  );
  return result.receipt;
}
function rejected(result: BlockResult, code: string): void {
  assert.deepEqual(result, {
    receipt: {
      requestId: result.receipt.requestId,
      operation: result.receipt.operation,
      outcome: 'rejected',
      code,
    },
    current: null,
  });
}
function created(receipt: PublicationReceipt): string {
  assert.equal(receipt.outcome, 'created', JSON.stringify(receipt));
  assert.ok(receipt.outcome === 'created');
  return receipt.resourceId;
}
function noPrivateSafetyData(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(
      ![
        'accountId',
        'account_id',
        'blocker_id',
        'blocked_id',
        'namedAccountId',
        'incoming',
        'incomingBlocks',
        'targetAccountId',
        'source',
        'sourceId',
        'source_kind',
        'source_id',
        'contacts',
        'phone',
        'studentNumber',
        'sessionId',
        'token',
      ].includes(key),
      `Private field in safety DTO: ${key}`,
    );
    noPrivateSafetyData(child);
  }
}
async function eventually(check: () => boolean): Promise<void> {
  const end = Date.now() + 3000;
  while (!check() && Date.now() < end)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), 'Expected current owner read to settle');
}

test(
  'real named-block native gateway, controllers, Nest HTTP and PostgreSQL contract',
  { timeout: 90000 },
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
      'Use dedicated disposable whaleu_test',
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
      WECHAT_APP_SECRET: 'synthetic-local-block-contract-only',
      AUTH_RATE_LIMIT_KEY: 'bd'.repeat(32),
    });
    const pool = new Pool(poolOptions(config));
    let suite: PoolClient | undefined, app: INestApplication | undefined;
    let locked = false,
      ownsSchemas = false,
      providerExchanges = 0;
    const visibility = new FixtureVisibility();
    const startApp = async (
      port = 0,
      syntheticBase = true,
    ): Promise<INestApplication> => {
      let builder = Test.createTestingModule({
        imports: [AppModule.register(config)],
      })
        .overrideProvider(IDENTITY_PROVIDER)
        .useValue({
          exchange: async (code: string) => {
            providerExchanges++;
            return {
              provider: 'wechat',
              appId: 'synthetic-native-blocks',
              subject: code,
            };
          },
        })
        .overrideProvider(COMMUNITY_AUTHORIZATION)
        .useValue(new FixtureAuthorization())
        .overrideProvider(CONTENT_PUBLICATION_GATE)
        .useValue(new FixtureContent())
        .overrideProvider(MEDIA_ATTACHMENT)
        .useValue(new FixtureMedia());
      // Never override COMMUNITY_VISIBILITY: exercise the actual local safety adapter.
      if (syntheticBase)
        builder = builder
          .overrideProvider(COMMUNITY_BASE_VISIBILITY)
          .useValue(visibility);
      const module = await builder.compile();
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
        'Another suite owns this database; run serially',
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
        'SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname=ANY($1::text[])',
        [['whaleu_community_test', ...migrationSchemaNames]],
      );
      assert.equal(
        existing.rows[0]?.count,
        0,
        'Refusing existing migration or fixture schemas',
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
      app = await startApp();
      const port = Number(new URL(await app.getUrl()).port),
        transport = new NodeHttpTransport(port),
        cancel = new Cancellation();
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
          blocks: new HttpBlockGateway(api),
        };
      };
      type Actor = Awaited<ReturnType<typeof makeClient>>;
      const a = await makeClient('synthetic-block-a'),
        b = await makeClient('synthetic-block-b'),
        c = await makeClient('synthetic-block-c'),
        d = await makeClient('synthetic-block-d');
      const actors = [a, b, c, d],
        region = randomUUID(),
        spaceId = randomUUID();
      await pool.query(
        "INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES($1,'Synthetic Block Region',true)",
        [region],
      );
      await pool.query(
        "INSERT INTO whaleu_community.spaces(id,kind,name,is_active,operating_region_id) VALUES($1,'regional','Synthetic Block Space',true,$2)",
        [spaceId, region],
      );
      for (const actor of actors) {
        await grant(
          pool,
          actor.credentials.accountId,
          spaceId,
          verified(region),
        );
        // Only phone is verified. Canonical affiliation/student-number remain absent.
        await setSyntheticSnapshot(pool, actor.credentials.accountId, [
          syntheticAssertion(
            actor.credentials.accountId,
            randomUUID(),
            'phone',
          ),
        ]);
      }
      transport.checkResponse = (path, _status, body) => {
        if (!path.includes('/safety/')) return;
        noPrivateSafetyData(body);
        for (const actor of actors)
          assert.ok(
            !JSON.stringify(body).includes(actor.credentials.accountId),
            'Safety wire does not disclose private account IDs',
          );
      };
      const publish = async (
        actor: Actor,
        overrides: Partial<PublishPost> = {},
      ) => {
        const body = publishPostSchema.parse({
          clientRequestId: randomUUID(),
          spaceId,
          category: 'discussion',
          authorMode: 'named',
          text: `Synthetic ${randomUUID()}`,
          imageAssetIds: [],
          commentsPolicy: 'open',
          component: { kind: 'none' },
          ...overrides,
        });
        if (body.trading || body.component?.kind !== 'none')
          await approvePoll(pool, actor.credentials.accountId, body);
        else await approve(pool, actor.credentials.accountId, body.text);
        return created(await actor.community.publishPost(body, cancel));
      };
      const root = async (
        actor: Actor,
        postId: string,
        authorMode: 'named' | 'anonymous' = 'named',
      ) => {
        const body = {
          clientRequestId: randomUUID(),
          text: `Synthetic root ${randomUUID()}`,
          imageAssetIds: [],
          authorMode,
        };
        await approve(
          pool,
          actor.credentials.accountId,
          body.text,
          'publish_comment',
        );
        return created(
          await actor.community.publishComment(postId, body, cancel),
        );
      };
      const reply = async (
        actor: Actor,
        postId: string,
        rootId: string,
        authorMode: 'named' | 'anonymous' = 'named',
      ) => {
        const body: PublishReply = {
          clientRequestId: randomUUID(),
          text: `Synthetic reply ${randomUUID()}`,
          imageAssetIds: [],
          authorMode,
          targetReplyId: null,
        };
        await approveReply(
          pool,
          actor.credentials.accountId,
          postId,
          rootId,
          body,
        );
        return created(
          await actor.community.publishReply(rootId, body, cancel),
        );
      };
      const blockIntent = (
        id: string,
        kind: 'post' | 'comment' | 'reply' = 'post',
        clientRequestId = randomUUID(),
      ) => ({
        clientRequestId,
        operation: 'block_named',
        source: { kind, id },
        blocked: true,
      });
      const block = async (
        actor: Actor,
        id: string,
        kind: 'post' | 'comment' | 'reply' = 'post',
      ): Promise<BlockResult> =>
        actor.blocks.apply(blockIntent(id, kind), cancel);
      const unblock = async (
        actor: Actor,
        entry: { relationshipId: string; revision: string },
      ): Promise<BlockResult> =>
        actor.blocks.apply(
          {
            clientRequestId: randomUUID(),
            operation: 'unblock_named',
            relationshipId: entry.relationshipId,
            expectedRevision: entry.revision,
            blocked: false,
          },
          cancel,
        );
      const list = async (
        actor: Actor,
        after: string | null = null,
        limit = 20,
      ): Promise<OwnBlocksPage> => actor.blocks.list(after, cancel, limit);
      const clear = async (actor: Actor) => {
        for (const entry of (await list(actor)).items)
          applied(await unblock(actor, entry), false);
      };
      const runtimeFor = (actor: Actor, wx = platformStorage()) =>
        createCommunityRuntime(actor, wx, nativeOrigin, systemClock);
      const postA = await publish(a),
        postB = await publish(b),
        postC = await publish(c),
        anonymousB = await publish(b, { authorMode: 'anonymous' });
      const rootA = await root(a, postC),
        rootB = await root(b, postC),
        rootAnonymousB = await root(b, postC, 'anonymous'),
        rootC = await root(c, postC);
      const replyB = await reply(b, postC, rootC),
        replyAnonymousB = await reply(b, postC, rootC, 'anonymous');

      await t.test(
        'strict native requests and exact receipts reject anonymous/self/unknown sources with phone-only eligibility',
        async () => {
          const facts = (
            await pool.query<{
              affiliation_assertion_id: string | null;
              student_number_assertion_id: string | null;
            }>(
              'SELECT affiliation_assertion_id,student_number_assertion_id FROM whaleu_verification.snapshots WHERE account_id=$1',
              [a.credentials.accountId],
            )
          ).rows[0]!;
          assert.deepEqual(facts, {
            affiliation_assertion_id: null,
            student_number_assertion_id: null,
          });
          await pool.query(
            'DELETE FROM whaleu_community_test.grants WHERE account_id=$1',
            [a.credentials.accountId],
          );
          for (const [source, code] of [
            [postA, 'BLOCK_TARGET_NOT_ALLOWED'],
            [anonymousB, 'BLOCK_TARGET_NOT_ALLOWED'],
            [randomUUID(), 'POST_NOT_FOUND'],
          ] as const)
            rejected(await block(a, source), code);
          const before = transport.exchanges.length;
          await assert.rejects(
            a.blocks.apply(
              { ...blockIntent(postB), accountId: b.credentials.accountId },
              cancel,
            ),
          );
          assert.equal(
            transport.exchanges.length,
            before,
            'Strict native decoder rejects private target fields before HTTP',
          );
          const malformed = await transport.send({
            url: `${nativeOrigin}/v1/me/safety/blocks`,
            method: 'PUT',
            headers: {
              Authorization: `Bearer ${a.credentials.accessToken}`,
              'Content-Type': 'application/json',
            },
            body: {
              clientRequestId: randomUUID(),
              source: { kind: 'post', id: postB },
              blocked: true,
              targetAccountId: b.credentials.accountId,
            },
            timeoutMs: 5000,
          });
          assert.equal(
            malformed.status,
            400,
            'Nest rejects forbidden fields even if native validation is bypassed',
          );
          rejected(
            await block(a, replyAnonymousB, 'reply'),
            'BLOCK_TARGET_NOT_ALLOWED',
          );
          const result = await block(a, replyB, 'reply');
          const receipt = applied(result, true);
          assert.deepEqual(Object.keys(receipt).sort(), [
            'blocked',
            'operation',
            'outcome',
            'relationshipId',
            'requestId',
            'revision',
          ]);
          assert.deepEqual(
            (await list(a)).items.map((entry) => entry.relationshipId),
            [receipt.relationshipId],
          );
          await assert.rejects(
            b.blocks.state(receipt.relationshipId, cancel),
            clientFailure('http', 404, 'BLOCK_NOT_FOUND'),
          );
          rejected(await unblock(b, receipt), 'BLOCK_NOT_FOUND');
          await clear(a);
          await grant(pool, a.credentials.accountId, spaceId, verified(region));
        },
      );

      await t.test(
        'outgoing lists, bilateral named detail/interaction, ancestry and anonymous isolation cross actual gateways',
        async () => {
          const beforeAnonymous: PostView = await a.community.post(
            anonymousB,
            cancel,
          );
          const beforeAnonRoot: CommentView = await a.community.comment(
            rootAnonymousB,
            cancel,
          );
          await a.community.applySaved(
            {
              clientRequestId: randomUUID(),
              operation: 'set_post_saved',
              postId: postB,
              desired: true,
              channel: null,
            },
            cancel,
          );
          const ab = applied(await block(a, postB), true);
          const feedA: { items: PostView[] } = await a.community.feed(
            { spaceId },
            cancel,
          );
          assert.equal(
            feedA.items.some((item) => item.id === postB),
            false,
          );
          assert.equal(
            feedA.items.some((item) => item.id === anonymousB),
            true,
          );
          const feedB: { items: PostView[] } = await b.community.feed(
            { spaceId },
            cancel,
          );
          assert.equal(
            feedB.items.some((item) => item.id === postA),
            true,
            'Reverse-only relationship does not filter discovery',
          );
          await assert.rejects(
            a.community.post(postB, cancel),
            clientFailure('http', 404, 'POST_BLOCKED_BY_YOU'),
          );
          await assert.rejects(
            b.community.post(postA, cancel),
            clientFailure('http', 404, 'POST_NOT_FOUND'),
          );
          assert.equal(
            (await b.community.post(postB, cancel)).id,
            postB,
            'Self visibility is preserved',
          );
          const roots: { items: CommentView[] } = await a.community.comments(
            postC,
            null,
            cancel,
          );
          assert.equal(
            roots.items.some((item) => item.id === rootB),
            false,
          );
          assert.equal(
            roots.items.some((item) => item.id === rootAnonymousB),
            true,
          );
          const replies: { items: { id: string }[] } =
            await a.community.replies(rootC, null, cancel);
          assert.equal(
            replies.items.some((item) => item.id === replyB),
            false,
          );
          assert.equal(
            replies.items.some((item) => item.id === replyAnonymousB),
            true,
          );
          await assert.rejects(
            a.community.comment(rootB, cancel),
            clientFailure('http', 404, 'COMMENT_NOT_FOUND'),
          );
          await assert.rejects(
            a.community.reply(replyB, cancel),
            clientFailure('http', 404, 'REPLY_NOT_FOUND'),
          );
          await assert.rejects(
            a.community.discussionContext(postC, { commentId: rootB }, cancel),
            clientFailure('http', 404, 'COMMENT_NOT_FOUND'),
          );
          await assert.rejects(
            a.community.discussionContext(
              postA,
              { replyId: replyAnonymousB },
              cancel,
            ),
            clientFailure('http', 404, 'REPLY_NOT_FOUND'),
          );
          const counts: PostView = await a.community.post(postC, cancel);
          assert.equal(counts.commentCount, 3);
          assert.equal(counts.replyCount, 1);
          assert.equal(counts.discussionCount, 4);
          assert.deepEqual(
            await a.community.post(anonymousB, cancel),
            beforeAnonymous,
            'Anonymous post projection is unchanged by hidden author pair',
          );
          assert.deepEqual(
            await a.community.comment(rootAnonymousB, cancel),
            beforeAnonRoot,
            'Anonymous root projection is unchanged',
          );
          const saved: { items: { post: PostView }[] } =
            await a.community.saved(null, cancel);
          assert.equal(
            saved.items.some((item) => item.post.id === postB),
            false,
          );
          const reverseInteraction: PublicationReceipt =
            await b.community.publishComment(
              postA,
              {
                clientRequestId: randomUUID(),
                text: 'Synthetic denied anonymous interaction',
                authorMode: 'anonymous',
                imageAssetIds: [],
              },
              cancel,
            );
          assert.deepEqual(reverseInteraction, {
            requestId: reverseInteraction.requestId,
            operation: 'publish_comment',
            outcome: 'rejected',
            code: 'POST_NOT_FOUND',
          });
          const targetedInteraction: PublicationReceipt =
            await b.community.publishReply(
              rootA,
              {
                clientRequestId: randomUUID(),
                text: 'Synthetic denied named target',
                authorMode: 'anonymous',
                imageAssetIds: [],
                targetReplyId: null,
              },
              cancel,
            );
          assert.equal(targetedInteraction.outcome, 'rejected');
          assert.ok(targetedInteraction.outcome === 'rejected');
          assert.equal(targetedInteraction.code, 'POST_NOT_FOUND');
          const ba = applied(await block(b, rootA, 'comment'), true);
          applied(await unblock(a, ab), false);
          assert.equal(
            (await b.blocks.state(ba.relationshipId, cancel)).blocked,
            true,
            'Own unblock cannot change the reverse relationship',
          );
          assert.equal(
            (await a.community.feed({ spaceId }, cancel)).items.some(
              (item: PostView) => item.id === postB,
            ),
            true,
          );
          await assert.rejects(
            a.community.post(postB, cancel),
            clientFailure('http', 404, 'POST_NOT_FOUND'),
          );
          await clear(b);
          assert.ok(
            visibility.seen
              .filter((subject) => subject.authorMode === 'anonymous')
              .every((subject) => !('namedAccountId' in subject)),
            'Anonymous visibility subjects never resolve private actors',
          );
        },
      );

      await t.test(
        'lost committed success survives server/client restart, source loss and newer unblock without resurrection',
        async () => {
          const source = await publish(b),
            candidate = await a.community.post(source, cancel),
            wx = platformStorage();
          const runtime = runtimeFor(a, wx);
          let view = initialBlockMutationView();
          const controller = new BlockMutationController(
            runtime,
            (next: typeof view) => {
              view = next;
            },
          );
          controller.requestBlock('post', candidate);
          assert.equal(view.confirmSource.id, source);
          controller.dismissBlock();
          assert.equal(view.confirmSource, null);
          controller.requestBlock('post', candidate);
          transport.dropSuccess = {
            path: '/v1/me/safety/blocks',
            method: 'PUT',
          };
          await controller.confirmBlock();
          assert.equal(view.frozen, true);
          assert.equal(
            view.current,
            null,
            'Never flash success after lost response',
          );
          const pending = runtime.pendingBlocks.load(a.credentials.accountId);
          assert.ok(pending);
          controller.dispose();
          await app!.close();
          app = await startApp(port);
          await pool.query(
            "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
            [source],
          );
          const restored = await makeClient('unused-restored', a.credentials),
            recoveredRuntime = runtimeFor(restored, wx);
          const committed: BlockResult = await restored.blocks.apply(
            pending.intent,
            cancel,
          );
          applied(committed, true);
          assert.equal(
            committed.current?.blocked,
            true,
            'Same-key replay succeeds while its source is hidden and its own block is active',
          );
          assert.deepEqual(
            await restored.blocks.receipt(
              pending.intent.clientRequestId,
              cancel,
            ),
            committed,
          );
          const entry = (await list(restored)).items[0]!;
          const nextRevision = (BigInt(entry.revision) + 1n).toString();
          const priorEvents = (
            await pool.query<{ count: number }>(
              'SELECT count(*)::integer AS count FROM whaleu_safety.events WHERE relationship_id=$1',
              [entry.relationshipId],
            )
          ).rows[0]!.count;
          applied(await unblock(restored, entry), false);
          let recoveredView = initialBlockMutationView();
          const recovered = new BlockMutationController(
            recoveredRuntime,
            (next: typeof recoveredView) => {
              recoveredView = next;
            },
          );
          recovered.load();
          assert.equal(recoveredView.frozen, true);
          const before = transport.exchanges.length;
          await recovered.recover(true);
          assert.equal(recoveredView.frozen, false);
          assert.equal(recoveredView.current.blocked, false);
          assert.match(recoveredView.receiptStatus, /当前未屏蔽/);
          assert.equal(
            recoveredRuntime.pendingBlocks.load(a.credentials.accountId),
            null,
          );
          const replay: BlockResult = await restored.blocks.apply(
            pending.intent,
            cancel,
          );
          applied(replay, true);
          assert.equal(replay.current?.blocked, false);
          assert.equal(replay.current?.revision, nextRevision);
          assert.deepEqual(
            await restored.blocks.receipt(
              pending.intent.clientRequestId,
              cancel,
            ),
            replay,
          );
          assert.ok(
            transport.exchanges
              .slice(before)
              .every((exchange) => !exchange.path.includes('/community/')),
            'Recovery needs only own receipt, not source visibility',
          );
          const records = (
            await pool.query<{
              active: boolean;
              revision: string;
              events: number;
            }>(
              'SELECT b.active,b.revision,(SELECT count(*)::integer FROM whaleu_safety.events e WHERE e.relationship_id=b.id) AS events FROM whaleu_safety.blocks b WHERE b.id=$1',
              [entry.relationshipId],
            )
          ).rows[0]!;
          assert.deepEqual(records, {
            active: false,
            revision: nextRevision,
            events: priorEvents + 1,
          });
          await assert.rejects(
            restored.blocks.apply(
              { ...pending.intent, source: { kind: 'post', id: postC } },
              cancel,
            ),
            clientFailure('business', 409, 'REQUEST_CONFLICT'),
          );
          recovered.requestBlock('post', candidate);
          await recovered.confirmBlock();
          assert.equal(
            recoveredView.frozen,
            false,
            'A strict terminal rejection releases only the acknowledged frozen intent',
          );
          assert.equal(recoveredView.current, null);
          assert.equal(
            recoveredRuntime.pendingBlocks.load(a.credentials.accountId),
            null,
          );
          assert.match(recoveredView.receiptStatus, /不存在或当前不可查看/);
          rejected(await block(restored, source), 'POST_NOT_FOUND');
          await assert.rejects(
            b.blocks.receipt(pending.intent.clientRequestId, cancel),
            clientFailure('http', 404, 'REQUEST_NOT_FOUND'),
          );
          recovered.dispose();
        },
      );

      await t.test(
        'current account/epoch and newest intent reject stale own-list and mutation responses',
        async () => {
          const runtime = runtimeFor(a),
            candidate = await a.community.post(postC, cancel);
          let mutationView = initialBlockMutationView(),
            listView = initialBlocksView();
          const mutation = new BlockMutationController(
            runtime,
            (next: typeof mutationView) => {
              mutationView = next;
            },
          );
          const own = new BlocksController(runtime, (next: typeof listView) => {
            listView = next;
          });
          mutation.requestBlock('post', candidate);
          const commit = transport.holdNext('/v1/me/safety/blocks', 'PUT');
          const applying = mutation.confirmBlock();
          await commit.arrived;
          a.sessions.completeLogin(a.sessions.beginLogin(), d.credentials);
          assert.equal(mutationView.current, null);
          assert.deepEqual(listView.items, []);
          commit.release();
          await applying;
          assert.equal(mutationView.current, null);
          assert.ok(
            runtime.pendingBlocks.load(a.credentials.accountId),
            'Account A journal survives a callback delivered under account D',
          );
          assert.equal(
            runtime.pendingBlocks.load(d.credentials.accountId),
            null,
          );
          a.sessions.completeLogin(a.sessions.beginLogin(), a.credentials);
          mutation.load();
          await mutation.recover();
          await own.load();
          assert.equal(listView.items.length, 1);
          const entry: OwnBlock = listView.items[0];
          const staleList = transport.holdNext('/v1/me/safety/blocks');
          const loading = own.load();
          await staleList.arrived;
          await mutation.unblock(entry);
          await eventually(() => listView.loaded && !listView.busy);
          assert.deepEqual(listView.items, []);
          staleList.release();
          await loading;
          assert.deepEqual(
            listView.items,
            [],
            'Late pre-unblock response cannot restore a removed row',
          );
          const otherList = transport.holdNext('/v1/me/safety/blocks');
          const switching = own.load();
          await otherList.arrived;
          a.sessions.completeLogin(a.sessions.beginLogin(), d.credentials);
          otherList.release();
          await switching;
          assert.deepEqual(listView.items, []);
          assert.equal(
            listView.loaded,
            false,
            'Old-account completion cannot claim a new account list was loaded',
          );
          a.sessions.completeLogin(a.sessions.beginLogin(), a.credentials);
          own.dispose();
          mutation.dispose();
        },
      );

      await t.test(
        'real block confirmation clears detail, trading contacts and synthetic private overlay before fresh owner reads',
        async () => {
          const trading = await publish(b, {
            category: 'trading',
            trading: {
              subtype: 'shuma',
              price: '20.00',
              urgency: 'normal',
              location: 'Synthetic location',
              contacts: { wechat: 'SyntheticTrade', qq: '', phone: '' },
            },
          });
          const wx = platformStorage(),
            runtime = runtimeFor(a, wx);
          let detailView = initialDetailView(),
            contactsView = initialTradingContactsView(),
            mutationView = initialBlockMutationView(),
            overlayView = initialOverlayView();
          const detail = new DetailController(
            runtime,
            trading,
            (next: typeof detailView) => {
              detailView = next;
            },
          );
          const copied: string[] = [];
          const contacts = new TradingContactsController(
            runtime,
            (next: typeof contactsView) => {
              contactsView = next;
            },
            async (value: string) => {
              copied.push(value);
            },
          );
          // Only the privileged overlay fixture is synthetic. No developer grant or
          // privileged identity endpoint is created. Real safety receipts drive its invalidation.
          const overlay = new IdentityOverlayController(
            a.sessions,
            {
              authorization: async () => ({
                role: 'developer',
                management: { global: true, operatingRegionIds: [] },
                identityView: { allowed: true, maxBatchSize: 20 },
              }),
              identities: async () => [
                {
                  target: { kind: 'post', id: trading },
                  status: 'available',
                  authorMode: 'named',
                  identity: {
                    accountId: b.credentials.accountId,
                    nickname: 'Synthetic private overlay',
                    avatar: null,
                    studentNumber: null,
                    studentNumberStatus: 'unavailable',
                  },
                },
              ],
            },
            systemClock,
            (next: typeof overlayView) => {
              overlayView = next;
            },
            runtime.privateViews,
          );
          const mutation = new BlockMutationController(
            runtime,
            (next: typeof mutationView) => {
              mutationView = next;
            },
          );
          await detail.load();
          const candidate = detailView.post;
          assert.ok(candidate);
          contacts.load(candidate);
          await contacts.reveal();
          assert.equal(contactsView.contacts.wechat, 'SyntheticTrade');
          await overlay.show([
            { kind: 'post', id: trading, authorMode: 'named' },
          ]);
          assert.ok(overlayView.items[trading]);
          const stale = transport.holdNext(`/v1/community/posts/${trading}`);
          const loading = detail.load();
          await stale.arrived;
          mutation.requestBlock('post', candidate);
          wx.setRemoveFailure(true);
          await mutation.confirmBlock();
          assert.equal(
            mutationView.frozen,
            true,
            'A committed response with failed local cleanup retains the same-key barrier',
          );
          assert.equal(mutationView.current, null);
          assert.equal(contactsView.contacts, null);
          assert.equal(contactsView.enabled, false);
          assert.deepEqual(overlayView.items, {});
          assert.equal(overlayView.developerEnabled, false);
          assert.equal(detailView.post, null);
          stale.release();
          await loading;
          await eventually(() => !detailView.busy);
          assert.equal(detailView.post, null);
          assert.match(detailView.error, /你已屏蔽/);
          wx.setRemoveFailure(false);
          await mutation.recover();
          assert.equal(mutationView.current?.blocked, true);
          assert.equal(mutationView.frozen, false);
          await contacts.copy('wechat');
          assert.deepEqual(copied, []);
          await assert.rejects(
            a.community.tradingContacts(trading, cancel),
            clientFailure('http', 404, 'POST_NOT_FOUND'),
          );
          detail.dispose();
          contacts.dispose();
          overlay.dispose();
          mutation.dispose();
          await clear(a);
        },
      );

      await t.test(
        'formation roster/contact projection keeps membership authority and anonymous creator isolation',
        async () => {
          const formation = await publish(c, {
            category: 'companions',
            component: {
              kind: 'formation',
              capacity: 4,
              theme: '合成组队',
              contacts: { wechat: 'SyntheticCreator', qq: '', phone: '' },
              contactSharing: 'members_v1',
            },
          });
          for (const [actor, value] of [
            [a, 'SyntheticA'],
            [b, 'SyntheticB'],
          ] as const) {
            const receipt = await actor.community.joinFormation(
              formation,
              {
                clientRequestId: randomUUID(),
                contacts: { wechat: value, qq: '', phone: '' },
                contactSharing: 'members_v1',
              },
              cancel,
            );
            assert.equal(receipt.outcome, 'created');
          }
          const reverseFormation = await publish(a, {
            category: 'companions',
            component: {
              kind: 'formation',
              capacity: 2,
              theme: '反向合成组队',
              contacts: {
                wechat: 'SyntheticReverseCreator',
                qq: '',
                phone: '',
              },
              contactSharing: 'members_v1',
            },
          });
          const reverseJoin = await b.community.joinFormation(
            reverseFormation,
            {
              clientRequestId: randomUUID(),
              contacts: { wechat: 'SyntheticReverseMember', qq: '', phone: '' },
              contactSharing: 'members_v1',
            },
            cancel,
          );
          assert.equal(reverseJoin.outcome, 'created');
          assert.equal(
            (await b.community.formationContacts(reverseFormation, cancel))
              .members.length,
            2,
          );
          const runtime = runtimeFor(a);
          let contactsView = initialFormationContactsView();
          const contacts = new FormationContactsController(
            runtime,
            (next: typeof contactsView) => {
              contactsView = next;
            },
            async () => undefined,
          );
          contacts.load(await a.community.post(formation, cancel));
          await contacts.reveal();
          assert.equal(contactsView.rows.length, 3);
          await assert.rejects(
            d.community.formationContacts(formation, cancel),
            clientFailure('forbidden', 403, 'FORMATION_MEMBERSHIP_REQUIRED'),
          );
          applied(await block(a, postB), true);
          runtime.safetyChanges.invalidate(a.credentials.accountId);
          assert.deepEqual(contactsView.rows, []);
          assert.equal(contactsView.enabled, false);
          const reverseFeed: { items: PostView[] } = await b.community.feed(
            { spaceId },
            cancel,
          );
          const reverseCard = reverseFeed.items.find(
            (item) => item.id === reverseFormation,
          );
          assert.ok(
            reverseCard,
            'Reverse-only block retains the named formation discovery card',
          );
          assert.deepEqual(
            reverseCard.component,
            { kind: 'none' },
            'A feed card must not expose a roster whose direct named parent is unavailable',
          );
          await assert.rejects(
            b.community.formation(reverseFormation, cancel),
            clientFailure('http', 404, 'POST_NOT_FOUND'),
          );
          await assert.rejects(
            b.community.formationContacts(reverseFormation, cancel),
            clientFailure('http', 404, 'POST_NOT_FOUND'),
          );
          const projected = await a.community.formation(formation, cancel);
          const currentContacts = await a.community.formationContacts(
            formation,
            cancel,
          );
          assert.equal(projected.members.length, 2);
          assert.equal(currentContacts.members.length, 2);
          assert.equal(
            JSON.stringify(currentContacts).includes('SyntheticB'),
            false,
          );
          assert.equal(projected.viewer.isMember, true);
          await assert.rejects(
            d.community.formationContacts(formation, cancel),
            clientFailure('forbidden', 403, 'FORMATION_MEMBERSHIP_REQUIRED'),
          );
          const anonFormation = await publish(b, {
            category: 'companions',
            authorMode: 'anonymous',
            component: {
              kind: 'formation',
              capacity: 2,
              theme: '匿名组队',
              contacts: {
                wechat: 'SyntheticAnonymousCreator',
                qq: '',
                phone: '',
              },
              contactSharing: 'members_v1',
            },
          });
          const joined = await a.community.joinFormation(
            anonFormation,
            {
              clientRequestId: randomUUID(),
              contacts: { wechat: 'SyntheticA', qq: '', phone: '' },
              contactSharing: 'members_v1',
            },
            cancel,
          );
          assert.equal(
            joined.outcome,
            'created',
            'Hidden anonymous creator account does not become a named target',
          );
          assert.equal(
            (await a.community.formationContacts(anonFormation, cancel)).members
              .length,
            2,
          );
          contacts.dispose();
          await clear(a);
        },
      );

      await t.test(
        'bounded own pagination, opaque ownership and receipt recovery keep runtime unavailable gates honest',
        async () => {
          const ab = applied(await block(a, postB), true),
            ac = applied(await block(a, postC), true);
          const page1 = await list(a, null, 1);
          assert.equal(page1.items.length, 1);
          assert.ok(page1.nextCursor);
          const page2 = await list(a, page1.nextCursor, 1);
          assert.equal(page2.items.length, 1);
          assert.equal(page2.nextCursor, null);
          assert.deepEqual(
            new Set(
              [...page1.items, ...page2.items].map(
                (entry) => entry.relationshipId,
              ),
            ),
            new Set([ab.relationshipId, ac.relationshipId]),
          );
          await assert.rejects(
            b.blocks.list(page1.nextCursor, cancel, 1),
            clientFailure('business', 400, 'BAD_REQUEST'),
          );
          await clear(a);
          await setSyntheticSnapshot(pool, d.credentials.accountId, []);
          await assert.rejects(
            d.blocks.list(null, cancel),
            clientFailure('http', 503, 'VERIFICATION_UNAVAILABLE'),
          );
          const prior = providerExchanges;
          await app!.close();
          app = await startApp(port, false);
          // Real runtime base visibility remains unavailable. Safety cannot fill in
          // missing publication/scoping/review policy just because local blocks exist.
          await assert.rejects(
            a.community.post(postB, cancel),
            clientFailure('http', 503, 'COMMUNITY_UNAVAILABLE'),
          );
          await assert.rejects(
            block(a, postB),
            clientFailure('http', 503, 'COMMUNITY_UNAVAILABLE'),
          );
          assert.deepEqual(
            (await list(a)).items,
            [],
            'Own cleanup/list does not depend on source content access',
          );
          const historical: BlockResult = await a.blocks.receipt(
            ab.requestId,
            cancel,
          );
          applied(historical, true);
          assert.equal(historical.current?.blocked, false);
          assert.equal(
            providerExchanges,
            prior,
            'Every later request stays local; no real provider exchange',
          );
        },
      );
    } finally {
      try {
        await app?.close();
      } finally {
        try {
          if (ownsSchemas)
            for (const schema of [
              'whaleu_community_test',
              ...migrationSchemaNames,
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
    }
  },
);
