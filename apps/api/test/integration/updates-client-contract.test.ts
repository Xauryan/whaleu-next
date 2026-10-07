import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as nodeRequest } from 'node:http';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
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
  ReplyView,
  PublicationReceipt,
  PublishPost,
  PublishComment,
} from '../../src/community/contracts.js';
import type { SavedReceipt } from '../../src/community/saved/contracts.js';
import type {
  NoticeView,
  UpdatesPage,
} from '../../src/notifications/contracts.js';
import { UpdatesWorker } from '../../src/notifications/worker.js';
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
  approveReply,
  fixtureSchema,
  grant,
  verified,
} from '../support/community-fixtures.js';

// Real native gateway, decoder, Page registration and controller code. Only the
// WeChat platform I/O and fail-closed community authority ports use fixtures.
// The notification repository/materializer/facade are NEVER replaced by fakes.
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
  createCommunityRuntime,
} = require('../../../wechat/src/community/runtime.ts');
const {
  UpdatesBadgeController,
} = require('../../../wechat/src/pages/community-updates/controller.ts');
const {
  DetailController,
} = require('../../../wechat/src/pages/community-detail/controller.ts');
const {
  ThreadController,
} = require('../../../wechat/src/pages/community-thread/controller.ts');
const {
  decodeUpdatesList,
  decodeCommunityUpdate,
  decodeUpdateRead,
  decodeResolvedUpdateTarget,
} = require('../../../wechat/src/community/updates-contract.ts');

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
  checkResponse:
    ((path: string, status: number, body: unknown) => void) | null = null;

  interceptResponse:
    ((path: string, method: string, deliver: () => void) => boolean) | null =
    null;

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
              const result = raw === '' ? '' : JSON.parse(raw);
              this.checkResponse?.(url.pathname, status, result);
              const deliver = () => resolve({ status, headers, body: result });
              if (
                !this.interceptResponse?.(url.pathname, input.method, deliver)
              )
                deliver();
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

function noPrivateFields(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(
      ![
        'accountId',
        'account_id',
        'recipientAccountId',
        'recipient_account_id',
        'actorAccountId',
        'saveEpochId',
        'studentNumber',
        'studentNumberStatus',
        'identities',
        'sessionId',
        'phone',
        'contacts',
        'delivered',
        'deliveryAcknowledged',
        'creation_transaction',
        'publication_transaction',
      ].includes(key),
      `Private/delivery field ${key}`,
    );
    noPrivateFields(child);
  }
}
function created(receipt: PublicationReceipt): string {
  assert.equal(receipt.outcome, 'created', JSON.stringify(receipt));
  assert.ok(receipt.outcome === 'created');
  assert.ok(Object.isFrozen(receipt), 'Native receipt decoder is active');
  return receipt.resourceId;
}
function available(
  notice: NoticeView | undefined,
): Extract<NoticeView, { status: 'available' }> {
  assert.ok(notice);
  assert.equal(notice.status, 'available');
  assert.ok(notice.status === 'available');
  return notice;
}
async function until(predicate: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < end, `Timed out waiting for ${label}`);
    await delay(5);
  }
}
async function untilDatabase(
  predicate: () => Promise<boolean>,
  label: string,
  timeoutMs = 10000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
    await delay(25);
  }
}
interface OverlayView {
  developerEnabled: boolean;
  items: Record<string, { accountId: string; studentNumber: string | null }>;
  notice: string;
}
interface PageData {
  items: NoticeView[];
  unreadCount: number;
  busy: boolean;
  loaded: boolean;
  error: string;
  status: string;
  identityOverlay: OverlayView;
}
interface NativePage {
  data: PageData;
  setData(patch: Partial<PageData>): void;
  controller?: {
    load(): Promise<void>;
    more(): Promise<void>;
    open(id: string): Promise<void>;
    acknowledge(id: string): Promise<void>;
  };
  onShow(): void;
  onReload(): void;
  onMore(): void;
  onOpen(event: { currentTarget: { dataset: { id: string } } }): void;
  onRead(event: { currentTarget: { dataset: { id: string } } }): void;
  onHide(): void;
  onUnload(): void;
}
const click = (id: string) => ({ currentTarget: { dataset: { id } } });

