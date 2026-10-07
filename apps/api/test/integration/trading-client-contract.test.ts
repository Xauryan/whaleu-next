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
import { publishPostSchema } from '../../src/community/contracts.js';
import type {
  FeedPage,
  PostView,
  PublicationReceipt,
  PublishPost,
} from '../../src/community/contracts.js';
import type {
  TradingInput,
  TradingReceipt,
} from '../../src/community/trading/contracts.js';
import { postIntent } from '../../src/community/publication-intent.js';
import { publicationHash } from '../../src/community/publication.repository.js';
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
  digest,
  fixtureSchema,
  grant,
  verified,
} from '../support/community-fixtures.js';

// Execute actual native gateways and strict decoders. Only platform I/O and
// unavailable external providers are replaced by local synthetic test adapters.
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
  decodePostIntent,
  decodeReceipt,
  decodeFeed,
} = require('../../../wechat/src/community/contract.ts');
const {
  PendingTradingStore,
} = require('../../../wechat/src/community/trading-pending.ts');
const {
  decodeTradingView,
  decodeTradingContactView,
  decodeTradingReceipt,
} = require('../../../wechat/src/community/trading-contract.ts');

const {
  TradingContactsController,
} = require('../../../wechat/src/community/trading-controller.ts');

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

function created(
  receipt: PublicationReceipt,
): Extract<PublicationReceipt, { outcome: 'created' }> {
  assert.equal(receipt.outcome, 'created');
  assert.ok(receipt.outcome === 'created');
  assert.ok(Object.isFrozen(receipt), 'Actual native publication decoder ran');
  return receipt;
}
function rejected(
  receipt: PublicationReceipt | TradingReceipt,
  code: string,
): void {
  assert.deepEqual(receipt, {
    requestId: receipt.requestId,
    operation: receipt.operation,
    outcome: 'rejected',
    code,
  });
}
function applied(
  receipt: TradingReceipt,
  postId: string,
  resolution: 'open' | 'resolved',
): void {
  assert.deepEqual(receipt, {
    requestId: receipt.requestId,
    operation: 'set_trading_resolution',
    outcome: 'applied',
    resourceId: postId,
    resolution,
  });
  assert.ok(
    Object.isFrozen(receipt),
    'Actual native trading receipt decoder ran',
  );
}
function noPrivateFields(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(
      ![
        'accountId',
        'account_id',
        'studentNumber',
        'phone',
        'wechat',
        'qq',
        'contacts',
        'sessionId',
        'identities',
        'creation_transaction',
      ].includes(key),
      `Ordinary DTO contains private field ${key}`,
    );
    noPrivateFields(child);
  }
}
/** Approval is bound to the normalized entire trading intent, not just its text. */
async function approveTrading(
  pool: Pool,
  accountId: string,
  body: PublishPost,
): Promise<void> {
  const normalized = publishPostSchema.parse(body);
  await pool.query(
    "INSERT INTO whaleu_community_test.approvals(account_id,purpose,text_hash,images,intent_hash) VALUES($1,'publish_post',$2,'[]'::jsonb,$3)",
    [
      accountId,
      digest(normalized.text),
      publicationHash('publish_post', postIntent(normalized)),
    ],
  );
}