test(
  'real native Updates Page and gateway → Nest HTTP → PostgreSQL notifications',
  { timeout: 120000 },
  async (t) => {
    const connectionString = process.env['TEST_DATABASE_URL'];
    assert.ok(
      connectionString,
      'Set TEST_DATABASE_URL; no silent integration skips',
    );
    const databaseUrl = new URL(connectionString);
    assert.ok(
      ['127.0.0.1', 'localhost', '[::1]'].includes(databaseUrl.hostname),
      'Loopback database only',
    );
    assert.equal(
      databaseUrl.pathname,
      '/whaleu_test',
      'Disposable test database only',
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
      WECHAT_APP_SECRET: 'synthetic-local-updates-contract-only',
      AUTH_RATE_LIMIT_KEY: 'cf'.repeat(32),
    });
    const pool = new Pool(poolOptions(config));
    let suite: PoolClient | undefined;
    let locked = false,
      ownsSchemas = false;
    let app: INestApplication | undefined;
    let providerExchanges = 0;
    const startApp = async (
      port = 0,
      processing: 'manual_only' | 'automatic' = 'manual_only',
      intervalMs = 25,
    ) => {
      const module = await Test.createTestingModule({
        imports: [
          AppModule.register({
            ...config,
            COMMUNITY_UPDATES_PROCESSING: processing,
            COMMUNITY_UPDATES_INTERVAL_MS: intervalMs,
          }),
        ],
      })
        .overrideProvider(IDENTITY_PROVIDER)
        .useValue({
          exchange: async (code: string) => {
            providerExchanges++;
            return {
              provider: 'wechat',
              appId: 'synthetic-native-updates',
              subject: code,
            };
          },
        })
        .overrideProvider(COMMUNITY_AUTHORIZATION)
        .useValue(new FixtureAuthorization())
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
    const globals = globalThis as unknown as Record<string, unknown>;
    const previousGlobals = Object.fromEntries(
      ['Page', 'getApp', 'wx'].map((key) => [
        key,
        { owned: Object.hasOwn(globals, key), value: globals[key] },
      ]),
    );
    let page: NativePage | undefined;
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
        'Another integration suite owns this disposable database; run serially',
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
        'Refusing existing WhaleU schemas',
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
      const transport = new NodeHttpTransport(port),
        cancel = new Cancellation();
      const storage = new Map<string, unknown>();
      const navigations: string[] = [];
      const wx = {
        getStorageSync: (key: string) => structuredClone(storage.get(key)),
        setStorageSync: (key: string, value: unknown) => {
          storage.set(key, structuredClone(value));
        },
        removeStorageSync: (key: string) => {
          storage.delete(key);
        },
        request: () => {
          throw new Error('Unexpected direct WeChat/provider request');
        },
        login: () => {
          throw new Error('Unexpected direct provider login');
        },
        navigateTo: (options: { url: string; success(): void }) => {
          navigations.push(options.url);
          options.success();
        },
      };
      const makeClient = async (code: string) => {
        const sessions = new SessionStore();
        const auth = new AuthService(
          sessions,
          new HttpAuthGateway(nativeOrigin, transport, systemClock),
          { login: async () => code },
          systemClock,
        );
        await auth.login();
        const credentials: SessionCredentials = sessions.snapshot().credentials;
        assert.ok(credentials);
        const api = new ApiClient(nativeOrigin, transport, sessions, auth);
        const runtime = createCommunityRuntime(
          { sessions, auth, api },
          wx,
          nativeOrigin,
          systemClock,
        );
        return {
          credentials,
          sessions,
          auth,
          api,
          runtime,
          community: new HttpCommunityGateway(api),
        };
      };
      type Actor = Awaited<ReturnType<typeof makeClient>>;
      const author = await makeClient('synthetic-updates-author'),
        writer = await makeClient('synthetic-updates-writer'),
        saver = await makeClient('synthetic-updates-saver'),
        muted = await makeClient('synthetic-updates-muted'),
        resaver = await makeClient('synthetic-updates-resaver'),
        late = await makeClient('synthetic-updates-late'),
        removed = await makeClient('synthetic-updates-removed'),
        developer = await makeClient('synthetic-updates-developer'),
        outsider = await makeClient('synthetic-updates-outsider');
      const actors = [
        author,
        writer,
        saver,
        muted,
        resaver,
        late,
        removed,
        developer,
        outsider,
      ];
      const region = randomUUID(),
        spaceId = randomUUID();
      await pool.query(
        "INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES($1,'Synthetic Updates Region',true)",
        [region],
      );
      await pool.query(
        "INSERT INTO whaleu_community.spaces(id,kind,name,is_active,operating_region_id) VALUES($1,'regional','Synthetic Updates Space',true,$2)",
        [spaceId, region],
      );
      for (const actor of actors)
        await grant(
          pool,
          actor.credentials.accountId,
          spaceId,
          verified(region),
        );
      const publishPost = async (
        actor = author,
        text = 'Synthetic Updates parent',
      ): Promise<string> => {
        const intent: PublishPost = {
          clientRequestId: randomUUID(),
          spaceId,
          category: 'discussion',
          authorMode: 'named',
          text,
          imageAssetIds: [],
          commentsPolicy: 'open',
        };
        await approve(pool, actor.credentials.accountId, text);
        return created(await actor.community.publishPost(intent, cancel));
      };
      const publishRoot = async (
        actor: Actor,
        postId: string,
        text: string,
        authorMode: 'named' | 'anonymous' = 'named',
      ): Promise<string> => {
        const intent: PublishComment = {
          clientRequestId: randomUUID(),
          text,
          authorMode,
          imageAssetIds: [],
        };
        await approve(
          pool,
          actor.credentials.accountId,
          text,
          'publish_comment',
        );
        return created(
          await actor.community.publishComment(postId, intent, cancel),
        );
      };
      const publishReply = async (
        actor: Actor,
        postId: string,
        rootId: string,
        text: string,
        targetReplyId: string | null = null,
        authorMode: 'named' | 'anonymous' = 'named',
      ): Promise<string> => {
        const intent = {
          clientRequestId: randomUUID(),
          text,
          authorMode,
          imageAssetIds: [],
          targetReplyId,
        };
        await approveReply(
          pool,
          actor.credentials.accountId,
          postId,
          rootId,
          intent,
        );
        return created(
          await actor.community.publishReply(rootId, intent, cancel),
        );
      };
      const saved = async (
        actor: Actor,
        postId: string,
        desired: boolean,
        channel: 'saved' | 'external' | null = null,
      ) => {
        const receipt: SavedReceipt = await actor.community.applySaved(
          {
            clientRequestId: randomUUID(),
            operation:
              channel === null
                ? 'set_post_saved'
                : 'set_post_update_preference',
            postId,
            desired,
            channel,
          },
          cancel,
        );
        assert.equal(receipt.outcome, 'applied', JSON.stringify(receipt));
        return receipt;
      };
      const eventId = async (resourceId: string): Promise<string> => {
        const result = await pool.query<{ id: string }>(
          "SELECT id FROM whaleu_community.outbox WHERE resource_id=$1 AND event_type IN ('comment_created','reply_created')",
          [resourceId],
        );
        assert.equal(result.rowCount, 1);
        return result.rows[0]!.id;
      };
      transport.checkResponse = (path, _status, body) => {
        if (!path.includes('/community/updates')) return;
        noPrivateFields(body);
        for (const actor of actors)
          assert.ok(
            !JSON.stringify(body).includes(actor.credentials.accountId),
            'No account IDs in ordinary Updates HTTP',
          );
      };
      let pageDefinition: NativePage | undefined;
      let currentRuntime = author.runtime;
      globals['wx'] = wx;
      globals['getApp'] = () => ({ community: currentRuntime });
      globals['Page'] = (definition: NativePage) => {
        pageDefinition = definition;
      };
      const pageModule =
        require.resolve('../../../wechat/src/pages/community-updates/community-updates.ts');
      delete require.cache[pageModule];
      require(pageModule);
      assert.ok(pageDefinition, 'Actual native Page registered');
      const mount = (actor: Actor) => {
        page?.onUnload();
        currentRuntime = actor.runtime;
        page = Object.assign(
          Object.create(Object.getPrototypeOf(pageDefinition)),
          pageDefinition,
          {
            data: structuredClone(pageDefinition!.data),
            setData(this: NativePage, patch: Partial<PageData>) {
              Object.assign(this.data, patch);
            },
          },
        ) as NativePage;
        page.onShow();
        return page;
      };
      const list = async (actor: Actor): Promise<UpdatesPage> =>
        actor.community.updates(null, cancel, 50);
      const findNotice = async (actor: Actor, contentId: string) =>
        available(
          (await list(actor)).items.find(
            (item) =>
              item.status === 'available' &&
              (item.target.replyId ?? item.target.commentId) === contentId,
          ),
        );
      const materialize = async (...contentIds: string[]) =>
        app!.get(UpdatesWorker).run({
          mode: 'apply',
          eventIds: await Promise.all(contentIds.map(eventId)),
        });
      const persisted = async (contentId: string) =>
        (
          await pool.query<{
            id: string;
            recipient_account_id: string;
            reason: string;
            kind: string;
            read_at: Date | null;
          }>(
            'SELECT id,recipient_account_id,reason,kind,read_at FROM whaleu_notifications.notices WHERE event_id=$1 ORDER BY recipient_account_id',
            [await eventId(contentId)],
          )
        ).rows;
      const receipts = async (contentId: string) =>
        (
          await pool.query<{
            recipient_account_id: string;
            channel: string;
            reason: string;
            outcome: string;
            code: string | null;
          }>(
            'SELECT recipient_account_id,channel,reason,outcome,code FROM whaleu_notifications.processing_receipts WHERE event_id=$1 ORDER BY recipient_account_id,channel',
            [await eventId(contentId)],
          )
        ).rows;
      const postId = await publishPost();
      let firstRoot = '',
        replyTarget = '',
        addressedReply = '';

      await t.test(
        'real Saved epochs and root publication materialize direct/saved once with no self, late-save or re-save replay',
        async () => {
          for (const actor of [author, writer, saver, muted, resaver, removed])
            await saved(actor, postId, true);
          await saved(author, postId, false, 'saved');
          await saved(author, postId, false, 'external');
          await saved(saver, postId, false, 'external');
          firstRoot = await publishRoot(
            writer,
            postId,
            'Synthetic root requiring real persisted Updates',
          );
          const oldEpoch = (
            await pool.query<{ epoch_id: string }>(
              'SELECT epoch_id FROM whaleu_community.saved_posts WHERE account_id=$1 AND post_id=$2',
              [resaver.credentials.accountId, postId],
            )
          ).rows[0]!.epoch_id;
          await saved(late, postId, true);
          await saved(resaver, postId, false);
          await saved(resaver, postId, true);
          await saved(removed, postId, false);
          await saved(muted, postId, false, 'saved');
          assert.notEqual(
            (
              await pool.query<{ epoch_id: string }>(
                'SELECT epoch_id FROM whaleu_community.saved_posts WHERE account_id=$1 AND post_id=$2',
                [resaver.credentials.accountId, postId],
              )
            ).rows[0]!.epoch_id,
            oldEpoch,
          );
          assert.equal(
            (await persisted(firstRoot)).length,
            0,
            'Publication outbox is not a notification',
          );
          assert.equal((await list(author)).unreadCount, 0);
          const idle = await app!.get(UpdatesWorker).run();
          assert.equal(idle.mode, 'dry-run');
          assert.equal(idle.requested, 0);
          const dry = await app!
            .get(UpdatesWorker)
            .run({ eventIds: [await eventId(firstRoot)] });
          assert.equal(dry.mode, 'dry-run');
          assert.equal(dry.materialized, 2);
          assert.equal(
            (await persisted(firstRoot)).length,
            0,
            'Dry-run cannot claim delivery',
          );
          const outcome = await materialize(firstRoot);
          assert.equal(outcome.processed, 1);
          assert.equal(outcome.materialized, 2);
          assert.deepEqual(
            (await persisted(firstRoot))
              .map((row) => [row.recipient_account_id, row.reason, row.kind])
              .sort(),
            [
              [author.credentials.accountId, 'direct', 'root'],
              [saver.credentials.accountId, 'saved', 'root'],
            ].sort(),
          );
          for (const actor of [writer, muted, resaver, removed, late])
            assert.equal((await list(actor)).unreadCount, 0);
          const authorNotice = await findNotice(author, firstRoot),
            saverNotice = await findNotice(saver, firstRoot);
          assert.equal(
            authorNotice.reason,
            'direct',
            'Saved mute never mutes direct in-app',
          );
          assert.equal(
            saverNotice.reason,
            'saved',
            'External mute never mutes saved in-app',
          );
          assert.notEqual(authorNotice.noticeId, saverNotice.noticeId);
          assert.equal(
            authorNotice.preview.text,
            'Synthetic root requiring real persisted Updates',
          );
          assert.ok(Object.isFrozen(authorNotice.preview));
          const settled = await receipts(firstRoot);
          assert.ok(
            settled.some(
              (row) =>
                row.recipient_account_id === resaver.credentials.accountId &&
                row.channel === 'in_app' &&
                row.outcome === 'suppressed',
            ),
          );
          assert.ok(
            settled.some(
              (row) =>
                row.recipient_account_id === muted.credentials.accountId &&
                row.channel === 'in_app' &&
                row.outcome === 'suppressed',
            ),
          );
          assert.ok(
            settled
              .filter((row) => row.channel === 'external')
              .every((row) => row.outcome !== 'materialized'),
          );
          assert.ok(
            settled.some(
              (row) =>
                row.recipient_account_id === author.credentials.accountId &&
                row.channel === 'external' &&
                row.code === 'external_updates_disabled',
            ),
          );
          await saved(muted, postId, true, 'saved');
          const retry = await materialize(firstRoot);
          assert.equal(retry.alreadyProcessed, 1);
          assert.equal(retry.materialized, 0);
          assert.equal(
            (await list(muted)).unreadCount,
            0,
            'Turning on after suppression never replays old event',
          );
          const beforeRestart = await persisted(firstRoot);
          await app!.close();
          app = await startApp(port);
          const retryAfterRestart = await materialize(firstRoot);
          assert.equal(retryAfterRestart.alreadyProcessed, 1);
          assert.deepEqual(await persisted(firstRoot), beforeRestart);
          assert.equal((await list(author)).unreadCount, 1);
          assert.equal((await list(saver)).unreadCount, 1);
          assert.equal(
            (await author.community.postUpdatePreferences(postId, cancel))
              .externalCapability,
            'unavailable',
          );
        },
      );

      await t.test(
        'reply recipients are exact root/explicit targets, deduped and self-excluding with no post-owner/saver fan-out',
        async () => {
          replyTarget = await publishReply(
            outsider,
            postId,
            firstRoot,
            'Synthetic explicit reply target',
          );
          assert.equal((await materialize(replyTarget)).materialized, 1);
          assert.deepEqual(
            (await persisted(replyTarget)).map(
              (row) => row.recipient_account_id,
            ),
            [writer.credentials.accountId],
          );
          addressedReply = await publishReply(
            author,
            postId,
            firstRoot,
            'Synthetic reply notifying two exact recipients',
            replyTarget,
          );
          assert.equal((await materialize(addressedReply)).materialized, 2);
          assert.deepEqual(
            (await persisted(addressedReply))
              .map((row) => [row.recipient_account_id, row.reason, row.kind])
              .sort(),
            [
              [writer.credentials.accountId, 'direct', 'reply'],
              [outsider.credentials.accountId, 'direct', 'reply'],
            ].sort(),
          );
          const self = await publishReply(
            writer,
            postId,
            firstRoot,
            'Synthetic self-root excluded',
            replyTarget,
          );
          assert.equal((await materialize(self)).materialized, 1);
          assert.deepEqual(
            (await persisted(self)).map((row) => row.recipient_account_id),
            [outsider.credentials.accountId],
          );
          const sameOwnerTarget = await publishReply(
            writer,
            postId,
            firstRoot,
            'Synthetic root owner target',
          );
          assert.equal((await materialize(sameOwnerTarget)).materialized, 0);
          const overlap = await publishReply(
            outsider,
            postId,
            firstRoot,
            'Synthetic root and target owner overlap',
            sameOwnerTarget,
          );
          assert.equal((await materialize(overlap)).materialized, 1);
          assert.deepEqual(
            (await persisted(overlap)).map((row) => row.recipient_account_id),
            [writer.credentials.accountId],
          );
          assert.equal(
            (await list(author)).unreadCount,
            1,
            'Post ownership does not add a reply recipient',
          );
          assert.equal(
            (await list(saver)).unreadCount,
            1,
            'Saving does not fan out replies',
          );
          assert.ok(
            (await receipts(addressedReply))
              .filter((row) => row.channel === 'external')
              .every(
                (row) =>
                  row.outcome === 'unavailable' &&
                  row.code === 'external_unavailable',
              ),
          );
          const selfRoot = await publishRoot(
            author,
            postId,
            'Synthetic self post-author root',
          );
          await materialize(selfRoot);
          assert.ok(
            !(await persisted(selfRoot)).some(
              (row) =>
                row.recipient_account_id === author.credentials.accountId,
            ),
          );
          assert.ok(
            (await persisted(selfRoot)).every((row) => row.reason === 'saved'),
          );
        },
      );

      await t.test(
        'preference history prevents old-event backfill after enable or disable/re-enable, while fresh events qualify',
        async () => {
          const parent = await publishPost(
            author,
            'Synthetic preference-history fence',
          );
          for (const actor of [saver, muted, resaver])
            await saved(actor, parent, true);
          await saved(muted, parent, false, 'saved');
          const oldRoot = await publishRoot(
            writer,
            parent,
            'Synthetic queued before new preference eligibility',
          );
          await saved(muted, parent, true, 'saved');
          await saved(saver, parent, false, 'saved');
          await saved(saver, parent, true, 'saved');
          await saved(resaver, parent, false);
          await saved(resaver, parent, true);
          const outcome = await materialize(oldRoot);
          assert.equal(outcome.materialized, 1);
          assert.deepEqual(
            (await persisted(oldRoot)).map((row) => row.recipient_account_id),
            [author.credentials.accountId],
          );
          for (const actor of [saver, muted, resaver])
            assert.ok(
              (await receipts(oldRoot)).some(
                (row) =>
                  row.recipient_account_id === actor.credentials.accountId &&
                  row.channel === 'in_app' &&
                  row.outcome === 'suppressed',
              ),
            );
          const newRoot = await publishRoot(
            writer,
            parent,
            'Synthetic fresh event after new preference eligibility',
          );
          assert.equal((await materialize(newRoot)).materialized, 4);
          assert.deepEqual(
            (await persisted(newRoot))
              .map((row) => row.recipient_account_id)
              .sort(),
            [author, saver, muted, resaver]
              .map((actor) => actor.credentials.accountId)
              .sort(),
          );
          assert.equal((await materialize(oldRoot)).alreadyProcessed, 1);
          assert.equal((await persisted(oldRoot)).length, 1);
        },
      );

      await t.test(
        'database failure after notice inserts rolls back receipts/read rows; restart and concurrent retries settle once',
        async () => {
          const isolated = await publishPost(
            author,
            'Synthetic crash recovery parent',
          );
          const root = await publishRoot(
            writer,
            isolated,
            'Synthetic crash rollback after notice insert',
          );
          const id = await eventId(root);
          await pool.query(`CREATE FUNCTION whaleu_community_test.fail_updates_settlement() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_id='${id}'::uuid THEN RAISE EXCEPTION 'synthetic settlement crash'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER synthetic_updates_crash BEFORE INSERT ON whaleu_notifications.event_receipts FOR EACH ROW EXECUTE FUNCTION whaleu_community_test.fail_updates_settlement()`);
          try {
            await assert.rejects(
              materialize(root),
              /synthetic settlement crash/,
            );
          } finally {
            await pool.query(
              'DROP TRIGGER synthetic_updates_crash ON whaleu_notifications.event_receipts; DROP FUNCTION whaleu_community_test.fail_updates_settlement()',
            );
          }
          assert.equal((await persisted(root)).length, 0);
          assert.equal((await receipts(root)).length, 0);
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_notifications.event_receipts WHERE event_id=$1',
                [id],
              )
            ).rowCount,
            0,
          );
          await app!.close();
          app = await startApp(port);
          const results = await Promise.all([
            materialize(root),
            materialize(root),
            materialize(root),
          ]);
          assert.equal(
            results.reduce((sum, result) => sum + result.materialized, 0),
            1,
          );
          assert.equal(
            results.reduce((sum, result) => sum + result.alreadyProcessed, 0),
            2,
          );
          assert.equal((await persisted(root)).length, 1);
          assert.equal(
            (await receipts(root)).length,
            2,
            'Exactly one in-app and external outcome',
          );
        },
      );
      await t.test(
        'registered native Page retrieves persisted rows, opens without reading, and explicit exact read reconciles response loss',
        async () => {
          const before = await list(author),
            selected = await findNotice(author, firstRoot);
          const current = mount(author);
          await until(
            () => current.data.loaded && !current.data.busy,
            'Updates Page load',
          );
          assert.equal(current.data.unreadCount, before.unreadCount);
          assert.deepEqual(current.data.items, before.items);
          const badgeViews: { unreadCount: number; loaded: boolean }[] = [];
          const badge = new UpdatesBadgeController(
            author.runtime,
            (view: { unreadCount: number; loaded: boolean }) =>
              badgeViews.push(view),
          );
          try {
            await badge.load();
            assert.equal(badgeViews.at(-1)!.unreadCount, before.unreadCount);
            assert.equal(badgeViews.at(-1)!.loaded, true);
          } finally {
            badge.dispose();
          }
          assert.ok(current.data.items.every((item) => item.readAt === null));
          const readRequests = () =>
            transport.exchanges.filter(
              (exchange) =>
                exchange.method === 'PUT' && exchange.path.endsWith('/read'),
            ).length;
          const readsBefore = readRequests();
          const opened = navigations.length;
          current.onOpen(click(selected.noticeId));
          await until(
            () => navigations.length === opened + 1 && !current.data.busy,
            'notice open navigation',
          );
          assert.equal(
            navigations.at(-1),
            `/pages/community-detail/community-detail?postId=${postId}&rootCommentId=${firstRoot}`,
          );
          assert.equal(
            readRequests(),
            readsBefore,
            'Opening is not explicit read nor delivery acknowledgment',
          );
          assert.equal(
            (await author.community.updatesUnread(cancel)).unreadCount,
            before.unreadCount,
          );
          transport.dropSuccess = {
            path: `/v1/me/community/updates/${selected.noticeId}/read`,
            method: 'PUT',
          };
          current.onRead(click(selected.noticeId));
          await until(
            () =>
              !current.data.busy && current.data.status.includes('尚未确认'),
            'lost committed read response',
          );
          assert.equal(
            current.data.items.find(
              (item) => item.noticeId === selected.noticeId,
            )!.readAt,
            null,
            'Unknown response cannot claim success',
          );
          const committed = (await persisted(firstRoot)).find(
            (row) => row.id === selected.noticeId,
          )!;
          assert.ok(committed.read_at);
          assert.equal(
            (await author.community.updatesUnread(cancel)).unreadCount,
            before.unreadCount - 1,
          );
          current.onRead(click(selected.noticeId));
          await until(
            () =>
              !current.data.busy &&
              current.data.items.find(
                (item) => item.noticeId === selected.noticeId,
              )?.readAt !== null,
            'same exact read retry',
          );
          assert.equal(
            current.data.items.find(
              (item) => item.noticeId === selected.noticeId,
            )!.readAt,
            committed.read_at.toISOString(),
          );
          assert.equal(current.data.unreadCount, before.unreadCount - 1);
          const reread = await author.community.readUpdate(
            selected.noticeId,
            cancel,
          );
          assert.deepEqual(reread, {
            noticeId: selected.noticeId,
            readAt: committed.read_at.toISOString(),
            unreadCount: before.unreadCount - 1,
          });
          assert.equal(
            (await findNotice(saver, firstRoot)).readAt,
            null,
            'Different recipient owns an independent notice/read state',
          );
          for (const id of [selected.noticeId, randomUUID()]) {
            await assert.rejects(
              outsider.community.readUpdate(id, cancel),
              clientFailure('http', 404, 'NOTICE_NOT_FOUND'),
            );
            await assert.rejects(
              outsider.community.updateTarget(id, cancel),
              clientFailure('http', 404, 'NOTICE_NOT_FOUND'),
            );
          }
          assert.equal(
            storage.size,
            0,
            'Updates and private identity stay out of persistent native storage',
          );
          const one: UpdatesPage = await author.community.updates(
            null,
            cancel,
            1,
          );
          assert.ok(one.nextCursor);
          const two: UpdatesPage = await author.community.updates(
            one.nextCursor,
            cancel,
            1,
          );
          assert.ok(
            !two.items.some((item) => item.noticeId === one.items[0]!.noticeId),
          );
          await assert.rejects(
            saver.community.updates(one.nextCursor, cancel, 1),
            clientFailure('business', 400, 'BAD_REQUEST'),
          );
          await assert.rejects(
            author.community.updates(one.nextCursor, cancel, 2),
            clientFailure('business', 400, 'BAD_REQUEST'),
          );
        },
      );

      await t.test(
        'real late read response cannot repopulate the Page or badge after account replacement',
        async () => {
          const current = mount(author);
          await until(
            () => current.data.loaded && !current.data.busy,
            'owner Page before delayed response',
          );
          const unread = current.data.items.find(
            (item) => item.readAt === null,
          )!;
          assert.ok(unread);
          let deliver: (() => void) | undefined;
          transport.interceptResponse = (path, method, release) => {
            if (
              path === `/v1/me/community/updates/${unread.noticeId}/read` &&
              method === 'PUT'
            ) {
              deliver = release;
              return true;
            }
            return false;
          };
          try {
            current.onRead(click(unread.noticeId));
            await until(
              () => !!deliver,
              'real committed read held in transport',
            );
            author.sessions.completeLogin(
              author.sessions.beginLogin(),
              saver.credentials,
            );
            assert.deepEqual(current.data.items, []);
            assert.equal(current.data.unreadCount, 0);
            assert.equal(current.data.loaded, false);
            assert.deepEqual(current.data.identityOverlay.items, {});
            deliver!();
            await delay(20);
            assert.deepEqual(current.data.items, []);
            assert.equal(current.data.loaded, false);
            assert.equal(current.data.unreadCount, 0);
            await current.controller!.load();
            assert.deepEqual(current.data.items, (await list(saver)).items);
            assert.equal(
              current.data.unreadCount,
              (await list(saver)).unreadCount,
            );
          } finally {
            transport.interceptResponse = null;
            deliver?.();
            author.sessions.completeLogin(
              author.sessions.beginLogin(),
              author.credentials,
            );
          }
          current.onHide();
          assert.deepEqual(current.data.items, []);
          assert.equal(current.data.loaded, false);
          assert.deepEqual(current.data.identityOverlay.items, {});
        },
      );

      await t.test(
        'actual delayed unread-count response is fenced by the native badge account epoch',
        async () => {
          const views: { unreadCount: number; loaded: boolean }[] = [];
          const badge = new UpdatesBadgeController(
            writer.runtime,
            (view: { unreadCount: number; loaded: boolean }) =>
              views.push(view),
          );
          let deliver: (() => void) | undefined;
          transport.interceptResponse = (path, _method, release) => {
            if (path === '/v1/me/community/updates/unread-count') {
              deliver = release;
              return true;
            }
            return false;
          };
          try {
            const loading = badge.load();
            await until(() => !!deliver, 'held real unread-count response');
            writer.sessions.completeLogin(
              writer.sessions.beginLogin(),
              outsider.credentials,
            );
            assert.equal(views.at(-1)!.loaded, false);
            assert.equal(views.at(-1)!.unreadCount, 0);
            deliver!();
            await loading;
            assert.equal(views.at(-1)!.loaded, false);
            assert.equal(views.at(-1)!.unreadCount, 0);
            transport.interceptResponse = null;
            await badge.load();
            assert.equal(views.at(-1)!.loaded, true);
            assert.equal(
              views.at(-1)!.unreadCount,
              (await outsider.community.updatesUnread(cancel)).unreadCount,
            );
          } finally {
            transport.interceptResponse = null;
            deliver?.();
            badge.dispose();
            writer.sessions.completeLogin(
              writer.sessions.beginLogin(),
              writer.credentials,
            );
          }
        },
      );

      await t.test(
        'fresh authorized locator opens exact root and reply targets beyond ordinary first pages',
        async () => {
          const parent = await publishPost(
            author,
            'Synthetic off-page locator parent',
          );
          const root = await publishRoot(
            writer,
            parent,
            'Synthetic oldest off-page root',
          );
          const explicit = await publishReply(
            author,
            parent,
            root,
            'Synthetic author explicit target',
          );
          for (let index = 0; index < 21; index++) {
            await publishRoot(author, parent, `Synthetic newer root ${index}`);
            await publishReply(
              outsider,
              parent,
              root,
              `Synthetic earlier reply ${index}`,
            );
          }
          const reply = await publishReply(
            outsider,
            parent,
            root,
            'Synthetic exact off-page new reply',
            explicit,
          );
          await materialize(root, reply);
          const ordinaryRoots: {
            items: CommentView[];
            nextCursor: string | null;
          } = await author.community.comments(parent, null, cancel, {
            sort: 'time',
            order: 'desc',
          });
          const ordinaryReplies: {
            items: ReplyView[];
            nextCursor: string | null;
          } = await author.community.replies(root, null, cancel);
          assert.equal(ordinaryRoots.items.length, 10);
          assert.equal(ordinaryReplies.items.length, 20);
          assert.ok(ordinaryRoots.nextCursor && ordinaryReplies.nextCursor);
          assert.ok(!ordinaryRoots.items.some((item) => item.id === root));
          assert.ok(!ordinaryReplies.items.some((item) => item.id === reply));
          const current = mount(author);
          await until(
            () => current.data.loaded && !current.data.busy,
            'off-page Updates load',
          );
          for (const [contentId, isReply] of [
            [root, false],
            [reply, true],
          ] as const) {
            const notice = await findNotice(author, contentId),
              start = transport.exchanges.length;
            const nav = navigations.length;
            current.onOpen(click(notice.noticeId));
            await until(
              () => navigations.length === nav + 1 && !current.data.busy,
              'fresh authorized locator navigation',
            );
            const paths = transport.exchanges
              .slice(start)
              .map((exchange) => exchange.path);
            assert.equal(
              paths[0],
              `/v1/me/community/updates/${notice.noticeId}/target`,
            );
            assert.ok(
              paths.some((path) => path === `/v1/community/posts/${parent}`),
            );
            assert.ok(
              paths.some(
                (path) =>
                  path.includes(
                    `/v1/community/posts/${parent}/discussion-context`,
                  ) &&
                  path.includes(
                    `${isReply ? 'replyId' : 'commentId'}=${contentId}`,
                  ),
              ),
            );
            assert.ok(!paths.some((path) => path.endsWith('/read')));
            assert.equal(
              navigations.at(-1),
              isReply
                ? `/pages/community-thread/community-thread?postId=${parent}&rootCommentId=${root}&replyId=${reply}`
                : `/pages/community-detail/community-detail?postId=${parent}&rootCommentId=${root}`,
            );
          }
          const detailViews: {
            loaded: boolean;
            comments: CommentView[];
            locatedComment: CommentView | null;
          }[] = [];
          const detail = new DetailController(
            author.runtime,
            parent,
            (view: {
              loaded: boolean;
              comments: CommentView[];
              locatedComment: CommentView | null;
            }) => detailViews.push(view),
            () => undefined,
            { commentId: root },
          );
          const threadViews: {
            loaded: boolean;
            replies: ReplyView[];
            locatedReply: ReplyView | null;
          }[] = [];
          const thread = new ThreadController(
            author.runtime,
            parent,
            root,
            reply,
            (view: {
              loaded: boolean;
              replies: ReplyView[];
              locatedReply: ReplyView | null;
            }) => threadViews.push(view),
          );
          try {
            await detail.load();
            assert.equal(detailViews.at(-1)!.loaded, true);
            assert.equal(detailViews.at(-1)!.locatedComment!.id, root);
            assert.ok(
              !detailViews.at(-1)!.comments.some((item) => item.id === root),
            );
            await thread.load();
            assert.equal(threadViews.at(-1)!.loaded, true);
            assert.equal(threadViews.at(-1)!.locatedReply!.id, reply);
            assert.ok(
              !threadViews.at(-1)!.replies.some((item) => item.id === reply),
            );
          } finally {
            detail.dispose();
            thread.dispose();
          }
          assert.equal((await findNotice(author, root)).readAt, null);
          assert.equal((await findNotice(author, reply)).readAt, null);
        },
      );
      await t.test(
        'current block and hidden-parent policy replaces old previews with a minimal unavailable row without losing exact unread state',
        async () => {
          const notice = await findNotice(author, firstRoot);
          const current = mount(author);
          await until(
            () => current.data.loaded && !current.data.busy,
            'visible Updates before block',
          );
          const count = (await author.community.updatesUnread(cancel))
            .unreadCount;
          await pool.query(
            'INSERT INTO whaleu_community_test.blocks(viewer,author) VALUES($1,$2)',
            [author.credentials.accountId, writer.credentials.accountId],
          );
          try {
            const before = navigations.length;
            current.onOpen(click(notice.noticeId));
            await until(
              () =>
                !current.data.busy &&
                current.data.items.find(
                  (item) => item.noticeId === notice.noticeId,
                )?.status === 'unavailable',
              'fresh block-aware target check',
            );
            assert.equal(navigations.length, before);
            const row = (await list(author)).items.find(
              (item) => item.noticeId === notice.noticeId,
            )!;
            assert.deepEqual(row, {
              noticeId: notice.noticeId,
              createdAt: notice.createdAt,
              readAt: notice.readAt,
              status: 'unavailable',
            });
            assert.deepEqual(
              await author.community.updateTarget(notice.noticeId, cancel),
              { noticeId: notice.noticeId, status: 'unavailable' },
            );
            assert.equal(
              (await author.community.updatesUnread(cancel)).unreadCount,
              count,
            );
            assert.ok(!JSON.stringify(row).includes(firstRoot));
            assert.ok(!JSON.stringify(row).includes('Synthetic'));
          } finally {
            await pool.query(
              'DELETE FROM whaleu_community_test.blocks WHERE viewer=$1',
              [author.credentials.accountId],
            );
          }
          const saverNotice = await findNotice(saver, firstRoot);
          await pool.query(
            "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
            [postId],
          );
          try {
            const hidden = (await list(saver)).items.find(
              (item) => item.noticeId === saverNotice.noticeId,
            )!;
            assert.deepEqual(hidden, {
              noticeId: saverNotice.noticeId,
              createdAt: saverNotice.createdAt,
              readAt: null,
              status: 'unavailable',
            });
            assert.deepEqual(
              await saver.community.updateTarget(saverNotice.noticeId, cancel),
              { noticeId: saverNotice.noticeId, status: 'unavailable' },
            );
            const total = (await saver.community.updatesUnread(cancel))
              .unreadCount;
            const read = await saver.community.readUpdate(
              saverNotice.noticeId,
              cancel,
            );
            assert.equal(
              read.unreadCount,
              total - 1,
              'Owner can explicitly clear one unavailable row',
            );
          } finally {
            await pool.query(
              "UPDATE whaleu_community.posts SET visibility='approved' WHERE id=$1",
              [postId],
            );
          }
          const live = await findNotice(saver, firstRoot);
          assert.ok(live.readAt);
          assert.equal(
            live.preview.text,
            'Synthetic root requiring real persisted Updates',
          );
        },
      );

      await t.test(
        'ordinary anonymous Updates stay persona-safe and native developer overlay is separately audited and transient',
        async () => {
          const parent = await publishPost(
            developer,
            'Synthetic separately audited overlay parent',
          );
          const anonymous = await publishRoot(
            writer,
            parent,
            'Synthetic anonymous Updates author',
            'anonymous',
          );
          await materialize(anonymous);
          const ordinary = await findNotice(developer, anonymous);
          assert.equal(ordinary.preview.author.kind, 'anonymous');
          noPrivateFields(ordinary);
          const beforeAudit = (
            await pool.query<{ count: number }>(
              'SELECT count(*)::integer AS count FROM whaleu_authorization.identity_view_audit WHERE actor_account_id=$1',
              [developer.credentials.accountId],
            )
          ).rows[0]!.count;
          // Disposable synthetic test role only; never grant any runtime/user privilege.
          await pool.query(
            "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,approved_by_account_id,approval_reference) VALUES($1,$2,'developer',$2,'synthetic-updates-bridge-fixture-only')",
            [randomUUID(), developer.credentials.accountId],
          );
          const current = mount(developer);
          await until(
            () => !!current.data.identityOverlay.items[anonymous],
            'separate audited developer overlay',
          );
          assert.equal(current.data.identityOverlay.developerEnabled, true);
          assert.equal(
            current.data.identityOverlay.items[anonymous]!.accountId,
            writer.credentials.accountId,
          );
          assert.deepEqual(current.data.items, [ordinary]);
          assert.deepEqual(
            await findNotice(developer, anonymous),
            ordinary,
            'Private overlay never mutates ordinary DTO',
          );
          const audits = await pool.query<{
            target_kind: string;
            target_id: string;
            disclosed_fields: string[];
            outcome: string;
          }>(
            'SELECT target_kind,target_id,disclosed_fields,outcome FROM whaleu_authorization.identity_view_audit WHERE actor_account_id=$1',
            [developer.credentials.accountId],
          );
          assert.equal(audits.rows.length, beforeAudit + 1);
          assert.equal(audits.rows.at(-1)!.target_kind, 'comment');
          assert.equal(audits.rows.at(-1)!.target_id, anonymous);
          assert.equal(audits.rows.at(-1)!.outcome, 'disclosed');
          assert.ok(audits.rows.at(-1)!.disclosed_fields.includes('accountId'));
          assert.equal(storage.size, 0);
          developer.sessions.completeLogin(
            developer.sessions.beginLogin(),
            outsider.credentials,
          );
          assert.deepEqual(current.data.identityOverlay.items, {});
          assert.equal(current.data.identityOverlay.developerEnabled, false);
          assert.deepEqual(current.data.items, []);
          developer.sessions.completeLogin(
            developer.sessions.beginLogin(),
            developer.credentials,
          );
          current.onShow();
          await until(
            () => !!current.data.identityOverlay.items[anonymous],
            'overlay restored under fresh owner read',
          );
          current.onHide();
          assert.deepEqual(current.data.identityOverlay.items, {});
          assert.deepEqual(current.data.items, []);
          assert.equal(current.data.loaded, false);
          const nonDeveloper = mount(author);
          const identityCalls = () =>
            transport.exchanges.filter(
              (exchange) =>
                exchange.path === '/v1/identity-privacy/content-identities',
            ).length;
          const initial = identityCalls();
          await until(
            () => nonDeveloper.data.loaded && !nonDeveloper.data.busy,
            'ordinary account Page',
          );
          await delay(20);
          assert.equal(
            identityCalls(),
            initial,
            'Ordinary role does not call private identity hydration',
          );
          assert.deepEqual(nonDeveloper.data.identityOverlay.items, {});
          assert.equal(
            nonDeveloper.data.identityOverlay.developerEnabled,
            false,
          );
          nonDeveloper.onUnload();
        },
      );

      await t.test(
        'explicit local automatic mode materializes newly published events into the real Page while pre-enable backlog stays untouched',
        async () => {
          const parent = await publishPost(
            author,
            'Synthetic bounded automatic dispatcher parent',
          );
          const old = await publishRoot(
            writer,
            parent,
            'Synthetic pre-enable retained event',
          );
          assert.equal((await persisted(old)).length, 0);
          assert.equal(
            (await author.community.postUpdatePreferences(parent, cancel))
              .inAppProcessing,
            'manual_only',
          );
          page?.onHide();
          await app!.close();
          app = await startApp(port, 'automatic');
          try {
            assert.equal(
              (await author.community.postUpdatePreferences(parent, cancel))
                .inAppProcessing,
              'automatic',
            );
            const fresh = await publishRoot(
              writer,
              parent,
              'Synthetic new event materialized by automatic local dispatcher',
            );
            const deadline = Date.now() + 5000;
            while ((await persisted(fresh)).length === 0) {
              assert.ok(
                Date.now() < deadline,
                'Automatic default real worker must create fresh notice',
              );
              await delay(25);
            }
            assert.equal((await persisted(fresh)).length, 1);
            assert.equal(
              (await persisted(old)).length,
              0,
              'Activation cannot adopt pre-enable local backlog',
            );
            const current = mount(author);
            await until(
              () => current.data.loaded && !current.data.busy,
              'automatic notice in real Updates Page',
            );
            const actual = available(
              current.data.items.find(
                (item) =>
                  item.status === 'available' &&
                  item.target.commentId === fresh,
              ),
            );
            assert.equal(
              actual.preview.text,
              'Synthetic new event materialized by automatic local dispatcher',
            );
            assert.equal(actual.readAt, null);
            assert.equal(
              (await receipts(fresh)).filter(
                (row) =>
                  row.channel === 'external' && row.outcome === 'unavailable',
              ).length,
              1,
            );
            current.onHide();
          } finally {
            await app!.close();
            app = await startApp(port);
          }
          assert.equal(
            (await persisted(old)).length,
            0,
            'Restart does not silently re-enroll retained backlog',
          );
          assert.equal(
            (await author.community.postUpdatePreferences(parent, cancel))
              .inAppProcessing,
            'manual_only',
          );
        },
      );

      await t.test(
        'automatically eligible publication queued before the first tick survives restart and materializes exactly once',
        async () => {
          const parent = await publishPost(
            author,
            'Synthetic automatic restart parent',
          );
          const manual = await publishRoot(
            writer,
            parent,
            'Synthetic manual event permanently excluded',
          );
          page?.onHide();
          await app!.close();
          // The real timer is configured long enough to stop before its first tick.
          app = await startApp(port, 'automatic', 60000);
          try {
            const queued = await publishRoot(
              writer,
              parent,
              'Synthetic automatic event queued before shutdown',
            );
            const id = await eventId(queued);
            assert.deepEqual(
              (
                await pool.query<{ automatic_eligible: boolean }>(
                  'SELECT automatic_eligible FROM whaleu_community.local_update_events WHERE event_id=$1',
                  [id],
                )
              ).rows,
              [{ automatic_eligible: true }],
            );
            assert.equal((await persisted(queued)).length, 0);
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_notifications.automatic_work WHERE event_id=$1',
                  [id],
                )
              ).rowCount,
              0,
              'Event is durably source-enrolled before dispatcher discovery',
            );
            await app!.close();
            app = await startApp(port, 'automatic');
            await untilDatabase(
              async () => (await persisted(queued)).length === 1,
              'queued automatic event after restart',
            );
            await untilDatabase(
              async () =>
                (
                  await pool.query<{ state: string }>(
                    'SELECT state FROM whaleu_notifications.automatic_work WHERE event_id=$1',
                    [id],
                  )
                ).rows[0]?.state === 'completed',
              'automatic work settlement',
            );
            const persistedOnce = await persisted(queued);
            assert.equal(
              (await receipts(queued)).filter(
                (row) =>
                  row.channel === 'in_app' && row.outcome === 'materialized',
              ).length,
              1,
            );
            const current = mount(author);
            await until(
              () => current.data.loaded && !current.data.busy,
              'restart-recovered notice in native Page',
            );
            assert.equal(
              available(
                current.data.items.find(
                  (item) =>
                    item.status === 'available' &&
                    item.target.commentId === queued,
                ),
              ).readAt,
              null,
            );
            const count = current.data.unreadCount;
            current.onHide();
            await app!.close();
            app = await startApp(port, 'automatic');
            // A newly completed event establishes that this restarted dispatcher ran.
            const probe = await publishRoot(
              writer,
              parent,
              'Synthetic restart exactly-once probe',
            );
            await untilDatabase(
              async () => (await persisted(probe)).length === 1,
              'restarted dispatcher positive probe',
            );
            assert.deepEqual(await persisted(queued), persistedOnce);
            assert.equal(
              (await author.community.updatesUnread(cancel)).unreadCount,
              count + 1,
            );
            assert.equal((await persisted(manual)).length, 0);
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_notifications.automatic_work WHERE event_id=$1',
                  [await eventId(manual)],
                )
              ).rowCount,
              0,
              'Manual event is not silently enrolled by discovery or restart',
            );
          } finally {
            await app!.close();
            app = await startApp(port);
          }
        },
      );

      await t.test(
        'temporary unavailable materialization remains durably pending through shutdown and recovers once after real backoff',
        async () => {
          const parent = await publishPost(
            author,
            'Synthetic unavailable automatic retry parent',
          );
          page?.onHide();
          await app!.close();
          app = await startApp(port, 'automatic', 60000);
          let removedGrant = false;
          try {
            const queued = await publishRoot(
              writer,
              parent,
              'Synthetic queued automatic transient authority failure',
            );
            const id = await eventId(queued);
            await pool.query(
              'DELETE FROM whaleu_community_test.grants WHERE account_id=$1 AND space_id=$2',
              [author.credentials.accountId, spaceId],
            );
            removedGrant = true;
            await app!.close();
            app = await startApp(port, 'automatic');
            await untilDatabase(
              async () =>
                (
                  await pool.query(
                    'SELECT 1 FROM whaleu_notifications.retryable_attempts WHERE event_id=$1',
                    [id],
                  )
                ).rowCount === 1,
              'durable unavailable processing attempt',
            );
            const retry = (
              await pool.query<{
                attempts: number;
                code: string;
                next_attempt_at: Date;
              }>(
                'SELECT attempts,code,next_attempt_at FROM whaleu_notifications.retryable_attempts WHERE event_id=$1',
                [id],
              )
            ).rows[0]!;
            assert.equal(retry.attempts, 1);
            assert.equal(retry.code, 'authority_unavailable');
            assert.equal((await persisted(queued)).length, 0);
            assert.equal(
              (await receipts(queued)).length,
              0,
              'Unavailable attempt cannot settle partial recipient outcomes',
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT 1 FROM whaleu_notifications.event_receipts WHERE event_id=$1',
                  [id],
                )
              ).rowCount,
              0,
              'Unavailable attempt is not a terminal event receipt',
            );
            assert.equal(
              (
                await pool.query<{ state: string }>(
                  'SELECT state FROM whaleu_notifications.automatic_work WHERE event_id=$1',
                  [id],
                )
              ).rows[0]!.state,
              'pending',
            );
            await app!.close();
            await grant(
              pool,
              author.credentials.accountId,
              spaceId,
              verified(region),
            );
            removedGrant = false;
            app = await startApp(port, 'automatic');
            assert.equal(
              (
                await pool.query<{ state: string }>(
                  'SELECT state FROM whaleu_notifications.automatic_work WHERE event_id=$1',
                  [id],
                )
              ).rows[0]!.state,
              'pending',
            );
            assert.equal(
              (await persisted(queued)).length,
              0,
              'Restart respects the persisted retry backoff',
            );
            await untilDatabase(
              async () => (await persisted(queued)).length === 1,
              'restored authority automatic retry after restart',
              10000,
            );
            assert.ok(
              Date.now() >= retry.next_attempt_at.getTime(),
              'Real persisted backoff elapsed; test never rewrote retry clocks',
            );
            await untilDatabase(
              async () =>
                (
                  await pool.query<{ state: string }>(
                    'SELECT state FROM whaleu_notifications.automatic_work WHERE event_id=$1',
                    [id],
                  )
                ).rows[0]?.state === 'completed',
              'retry work completion',
            );
            const once = await persisted(queued);
            assert.equal((await receipts(queued)).length, 2);
            assert.equal(
              (await receipts(queued)).filter(
                (row) =>
                  row.channel === 'external' && row.outcome === 'unavailable',
              ).length,
              1,
            );
            const current = mount(author);
            await until(
              () => current.data.loaded && !current.data.busy,
              'retried real notice in native Page',
            );
            assert.equal(
              available(
                current.data.items.find(
                  (item) =>
                    item.status === 'available' &&
                    item.target.commentId === queued,
                ),
              ).preview.text,
              'Synthetic queued automatic transient authority failure',
            );
            current.onHide();
            await app!.close();
            app = await startApp(port, 'automatic');
            const probe = await publishRoot(
              writer,
              parent,
              'Synthetic retry exactly-once restart probe',
            );
            await untilDatabase(
              async () => (await persisted(probe)).length === 1,
              'dispatcher after recovered retry restart',
            );
            assert.deepEqual(await persisted(queued), once);
            assert.equal(
              (
                await pool.query<{ attempts: number }>(
                  'SELECT attempts FROM whaleu_notifications.retryable_attempts WHERE event_id=$1',
                  [id],
                )
              ).rows[0]!.attempts,
              1,
            );
          } finally {
            if (removedGrant)
              await grant(
                pool,
                author.credentials.accountId,
                spaceId,
                verified(region),
              );
            await app!.close();
            app = await startApp(port);
          }
        },
      );

      await t.test(
        'old unenrolled outbox obligations cannot be adopted later or repaired into local provenance',
        async () => {
          const id = randomUUID(),
            resource = randomUUID();
          await pool.query(
            "INSERT INTO whaleu_community.outbox(id,event_key,event_type,resource_id) VALUES($1,$2,'comment_created',$3)",
            [id, `synthetic-unenrolled:${id}`, resource],
          );
          await assert.rejects(
            pool.query(
              "INSERT INTO whaleu_community.local_update_events(event_id,origin,automatic_eligible) VALUES($1,'local_publication',true)",
              [id],
            ),
            { code: '23514' },
          );
          await assert.rejects(
            pool.query(
              'UPDATE whaleu_community.outbox SET local_creation_transaction=pg_current_xact_id() WHERE id=$1',
              [id],
            ),
            { code: '23514' },
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.local_update_events WHERE event_id=$1',
                [id],
              )
            ).rowCount,
            0,
          );
          const attempt = await app!
            .get(UpdatesWorker)
            .run({ mode: 'apply', eventIds: [id] });
          assert.equal(attempt.unavailable, 1);
          assert.equal(attempt.materialized, 0);
          assert.deepEqual(
            (
              await pool.query<{ outcome: string; code: string }>(
                'SELECT outcome,code FROM whaleu_notifications.event_receipts WHERE event_id=$1',
                [id],
              )
            ).rows,
            [{ outcome: 'unavailable', code: 'local_provenance_unavailable' }],
          );
        },
      );

      await t.test(
        'two-connection enrollment allocates order after the advisory lock, preserving committed discovery order',
        async () => {
          const first = await pool.connect(),
            second = await pool.connect();
          let waiting:
            | Promise<import('pg').QueryResult<{ enrollment_order: string }>>
            | undefined;
          try {
            await first.query('BEGIN');
            await second.query('BEGIN');
            await first.query(
              "SELECT pg_advisory_xact_lock(hashtextextended('community-update-enrollment',0))",
            );
            const a = randomUUID(),
              b = randomUUID();
            await first.query(
              "INSERT INTO whaleu_community.outbox(id,event_key,event_type,resource_id) VALUES($1,$2,'comment_created',$3)",
              [a, `synthetic-order:${a}`, randomUUID()],
            );
            await second.query(
              "INSERT INTO whaleu_community.outbox(id,event_key,event_type,resource_id) VALUES($1,$2,'comment_created',$3)",
              [b, `synthetic-order:${b}`, randomUUID()],
            );
            const pid = (
              await second.query<{ pid: number }>(
                'SELECT pg_backend_pid() AS pid',
              )
            ).rows[0]!.pid;
            waiting = second.query<{ enrollment_order: string }>(
              "INSERT INTO whaleu_community.local_update_events(event_id,origin,automatic_eligible) VALUES($1,'local_publication',false) RETURNING enrollment_order",
              [b],
            );
            await untilDatabase(
              async () =>
                (
                  await pool.query(
                    "SELECT 1 FROM pg_locks WHERE pid=$1 AND locktype='advisory' AND NOT granted",
                    [pid],
                  )
                ).rowCount === 1,
              'second enrollment waiting for first transaction',
            );
            const aOrder = (
              await first.query<{ enrollment_order: string }>(
                "INSERT INTO whaleu_community.local_update_events(event_id,origin,automatic_eligible) VALUES($1,'local_publication',false) RETURNING enrollment_order",
                [a],
              )
            ).rows[0]!.enrollment_order;
            await first.query('COMMIT');
            const bOrder = (await waiting).rows[0]!.enrollment_order;
            await second.query('COMMIT');
            assert.ok(
              BigInt(bOrder) > BigInt(aOrder),
              'Blocked transaction must allocate after lock, never before the first commit',
            );
          } finally {
            await first.query('ROLLBACK');
            await waiting?.catch(() => undefined);
            await second.query('ROLLBACK');
            first.release();
            second.release();
          }
        },
      );

      await t.test(
        'native decoders reject private fields and corruption in actual HTTP rows; all external work stays unavailable or suppressed',
        async () => {
          const result = await list(writer),
            item = available(
              result.items.find(
                (row) => row.status === 'available' && row.kind === 'reply',
              ),
            );
          const read = await writer.community.readUpdate(item.noticeId, cancel);
          const target = await writer.community.updateTarget(
            item.noticeId,
            cancel,
          );
          for (const operation of [
            () =>
              decodeUpdatesList({
                ...result,
                accountId: writer.credentials.accountId,
              }),
            () => decodeUpdatesList({ ...result, items: [item, item] }),
            () =>
              decodeCommunityUpdate({
                ...item,
                preview: {
                  ...item.preview,
                  accountId: writer.credentials.accountId,
                },
              }),
            () => decodeCommunityUpdate({ ...item, reason: 'saved' }),
            () =>
              decodeCommunityUpdate({
                noticeId: item.noticeId,
                createdAt: item.createdAt,
                readAt: null,
                status: 'unavailable',
                preview: item.preview,
              }),
            () => decodeUpdateRead({ ...read, delivered: true }),
            () =>
              decodeResolvedUpdateTarget({
                ...target,
                recipientAccountId: writer.credentials.accountId,
              }),
          ])
            assert.throws(operation, { kind: 'protocol' });
          const outcome = await pool.query<{
            channel: string;
            outcome: string;
          }>(
            'SELECT channel,outcome FROM whaleu_notifications.processing_receipts',
          );
          assert.ok(outcome.rows.some((row) => row.channel === 'external'));
          assert.ok(
            outcome.rows
              .filter((row) => row.channel === 'external')
              .every((row) =>
                ['suppressed', 'unavailable'].includes(row.outcome),
              ),
          );
          const columns = (
            await pool.query<{ column_name: string }>(
              "SELECT column_name FROM information_schema.columns WHERE table_schema='whaleu_notifications' AND table_name='notices'",
            )
          ).rows.map((row) => row.column_name);
          assert.ok(
            !columns.some((column) =>
              /text|body|preview|persona|student|phone|provider|delivered|quota/.test(
                column,
              ),
            ),
            'No frozen content/private identity/provider delivery state in notice rows',
          );
          assert.equal(
            providerExchanges,
            actors.length,
            'Synthetic sign-ins only; updates invoke no provider login/delivery',
          );
          assert.equal(
            storage.size,
            0,
            'No persistent notice or developer-identity snapshots',
          );
          assert.ok(
            transport.exchanges
              .filter((exchange) =>
                exchange.path.includes('/community/updates'),
              )
              .every((exchange) => exchange.authorized),
          );
        },
      );
    } finally {
      page?.onUnload();
      for (const [key, previous] of Object.entries(previousGlobals)) {
        if (previous.owned) globals[key] = previous.value;
        else delete globals[key];
      }
      try {
        await app?.close();
      } finally {
        try {
          if (ownsSchemas) {
            for (const schema of [
              'whaleu_community_test',
              'whaleu_notifications',
              'whaleu_verification',
              'whaleu_authorization',
              'whaleu_community',
              'whaleu_profile',
              'whaleu_campus',
              'whaleu_identity',
              'whaleu_meta',
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