test(
  'real native trading gateway, Nest HTTP and PostgreSQL contract',
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
      WECHAT_APP_SECRET: 'synthetic-local-trading-contract-only',
      AUTH_RATE_LIMIT_KEY: 'da'.repeat(32),
    });
    const pool = new Pool(poolOptions(config));
    let suite: PoolClient | undefined;
    let locked = false,
      ownsSchemas = false;
    let app: INestApplication | undefined;
    const authorization = new FixtureAuthorization();
    const startApp = async (port = 0): Promise<INestApplication> => {
      const module = await Test.createTestingModule({
        imports: [AppModule.register(config)],
      })
        .overrideProvider(IDENTITY_PROVIDER)
        .useValue({
          exchange: async (code: string) => ({
            provider: 'wechat',
            appId: 'synthetic-native-trading',
            subject: code,
          }),
        })
        .overrideProvider(COMMUNITY_AUTHORIZATION)
        .useValue(authorization)
        .overrideProvider(COMMUNITY_VISIBILITY)
        .useValue(new FixtureVisibility())
        .overrideProvider(CONTENT_PUBLICATION_GATE)
        .useValue(new FixtureContent())
        .overrideProvider(MEDIA_ATTACHMENT)
        .useValue(new FixtureMedia())
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
        "SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
      );
      assert.equal(
        existing.rows[0]?.count,
        0,
        'Refusing existing whaleu schemas',
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
          credentials,
          sessions,
          auth,
          api,
          community: new HttpCommunityGateway(api),
        };
      };
      const author = await makeClient('synthetic-trading-author');
      const other = await makeClient('synthetic-trading-other');
      const observer = await makeClient('synthetic-trading-observer');
      const region = randomUUID(),
        spaceId = randomUUID();
      await pool.query(
        "INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES($1,'Synthetic Trading Region',true)",
        [region],
      );
      await pool.query(
        "INSERT INTO whaleu_community.spaces(id,kind,name,is_active,operating_region_id) VALUES($1,'regional','Synthetic Trading Space',true,$2)",
        [spaceId, region],
      );
      for (const actor of [author, other, observer])
        await grant(
          pool,
          actor.credentials.accountId,
          spaceId,
          verified(region),
        );
      await pool.query(
        "INSERT INTO whaleu_profile.profiles(account_id,nickname,bio) VALUES($1,'SyntheticTradeAuthor','Private synthetic profile context')",
        [author.credentials.accountId],
      );
      const contacts = {
        wechat: '  SyntheticAuthorChosen🐳  ',
        qq: '',
        phone: 'Synthetic contact text',
      };
      const makeIntent = (
        overrides: Partial<TradingInput> = {},
      ): PublishPost => ({
        clientRequestId: randomUUID(),
        spaceId,
        category: 'trading',
        authorMode: 'named',
        text: ' 合成闲置🐳\n保留正文 ',
        imageAssetIds: [],
        commentsPolicy: 'open',
        trading: {
          subtype: 'shuma',
          price: '12.345678901234567890123456789',
          urgency: 'normal',
          location: ' 合成取货位置🐳 ',
          contacts,
          ...overrides,
        },
      });
      const publish = async (body: PublishPost, actor = author) => {
        await approveTrading(pool, actor.credentials.accountId, body);
        return created(await actor.community.publishPost(body, cancel));
      };
      const rawPublish = (body: unknown) =>
        author.api.request(
          {
            path: '/v1/community/posts',
            method: 'POST',
            authentication: 'required',
            authReplay: 'never',
            successStatus: 201,
            decode: decodeReceipt,
          },
          { body, cancellation: cancel },
        );
      let normal!: Extract<PublicationReceipt, { outcome: 'created' }>;
      let urgent!: Extract<PublicationReceipt, { outcome: 'created' }>;
      let wanted!: Extract<PublicationReceipt, { outcome: 'created' }>;
      let book!: Extract<PublicationReceipt, { outcome: 'created' }>;
      let otherListing!: Extract<PublicationReceipt, { outcome: 'created' }>;
      let resolutionReceipt!: TradingReceipt;
      let normalBody!: PublishPost;

      await t.test(
        'exact decimal strings and author-selected contacts survive native publication, SQL and read projections',
        async () => {
          const unreviewed = makeIntent();
          await approve(pool, author.credentials.accountId, unreviewed.text);
          const denied: PublicationReceipt = await author.community.publishPost(
            unreviewed,
            cancel,
          );
          rejected(denied, 'CONTENT_REJECTED');
          await approveTrading(pool, author.credentials.accountId, unreviewed);
          assert.deepEqual(
            await author.community.publishPost(unreviewed, cancel),
            denied,
            'A later approval cannot revive a finalized request',
          );
          const approved = makeIntent();
          await approveTrading(pool, author.credentials.accountId, approved);
          const altered = {
            ...approved,
            clientRequestId: randomUUID(),
            trading: {
              ...approved.trading!,
              contacts: { ...contacts, wechat: 'Different chosen contact' },
            },
          };
          rejected(
            await author.community.publishPost(altered, cancel),
            'CONTENT_REJECTED',
          );

          normalBody = makeIntent({
            price: '00012.345678901234567890123456789000',
          });
          normal = await publish(normalBody);
          urgent = await publish(
            makeIntent({ urgency: 'urgent', price: '99999' }),
          );
          wanted = await publish(
            makeIntent({
              subtype: 'qiugou',
              price: '0.0000000000000000000000000000000000001',
            }),
          );
          book = await publish(
            makeIntent({
              subtype: 'shujia',
              price: '0.01',
              contacts: { wechat: '', qq: 'SyntheticQQOnly', phone: '' },
            }),
          );
          otherListing = await publish(
            makeIntent({ subtype: 'shuma', price: '1.23' }),
            other,
          );
          const ordinary: PublishPost = {
            clientRequestId: randomUUID(),
            spaceId,
            category: 'discussion',
            authorMode: 'named',
            text: 'Synthetic ordinary discussion',
            imageAssetIds: [],
            commentsPolicy: 'open',
          };
          await approve(pool, author.credentials.accountId, ordinary.text);
          const ordinaryPost = created(
            await author.community.publishPost(ordinary, cancel),
          );
          assert.equal(
            (await observer.community.post(ordinaryPost.resourceId, cancel))
              .trading,
            null,
          );
          for (const [receipt, expected] of [
            [normal, '12.345678901234567890123456789'],
            [urgent, '99999'],
            [wanted, '0.0000000000000000000000000000000000001'],
          ] as const) {
            const post: PostView = await observer.community.post(
              receipt.resourceId,
              cancel,
            );
            assert.equal(post.category, 'trading');
            assert.equal(post.author.kind, 'named');
            assert.equal(post.author.displayName, 'SyntheticTradeAuthor');
            assert.deepEqual(post.component, { kind: 'none' });
            assert.equal(post.text, normalBody.text);
            assert.deepEqual(post.trading!.price, {
              kind: 'exact',
              amount: expected,
              legacyText: null,
            });
            assert.equal(post.trading!.location, ' 合成取货位置🐳 ');
            assert.equal(post.trading!.resolution, 'open');
            assert.deepEqual(post.trading!.viewer, { canSetResolution: false });
            assert.ok(
              Object.isFrozen(post) &&
                Object.isFrozen(post.trading) &&
                Object.isFrozen(post.trading!.viewer),
            );
            const stored = await pool.query<{ price: string }>(
              'SELECT price::text FROM whaleu_community.trading_listings WHERE post_id=$1',
              [receipt.resourceId],
            );
            assert.equal(
              stored.rows[0]!.price,
              expected,
              'Unconstrained numeric storage does not round the original fractional precision',
            );
            noPrivateFields(post);
            for (const actor of [author, other, observer])
              assert.ok(
                !JSON.stringify(post).includes(actor.credentials.accountId),
              );
          }
          assert.deepEqual(
            (await author.community.post(normal.resourceId, cancel)).trading
              .viewer,
            { canSetResolution: true },
          );
          assert.deepEqual(
            await author.community.receipt(normal.requestId, cancel),
            normal,
          );
          assert.deepEqual(
            await author.community.publishPost(normalBody, cancel),
            normal,
          );
          const selected = await observer.community.tradingContacts(
            normal.resourceId,
            cancel,
          );
          assert.deepEqual(selected, { postId: normal.resourceId, contacts });
          assert.ok(
            Object.isFrozen(selected) && Object.isFrozen(selected.contacts),
          );
          assert.deepEqual(
            await observer.community.tradingContacts(book.resourceId, cancel),
            {
              postId: book.resourceId,
              contacts: { wechat: '', qq: 'SyntheticQQOnly', phone: '' },
            },
          );
          assert.ok(
            !JSON.stringify(selected).includes(
              'Private synthetic profile context',
            ),
          );
          await assert.rejects(
            observer.community.tradingContacts(ordinaryPost.resourceId, cancel),
            clientFailure('http', 404, 'POST_NOT_FOUND'),
          );
        },
      );

      await t.test(
        'subtype filters include urgent listings only in trading feeds and bind pagination scope',
        async () => {
          const all: FeedPage = await observer.community.feed(
            { spaceId },
            cancel,
          );
          assert.ok(!all.items.some((post) => post.id === urgent.resourceId));
          for (const item of [normal, wanted, book, otherListing])
            assert.ok(all.items.some((post) => post.id === item.resourceId));
          assert.ok(all.items.some((post) => post.category === 'discussion'));
          noPrivateFields(all);
          const trading: FeedPage = await observer.community.feed(
            { spaceId, category: 'trading' },
            cancel,
          );
          assert.deepEqual(
            new Set(trading.items.map((post) => post.id)),
            new Set(
              [normal, urgent, wanted, book, otherListing].map(
                (receipt) => receipt.resourceId,
              ),
            ),
          );
          assert.ok(trading.items.every((post) => post.category === 'trading'));
          for (const [subtype, expected] of [
            ['shuma', [normal, urgent, otherListing]],
            ['shujia', [book]],
            ['qiugou', [wanted]],
            ['yifu', []],
          ] as const) {
            const page: FeedPage = await observer.community.feed(
              { spaceId, category: 'trading', tradingSubtype: subtype },
              cancel,
            );
            assert.deepEqual(
              new Set(page.items.map((post) => post.id)),
              new Set(expected.map((receipt) => receipt.resourceId)),
            );
            assert.ok(
              page.items.every(
                (post) =>
                  post.trading!.subtype.kind === 'known' &&
                  post.trading!.subtype.key === subtype,
              ),
            );
            noPrivateFields(page);
          }
          const requestPage = (query: Record<string, string>) =>
            observer.api.request(
              {
                path: '/v1/community/posts',
                method: 'GET',
                authentication: 'required',
                authReplay: 'once',
                successStatus: 200,
                decode: decodeFeed,
              },
              {
                query: {
                  spaceId,
                  category: 'trading',
                  tradingSubtype: 'shuma',
                  limit: '1',
                  ...query,
                },
                cancellation: cancel,
              },
            );
          const first: FeedPage = await requestPage({});
          assert.equal(first.items.length, 1);
          assert.ok(first.nextCursor);
          const second: FeedPage = await requestPage({
            cursor: first.nextCursor,
          });
          assert.equal(second.items.length, 1);
          assert.notEqual(second.items[0]!.id, first.items[0]!.id);
          await assert.rejects(
            requestPage({ cursor: first.nextCursor, tradingSubtype: 'shujia' }),
            clientFailure('business', 400, 'BAD_REQUEST'),
          );
          const before = transport.exchanges.length;
          await assert.rejects(
            observer.community.feed(
              { spaceId, tradingSubtype: 'shuma' },
              cancel,
            ),
            { kind: 'protocol' },
          );
          assert.equal(
            transport.exchanges.length,
            before,
            'The native gateway rejects subtype without trading category before I/O',
          );
        },
      );

      await t.test(
        'wanted is normal and omitted urgency defaults only through the validated server contract',
        async () => {
          const rawWanted = {
            ...makeIntent({ subtype: 'qiugou' }),
            trading: {
              ...makeIntent().trading!,
              subtype: 'qiugou',
              urgency: 'urgent',
            },
          };
          await approveTrading(
            pool,
            author.credentials.accountId,
            publishPostSchema.parse(rawWanted),
          );
          const result = created(await rawPublish(rawWanted));
          const post: PostView = await observer.community.post(
            result.resourceId,
            cancel,
          );
          assert.deepEqual(post.trading!.subtype, {
            kind: 'known',
            key: 'qiugou',
            legacyText: null,
          });
          assert.equal(post.trading!.urgency, 'normal');
          const defaulted = makeIntent();
          const withoutUrgency: Partial<TradingInput> = {
            ...defaulted.trading!,
          };
          delete withoutUrgency.urgency;
          const body = { ...defaulted, trading: withoutUrgency };
          await approveTrading(
            pool,
            author.credentials.accountId,
            publishPostSchema.parse(body),
          );
          const defaultResult = created(await rawPublish(body));
          assert.equal(
            (await observer.community.post(defaultResult.resourceId, cancel))
              .trading.urgency,
            'urgent',
          );
          const ordinary: FeedPage = await observer.community.feed(
            { spaceId },
            cancel,
          );
          assert.ok(
            ordinary.items.some((item) => item.id === result.resourceId),
          );
          assert.ok(
            !ordinary.items.some(
              (item) => item.id === defaultResult.resourceId,
            ),
          );
        },
      );

      await t.test(
        'invalid decimals, contacts, anonymous authors and poll conflicts are rejected before durable writes',
        async () => {
          const base = makeIntent();
          const invalid = [
            ...[
              '0',
              '-1',
              '1e2',
              'NaN',
              'Infinity',
              ' 1',
              '1 ',
              '99999.0000000000000000001',
              '100000',
              '0.' + '0'.repeat(99) + '1',
              '',
              '1.',
            ].map((price) => ({
              ...base,
              trading: { ...base.trading!, price },
            })),
            { ...base, trading: { ...base.trading!, price: 1.23 } },
            { ...base, trading: { ...base.trading!, subtype: 'unknown' } },
            { ...base, trading: { ...base.trading!, location: ' ' } },
            {
              ...base,
              trading: { ...base.trading!, location: '鲸'.repeat(67) },
            },
            {
              ...base,
              trading: {
                ...base.trading!,
                contacts: { wechat: '', qq: '', phone: '' },
              },
            },
            {
              ...base,
              trading: {
                ...base.trading!,
                contacts: { wechat: '鲸'.repeat(17), qq: '', phone: '' },
              },
            },
            {
              ...base,
              trading: {
                ...base.trading!,
                contacts: {
                  ...contacts,
                  accountId: author.credentials.accountId,
                },
              },
            },
            { ...base, authorMode: 'anonymous' },
            {
              ...base,
              component: {
                kind: 'poll',
                question: 'Synthetic conflicting poll',
                selectionMode: 'single',
                options: ['A', 'B'],
              },
            },
            { ...base, category: 'discussion' },
            { ...base, trading: undefined },
            { ...base, accountId: other.credentials.accountId },
          ];
          const count = async () =>
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.publication_requests',
              )
            ).rowCount;
          const before = await count();
          for (const body of invalid) {
            const exchanges = transport.exchanges.length;
            await assert.rejects(author.community.publishPost(body, cancel), {
              kind: 'protocol',
            });
            assert.equal(
              transport.exchanges.length,
              exchanges,
              'Native invalid intent never reaches HTTP',
            );
            await assert.rejects(
              rawPublish(body),
              clientFailure('business', 400, 'BAD_REQUEST'),
            );
          }
          assert.equal(
            await count(),
            before,
            'Invalid requests do not reserve publication keys',
          );
          await assert.rejects(
            author.community.publishPost(
              {
                ...normalBody,
                trading: { ...normalBody.trading!, price: '9.9' },
              },
              cancel,
            ),
            clientFailure('business', 409, 'REQUEST_CONFLICT'),
          );
          const globalId = randomUUID();
          await pool.query(
            "INSERT INTO whaleu_community.spaces(id,kind,name,is_active) VALUES($1,'global','Synthetic Global Space',true)",
            [globalId],
          );
          await grant(
            pool,
            author.credentials.accountId,
            globalId,
            verified(region),
          );
          const globalIntent = { ...makeIntent(), spaceId: globalId };
          await approveTrading(
            pool,
            author.credentials.accountId,
            globalIntent,
          );
          rejected(
            await author.community.publishPost(globalIntent, cancel),
            'COMMUNITY_SCOPE_UNAVAILABLE',
          );
        },
      );

      await t.test(
        'historical free-text values remain explicit and lossless, including own-account urgent listings',
        async () => {
          const historical = randomUUID(),
            exactWithRaw = randomUUID();
          const rawPrice = '  面议 原文 12abc🐳\n不猜测价格  ',
            rawSubtype = ' 历史分类🐳 ';
          const longLocation = ' 历史位置🐳 '.repeat(40),
            historicalContacts = {
              wechat: '旧联系方式🐳'.repeat(12),
              qq: '',
              phone: ' 原作者填写\r\n号码说明 ',
            };
          // Test-only direct fixture insertion represents imported historical data. It
          // never weakens immutable production records or enables a runtime importer.
          const tx = await pool.connect();
          try {
            await tx.query('BEGIN');
            for (const id of [historical, exactWithRaw])
              await tx.query(
                "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'trading','Synthetic historical trading listing','named','open')",
                [id, spaceId, author.credentials.accountId],
              );
            await tx.query(
              "INSERT INTO whaleu_community.trading_listings(post_id,subtype,price,legacy_raw_price,legacy_raw_subtype,urgency,location,wechat,qq,phone) VALUES($1,'unknown',NULL,$2,$3,'urgent',$4,$5,$6,$7)",
              [
                historical,
                rawPrice,
                rawSubtype,
                longLocation,
                historicalContacts.wechat,
                historicalContacts.qq,
                historicalContacts.phone,
              ],
            );
            await tx.query(
              "INSERT INTO whaleu_community.trading_listings(post_id,subtype,price,legacy_raw_price,legacy_raw_subtype,urgency,location,wechat,qq,phone) VALUES($1,'shuma',12.345678901234567890123456789,$2,$3,'normal','Synthetic historical location','','','')",
              [
                exactWithRaw,
                '原价：00012.345678901234567890123456789000',
                '数码原分类',
              ],
            );
            await tx.query('COMMIT');
          } catch (error) {
            await tx.query('ROLLBACK');
            throw error;
          } finally {
            tx.release();
          }
          const post: PostView = await observer.community.post(
            historical,
            cancel,
          );
          assert.deepEqual(post.trading!.price, {
            kind: 'legacy',
            text: rawPrice,
          });
          assert.deepEqual(post.trading!.subtype, {
            kind: 'legacy',
            text: rawSubtype,
          });
          assert.equal(post.trading!.location, longLocation);
          noPrivateFields(post);
          assert.deepEqual(
            await observer.community.tradingContacts(historical, cancel),
            { postId: historical, contacts: historicalContacts },
          );
          const exact: PostView = await observer.community.post(
            exactWithRaw,
            cancel,
          );
          assert.deepEqual(exact.trading!.price, {
            kind: 'exact',
            amount: '12.345678901234567890123456789',
            legacyText: '原价：00012.345678901234567890123456789000',
          });
          assert.deepEqual(exact.trading!.subtype, {
            kind: 'known',
            key: 'shuma',
            legacyText: '数码原分类',
          });
          assert.deepEqual(
            await observer.community.tradingContacts(exactWithRaw, cancel),
            {
              postId: exactWithRaw,
              contacts: { wechat: '', qq: '', phone: '' },
            },
            'Historical empty contacts are retained rather than fabricated',
          );
          const own: { items: PostView[]; nextCursor: string | null } =
            await author.community.ownTrading(null, cancel);
          assert.ok(own.items.some((item) => item.id === urgent.resourceId));
          assert.ok(own.items.some((item) => item.id === historical));
          assert.ok(
            own.items.every(
              (item) => item.category === 'trading' && item.viewer.isSelf,
            ),
          );
          assert.ok(
            !own.items.some((item) => item.id === otherListing.resourceId),
          );
          noPrivateFields(own);
          const otherOwn: { items: PostView[]; nextCursor: string | null } =
            await other.community.ownTrading(null, cancel);
          assert.deepEqual(
            otherOwn.items.map((item) => item.id),
            [otherListing.resourceId],
          );
          assert.deepEqual(await observer.community.ownTrading(null, cancel), {
            items: [],
            nextCursor: null,
          });
          const ownFiltered: { items: PostView[]; nextCursor: string | null } =
            await author.community.ownTrading(null, cancel, 'shuma');
          assert.ok(
            ownFiltered.items.some((item) => item.id === urgent.resourceId),
          );
          assert.ok(
            ownFiltered.items.every(
              (item) =>
                item.trading!.subtype.kind === 'known' &&
                item.trading!.subtype.key === 'shuma',
            ),
          );
          assert.ok(!ownFiltered.items.some((item) => item.id === historical));
          const generic: FeedPage = await observer.community.feed(
            { spaceId },
            cancel,
          );
          assert.ok(!generic.items.some((item) => item.id === historical));
          const explicit: FeedPage = await observer.community.feed(
            { spaceId, category: 'trading' },
            cancel,
          );
          assert.ok(explicit.items.some((item) => item.id === historical));
        },
      );

      await t.test(
        'native durable status journal recovers committed response loss across Nest and client restart without replaying old opposite intent',
        async () => {
          const values = new Map<string, unknown>();
          const storage = {
            get: (key: string) => structuredClone(values.get(key)),
            set: (key: string, value: unknown) => {
              values.set(key, structuredClone(value));
            },
            remove: (key: string) => {
              values.delete(key);
            },
          };
          const journal = new PendingTradingStore(storage, nativeOrigin);
          const attempt = journal.freeze({
            version: 1,
            accountId: author.credentials.accountId,
            postId: normal.resourceId,
            resolution: 'resolved',
            clientRequestId: randomUUID(),
          });
          assert.equal(journal.load(other.credentials.accountId), null);
          await assert.rejects(
            author.community.tradingReceipt(attempt.clientRequestId, cancel),
            clientFailure('http', 404, 'REQUEST_NOT_FOUND'),
          );
          assert.deepEqual(
            journal.load(author.credentials.accountId),
            attempt,
            'Missing status cannot prove an unknown operation failed',
          );
          assert.throws(
            () =>
              journal.freeze({
                ...attempt,
                clientRequestId: randomUUID(),
                resolution: 'open',
              }),
            { kind: 'storage' },
          );
          transport.dropSuccess = {
            path: `/v1/community/posts/${normal.resourceId}/trading/resolution`,
            method: 'POST',
          };
          await assert.rejects(
            author.community.setTradingResolution(
              attempt.postId,
              attempt.resolution,
              attempt.clientRequestId,
              cancel,
            ),
            { kind: 'network' },
          );
          assert.equal(
            transport.exchanges.at(-1)!.status,
            201,
            'Actual Nest mutation uses the frozen201 wire contract',
          );
          assert.deepEqual(journal.load(author.credentials.accountId), attempt);
          assert.equal(
            (await observer.community.post(normal.resourceId, cancel)).trading
              .resolution,
            'resolved',
            'The response is lost only after the real transaction committed',
          );
          await app!.close();
          app = undefined;
          app = await startApp(port);
          const restored = await makeClient(
            'unused-restored-author',
            author.credentials,
          );
          const reloaded = new PendingTradingStore(storage, nativeOrigin);
          assert.deepEqual(
            reloaded.load(author.credentials.accountId),
            attempt,
          );
          const before = transport.exchanges.length;
          resolutionReceipt = await restored.community.tradingReceipt(
            attempt.clientRequestId,
            cancel,
          );
          applied(resolutionReceipt, normal.resourceId, 'resolved');
          assert.deepEqual(
            reloaded.settle(attempt, resolutionReceipt),
            resolutionReceipt,
          );
          assert.equal(reloaded.load(author.credentials.accountId), null);
          assert.deepEqual(
            transport.exchanges
              .slice(before)
              .map((exchange) => exchange.method),
            ['GET'],
            'Receipt recovery after restart does not mutate',
          );
          // Resolving/reopening needs verified phone + action authority, not a new
          // student credential or identity campus. Production safety ports are intact.
          await grant(pool, author.credentials.accountId, spaceId, {
            ...verified(region),
            studentVerified: false,
            identityRegionId: null,
          });
          applied(
            await restored.community.setTradingResolution(
              normal.resourceId,
              'open',
              randomUUID(),
              cancel,
            ),
            normal.resourceId,
            'open',
          );
          const eventCount = async () =>
            (
              await pool.query(
                "SELECT 1 FROM whaleu_community.outbox WHERE resource_id=$1 AND event_type='trading_resolution_changed'",
                [normal.resourceId],
              )
            ).rowCount;
          assert.equal(await eventCount(), 2);
          assert.deepEqual(
            await restored.community.setTradingResolution(
              attempt.postId,
              attempt.resolution,
              attempt.clientRequestId,
              cancel,
            ),
            resolutionReceipt,
          );
          assert.equal(
            (await observer.community.post(normal.resourceId, cancel)).trading
              .resolution,
            'open',
            'An older resolved replay must not undo the newer open intent',
          );
          assert.equal(
            await eventCount(),
            2,
            'Immutable replay does not create duplicate events',
          );
          await assert.rejects(
            restored.community.setTradingResolution(
              normal.resourceId,
              'open',
              attempt.clientRequestId,
              cancel,
            ),
            clientFailure('business', 409, 'REQUEST_CONFLICT'),
          );
          await assert.rejects(
            restored.community.setTradingResolution(
              urgent.resourceId,
              'resolved',
              attempt.clientRequestId,
              cancel,
            ),
            clientFailure('business', 409, 'REQUEST_CONFLICT'),
          );
          await grant(
            pool,
            author.credentials.accountId,
            spaceId,
            verified(region),
          );
          noPrivateFields(resolutionReceipt);
          const outbox = await pool.query<{ context: unknown }>(
            'SELECT context FROM whaleu_community.outbox',
          );
          noPrivateFields(outbox.rows);
          for (const chosen of Object.values(contacts).filter(Boolean))
            assert.ok(!JSON.stringify(outbox.rows).includes(chosen));
        },
      );

      await t.test(
        'account-owned receipts and independent publication keys cannot disclose or change another listing',
        async () => {
          await assert.rejects(
            other.community.tradingReceipt(resolutionReceipt.requestId, cancel),
            clientFailure('http', 404, 'REQUEST_NOT_FOUND'),
          );
          const forbidden: TradingReceipt =
            await other.community.setTradingResolution(
              normal.resourceId,
              'resolved',
              randomUUID(),
              cancel,
            );
          rejected(forbidden, 'POST_NOT_FOUND');
          assert.deepEqual(
            await other.community.tradingReceipt(forbidden.requestId, cancel),
            forbidden,
          );
          applied(
            await other.community.setTradingResolution(
              otherListing.resourceId,
              'resolved',
              resolutionReceipt.requestId,
              cancel,
            ),
            otherListing.resourceId,
            'resolved',
          );
          assert.deepEqual(
            await author.community.tradingReceipt(
              resolutionReceipt.requestId,
              cancel,
            ),
            resolutionReceipt,
          );
          applied(
            await author.community.setTradingResolution(
              urgent.resourceId,
              'resolved',
              normal.requestId,
              cancel,
            ),
            urgent.resourceId,
            'resolved',
          );
          assert.deepEqual(
            await author.community.receipt(normal.requestId, cancel),
            normal,
            'Publication and status journal namespaces remain independent',
          );
          const count = async () =>
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.trading_requests',
              )
            ).rowCount;
          const before = await count();
          for (const body of [
            { clientRequestId: randomUUID(), resolution: 'sold' },
            {
              clientRequestId: randomUUID(),
              resolution: 'open',
              accountId: other.credentials.accountId,
            },
          ])
            await assert.rejects(
              author.api.request(
                {
                  path: `/v1/community/posts/${normal.resourceId}/trading/resolution`,
                  method: 'POST',
                  authentication: 'required',
                  authReplay: 'never',
                  successStatus: 201,
                  decode: decodeTradingReceipt,
                },
                { body, cancellation: cancel },
              ),
              clientFailure('business', 400, 'BAD_REQUEST'),
            );
          assert.equal(await count(), before);
          await grant(pool, author.credentials.accountId, spaceId, {
            ...verified(region),
            phoneVerified: false,
          });
          const denied: TradingReceipt =
            await author.community.setTradingResolution(
              normal.resourceId,
              'resolved',
              randomUUID(),
              cancel,
            );
          rejected(denied, 'PHONE_VERIFICATION_REQUIRED');
          await grant(
            pool,
            author.credentials.accountId,
            spaceId,
            verified(region),
          );
          assert.deepEqual(
            await author.community.setTradingResolution(
              normal.resourceId,
              'resolved',
              denied.requestId,
              cancel,
            ),
            denied,
            'Later verification cannot reopen an immutable rejection',
          );
          assert.equal(
            (await author.community.post(normal.resourceId, cancel)).trading
              .resolution,
            'open',
          );
        },
      );

      await t.test(
        'strict native decoders reject contact leakage, numeric coercion and invalid parent relations',
        async () => {
          const post: PostView = await observer.community.post(
            normal.resourceId,
            cancel,
          );
          for (const decode of [
            () => decodePost({ ...post, contacts }),
            () =>
              decodePost({ ...post, trading: { ...post.trading, contacts } }),
            () =>
              decodeTradingView({
                ...post.trading,
                price: { kind: 'exact', amount: 12.345, legacyText: null },
              }),
            () =>
              decodeTradingView({
                ...post.trading,
                price: {
                  kind: 'exact',
                  amount: '00012.3400',
                  legacyText: null,
                },
              }),
            () =>
              decodeTradingView({
                ...post.trading,
                price: { kind: 'legacy', text: '面议', amount: '1' },
              }),
            () =>
              decodeTradingView({
                ...post.trading,
                subtype: { kind: 'known', key: 'unknown', legacyText: null },
              }),
            () =>
              decodePost({
                ...post,
                author: {
                  kind: 'anonymous',
                  personaId: randomUUID(),
                  displayName: 'Synthetic anonymous whale',
                  avatar: null,
                  isPostAuthor: false,
                },
              }),
            () =>
              decodePost({ ...post, space: { ...post.space, kind: 'global' } }),
            () =>
              decodePost({
                ...post,
                trading: {
                  ...post.trading,
                  viewer: { canSetResolution: true },
                },
              }),
            () =>
              decodeTradingContactView({
                postId: post.id,
                contacts: {
                  ...contacts,
                  accountId: author.credentials.accountId,
                },
              }),
            () => decodeTradingReceipt({ ...resolutionReceipt, contacts }),
            () =>
              decodePostIntent({
                ...normalBody,
                trading: { ...normalBody.trading!, price: '1e2' },
              }),
          ])
            assert.throws(decode, { kind: 'protocol' });
        },
      );

      await t.test(
        'contacts, detail, feeds and mutations recheck hidden, blocked and deleted parents while receipts remain durable',
        async () => {
          const contactViews: { contacts: typeof contacts | null }[] = [];
          const copied: string[] = [];
          const contactController = new TradingContactsController(
            { sessions: observer.sessions, gateway: observer.community },
            (view: { contacts: typeof contacts | null }) =>
              contactViews.push(view),
            async (text: string) => {
              copied.push(text);
            },
          );
          t.after(() => contactController.dispose());
          contactController.load(
            await observer.community.post(normal.resourceId, cancel),
          );
          await contactController.reveal();
          assert.deepEqual(contactViews.at(-1)!.contacts, contacts);
          const contactsPath = `/v1/community/posts/${normal.resourceId}/trading/contacts`;
          await assert.rejects(
            observer.api.request(
              {
                path: contactsPath,
                method: 'GET',
                authentication: 'none',
                authReplay: 'never',
                successStatus: 200,
                decode: decodeTradingContactView,
              },
              { cancellation: cancel },
            ),
            clientFailure('auth-required', 401, 'AUTHENTICATION_REQUIRED'),
          );
          await pool.query(
            'INSERT INTO whaleu_community_test.blocks(viewer,author) VALUES($1,$2)',
            [observer.credentials.accountId, author.credentials.accountId],
          );
          for (const read of [
            () => observer.community.post(normal.resourceId, cancel),
            () => observer.community.tradingContacts(normal.resourceId, cancel),
          ])
            await assert.rejects(
              read(),
              clientFailure('http', 404, 'POST_NOT_FOUND'),
            );
          await contactController.copy('wechat');
          assert.deepEqual(
            copied,
            [],
            'Copy must recheck the now-blocked parent rather than using a cached contact',
          );
          assert.equal(contactViews.at(-1)!.contacts, null);
          const blocked: FeedPage = await observer.community.feed(
            { spaceId, category: 'trading' },
            cancel,
          );
          assert.deepEqual(
            blocked.items.map((item) => item.id),
            [otherListing.resourceId],
          );
          noPrivateFields(blocked);
          await pool.query(
            'DELETE FROM whaleu_community_test.blocks WHERE viewer=$1',
            [observer.credentials.accountId],
          );
          await pool.query(
            "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
            [normal.resourceId],
          );
          for (const actor of [author, observer]) {
            await assert.rejects(
              actor.community.post(normal.resourceId, cancel),
              clientFailure('http', 404, 'POST_NOT_FOUND'),
            );
            await assert.rejects(
              actor.community.tradingContacts(normal.resourceId, cancel),
              clientFailure('http', 404, 'POST_NOT_FOUND'),
            );
          }
          const hiddenOwn: { items: PostView[]; nextCursor: string | null } =
            await author.community.ownTrading(null, cancel);
          assert.ok(
            !hiddenOwn.items.some((item) => item.id === normal.resourceId),
          );
          const hiddenDenied: TradingReceipt =
            await author.community.setTradingResolution(
              normal.resourceId,
              'resolved',
              randomUUID(),
              cancel,
            );
          rejected(hiddenDenied, 'POST_NOT_FOUND');
          assert.deepEqual(
            await author.community.tradingReceipt(
              resolutionReceipt.requestId,
              cancel,
            ),
            resolutionReceipt,
          );
          assert.deepEqual(
            await author.community.setTradingResolution(
              normal.resourceId,
              'resolved',
              resolutionReceipt.requestId,
              cancel,
            ),
            resolutionReceipt,
          );
          await pool.query(
            "UPDATE whaleu_community.posts SET visibility='approved' WHERE id=$1",
            [normal.resourceId],
          );
          assert.equal(
            (await author.community.post(normal.resourceId, cancel)).trading
              .resolution,
            'open',
            'Hidden-parent replay cannot reapply a stale status',
          );
          await author.community.deletePost(normal.resourceId, cancel);
          await author.community.deletePost(normal.resourceId, cancel);
          for (const actor of [author, observer])
            await assert.rejects(
              actor.community.tradingContacts(normal.resourceId, cancel),
              clientFailure('http', 404, 'POST_NOT_FOUND'),
            );
          rejected(
            await author.community.setTradingResolution(
              normal.resourceId,
              'resolved',
              randomUUID(),
              cancel,
            ),
            'POST_NOT_FOUND',
          );
          assert.deepEqual(
            await author.community.setTradingResolution(
              normal.resourceId,
              'resolved',
              resolutionReceipt.requestId,
              cancel,
            ),
            resolutionReceipt,
          );
          assert.deepEqual(
            await author.community.tradingReceipt(
              resolutionReceipt.requestId,
              cancel,
            ),
            resolutionReceipt,
          );
          assert.deepEqual(
            await author.community.receipt(normal.requestId, cancel),
            normal,
          );
          const stored = await pool.query<{ resolution: string }>(
            'SELECT resolution FROM whaleu_community.trading_listings WHERE post_id=$1',
            [normal.resourceId],
          );
          assert.equal(stored.rows[0]!.resolution, 'open');
          const afterDelete: { items: PostView[]; nextCursor: string | null } =
            await author.community.ownTrading(null, cancel);
          assert.ok(
            !afterDelete.items.some((item) => item.id === normal.resourceId),
          );
          await pool.query(
            "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
            [author.credentials.accountId],
          );
          await assert.rejects(
            author.community.tradingReceipt(
              resolutionReceipt.requestId,
              cancel,
            ),
            clientFailure('forbidden', 403, 'ACCOUNT_BLOCKED'),
          );
          await assert.rejects(
            author.community.tradingContacts(urgent.resourceId, cancel),
            clientFailure('forbidden', 403, 'ACCOUNT_BLOCKED'),
          );
          await assert.rejects(
            author.community.setTradingResolution(
              urgent.resourceId,
              'open',
              randomUUID(),
              cancel,
            ),
            clientFailure('forbidden', 403, 'ACCOUNT_BLOCKED'),
          );
          await observer.auth.logout();
          const revoked = await makeClient(
            'unused-revoked-observer',
            observer.credentials,
          );
          const before = transport.exchanges.length;
          await assert.rejects(
            revoked.community.tradingContacts(urgent.resourceId, cancel),
            clientFailure('auth-required', 401, 'SESSION_REVOKED'),
          );
          assert.equal(
            transport.exchanges.length,
            before + 1,
            'Revoked sessions never refresh and replay',
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
    }
  },
);
