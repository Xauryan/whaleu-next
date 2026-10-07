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
  PostView,
  PublicationReceipt,
  PublishPost,
} from '../../src/community/contracts.js';
import type {
  SavedPage,
  SavedReceipt,
  SavedStatus,
  PostUpdatePreferences,
  UpdateChannel,
} from '../../src/community/saved/contracts.js';
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
  fixtureSchema,
  grant,
  verified,
} from '../support/community-fixtures.js';

// Execute actual native gateways, decoders and durable intent journals. Only
// platform I/O and unavailable production authorities are synthetic test adapters.
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
  HttpProfileGateway,
} = require('../../../wechat/src/profile/gateway.ts');
const {
  PendingSavedStore,
} = require('../../../wechat/src/community/saved-pending.ts');
const {
  decodeSavedReceipt,
  decodeSavedList,
  decodeSavedStatuses,
} = require('../../../wechat/src/community/saved-contract.ts');

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

function applied(
  receipt: SavedReceipt,
  postId: string,
  desired: boolean,
  channel: UpdateChannel | null = null,
): SavedReceipt {
  assert.deepEqual(receipt, {
    requestId: receipt.requestId,
    operation:
      channel === null ? 'set_post_saved' : 'set_post_update_preference',
    postId,
    desired,
    channel,
    outcome: 'applied',
  });
  assert.ok(Object.isFrozen(receipt), 'Actual native receipt decoder ran');
  return receipt;
}
function rejected(receipt: SavedReceipt, code: string): void {
  assert.equal(receipt.outcome, 'rejected');
  assert.ok(receipt.outcome === 'rejected');
  assert.equal(receipt.code, code);
  assert.deepEqual(Object.keys(receipt).sort(), [
    'channel',
    'code',
    'desired',
    'operation',
    'outcome',
    'postId',
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
        'studentNumber',
        'phone',
        'wechat',
        'qq',
        'contacts',
        'savers',
        'saverIds',
        'saverAccountIds',
        'savedBy',
        'recipientAccountId',
        'recipient_account_id',
        'sessionId',
        'identities',
        'creation_transaction',
        'publication_transaction',
        'notification',
        'delivered',
      ].includes(key),
      `Ordinary DTO contains private/delivery field ${key}`,
    );
    noPrivateFields(child);
  }
}
function memoryStorage() {
  const values = new Map<string, unknown>();
  return {
    get: (key: string) => structuredClone(values.get(key)),
    set: (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    },
    remove: (key: string) => {
      values.delete(key);
    },
  };
}

test(
  'real native Saved gateway, Nest HTTP and PostgreSQL contract',
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
      WECHAT_APP_SECRET: 'synthetic-local-saved-contract-only',
      AUTH_RATE_LIMIT_KEY: 'bc'.repeat(32),
    });
    const pool = new Pool(poolOptions(config));
    let suite: PoolClient | undefined;
    let locked = false,
      ownsSchemas = false;
    let app: INestApplication | undefined;
    const authorization = new FixtureAuthorization(),
      visibility = new FixtureVisibility();
    let providerExchanges = 0;
    const startApp = async (port = 0): Promise<INestApplication> => {
      const module = await Test.createTestingModule({
        imports: [AppModule.register(config)],
      })
        .overrideProvider(IDENTITY_PROVIDER)
        .useValue({
          exchange: async (code: string) => {
            providerExchanges++;
            return {
              provider: 'wechat',
              appId: 'synthetic-native-saved',
              subject: code,
            };
          },
        })
        .overrideProvider(COMMUNITY_AUTHORIZATION)
        .useValue(authorization)
        .overrideProvider(COMMUNITY_VISIBILITY)
        .useValue(visibility)
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
          credentials,
          sessions,
          auth,
          api,
          community: new HttpCommunityGateway(api),
          profile: new HttpProfileGateway(api),
        };
      };
      type Actor = Awaited<ReturnType<typeof makeClient>>;
      const author = await makeClient('synthetic-saved-author'),
        anonymous = await makeClient('synthetic-saved-anonymous'),
        saver = await makeClient('synthetic-saved-reader'),
        other = await makeClient('synthetic-saved-other');
      const region = randomUUID(),
        secondRegion = randomUUID(),
        spaceId = randomUUID(),
        secondSpaceId = randomUUID();
      for (const [id, regionId] of [
        [spaceId, region],
        [secondSpaceId, secondRegion],
      ] as const) {
        await pool.query(
          "INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES($1,'Synthetic Saved Region',true)",
          [regionId],
        );
        await pool.query(
          "INSERT INTO whaleu_community.spaces(id,kind,name,is_active,operating_region_id) VALUES($1,'regional','Synthetic Saved Space',true,$2)",
          [id, regionId],
        );
        for (const actor of [author, anonymous, saver, other])
          await grant(
            pool,
            actor.credentials.accountId,
            id,
            verified(regionId),
          );
      }
      const privateContacts = {
        wechat: 'SyntheticPrivateWechat',
        qq: 'SyntheticPrivateQQ',
        phone: 'SyntheticPrivatePhone',
      };
      const publish = async (
        overrides: Partial<PublishPost> = {},
        actor = author,
      ): Promise<string> => {
        const intent = publishPostSchema.parse({
          clientRequestId: randomUUID(),
          spaceId,
          category: 'discussion',
          authorMode: 'named',
          text: '合成收藏正文🐳',
          imageAssetIds: [],
          commentsPolicy: 'open',
          component: { kind: 'none' },
          ...overrides,
        });
        if (
          intent.trading ||
          (intent.component && intent.component.kind !== 'none')
        )
          await approvePoll(pool, actor.credentials.accountId, intent);
        else await approve(pool, actor.credentials.accountId, intent.text);
        const receipt: PublicationReceipt = await actor.community.publishPost(
          intent,
          cancel,
        );
        assert.ok(receipt.outcome === 'created', JSON.stringify(receipt));
        return receipt.resourceId;
      };
      const plain = await publish();
      const poll = await publish({
        component: {
          kind: 'poll',
          question: '合成投票',
          selectionMode: 'single',
          options: ['甲', '乙'],
        },
      });
      const urgent = await publish({
        category: 'trading',
        trading: {
          subtype: 'shuma',
          price: '120.25',
          urgency: 'urgent',
          location: '合成交易地点',
          contacts: privateContacts,
        },
      });
      const formation = await publish(
        {
          category: 'companions',
          authorMode: 'anonymous',
          component: {
            kind: 'formation',
            capacity: 3,
            theme: '合成组队',
            contacts: { ...privateContacts, phone: 'PrivatePhone' },
            contactSharing: 'members_v1',
          },
        },
        anonymous,
      );
      const secondScope = await publish({ spaceId: secondSpaceId });
      const ids = [plain, poll, urgent, formation, secondScope];
      const initialSaveReceipts = new Map<string, SavedReceipt>();
      const anonymousOwn = await anonymous.profile.profile(cancel);
      await anonymous.profile.updateProfile(
        { expectedRevision: anonymousOwn.revision, nickname: 'SyntheticAnon' },
        cancel,
      );
      const anonymousProfile = (
        await pool.query<{ id: string }>(
          'SELECT public_id AS id FROM whaleu_profile.profiles WHERE account_id=$1',
          [anonymous.credentials.accountId],
        )
      ).rows[0]!.id;
      const privateValues = [
        anonymous.credentials.accountId,
        anonymousProfile,
        ...Object.values(privateContacts),
        'PrivatePhone',
      ];
      transport.checkResponse = (path, _status, body) => {
        if (!path.includes('/community/')) return;
        noPrivateFields(body);
        for (const value of privateValues)
          assert.ok(
            !JSON.stringify(body).includes(value),
            'Ordinary projections and receipts do not disclose anonymous identities or contacts',
          );
      };
      const intent = (
        postId: string,
        desired: boolean,
        channel: UpdateChannel | null = null,
        clientRequestId: string = randomUUID(),
      ) => ({
        clientRequestId,
        operation:
          channel === null ? 'set_post_saved' : 'set_post_update_preference',
        postId,
        desired,
        channel,
      });
      const set = async (
        actor: Actor,
        postId: string,
        desired: boolean,
        channel: UpdateChannel | null = null,
        requestId: string = randomUUID(),
      ): Promise<SavedReceipt> =>
        actor.community.applySaved(
          intent(postId, desired, channel, requestId),
          cancel,
        );
      const status = async (
        actor: Actor,
        postId: string,
      ): Promise<Extract<SavedStatus, { status: 'available' }>> => {
        const result: { items: SavedStatus[] } =
          await actor.community.savedStatuses([postId], cancel);
        assert.equal(result.items.length, 1);
        const state = result.items[0]!;
        assert.ok(state.status === 'available');
        return state;
      };
      const preferences = async (
        actor: Actor,
        postId: string,
      ): Promise<PostUpdatePreferences> =>
        actor.community.postUpdatePreferences(postId, cancel);
      const list = async (
        actor: Actor,
        after: string | null = null,
        limit = 20,
      ): Promise<SavedPage> => actor.community.saved(after, cancel, limit);
      const ownRow = async (actor: Actor, postId: string) =>
        (
          await pool.query<{
            epoch_id: string | null;
            saved_at: Date | null;
            revision: string;
          }>(
            'SELECT epoch_id,saved_at,revision FROM whaleu_community.saved_posts WHERE account_id=$1 AND post_id=$2',
            [actor.credentials.accountId, postId],
          )
        ).rows[0];
      const rowCounts = async () =>
        (
          await pool.query<{
            epochs: number;
            obligations: number;
            events: number;
          }>(
            "SELECT (SELECT count(*)::integer FROM whaleu_community.saved_epochs) AS epochs,(SELECT count(*)::integer FROM whaleu_community.saved_obligations) AS obligations,(SELECT count(*)::integer FROM whaleu_community.outbox WHERE event_type IN ('post_saved','post_unsaved')) AS events",
          )
        ).rows[0]!;
      const raw = (
        actor: Actor,
        path: string,
        method: string,
        body?: unknown,
        query?: Record<string, string | number>,
        decode: (value: unknown) => unknown = decodeSavedReceipt,
      ) =>
        actor.api.request(
          {
            path,
            method,
            authentication: 'required',
            authReplay: 'never',
            successStatus: 200,
            decode,
          },
          {
            ...(body === undefined ? {} : { body }),
            ...(query ? { query } : {}),
            cancellation: cancel,
          },
        );
      const cleanup = (
        actor: Actor,
        postId: string,
        channel: UpdateChannel | null = null,
        requestId: string = randomUUID(),
      ): Promise<SavedReceipt> =>
        raw(
          actor,
          channel === null
            ? `/v1/me/community/saved/${postId}`
            : `/v1/me/community/post-update-preferences/${postId}/${channel}`,
          'DELETE',
          { clientRequestId: requestId },
        );

      await t.test(
        'defaults, own state and exact counts include every component, urgent resolved trading and entitled scopes',
        async () => {
          assert.deepEqual(await list(saver), {
            items: [],
            nextCursor: null,
            visibleSavedCount: 0,
          });
          for (const id of ids) {
            const before = await status(saver, id);
            assert.equal(before.isSaved, false);
            assert.equal(before.saveCount, 0);
            assert.equal(before.savedAt, null);
            assert.equal(before.saveEpochId, null);
            assert.deepEqual(before.preferences, {
              postId: id,
              savedUpdatesEnabled: true,
              externalUpdatesEnabled: true,
              revision: '0',
              canSetPreference: true,
              reason: null,
              inAppCapability: 'local',
              inAppProcessing: 'manual_only',
              externalCapability: 'unavailable',
            });
            initialSaveReceipts.set(
              id,
              applied(await set(saver, id, true), id, true),
            );
          }
          // Author-self saving is allowed and creates only one active relationship.
          applied(await set(author, plain, true), plain, true);
          applied(await set(other, plain, true), plain, true);
          await author.community.setTradingResolution(
            urgent,
            'resolved',
            randomUUID(),
            cancel,
          );
          const page = await list(saver);
          assert.equal(page.visibleSavedCount, 5);
          assert.equal(page.nextCursor, null);
          assert.deepEqual(
            page.items.map((item) => item.post.id),
            ids.toReversed(),
          );
          assert.ok(
            Object.isFrozen(page) && Object.isFrozen(page.items[0]!.post),
          );
          const byId = new Map(
            page.items.map((item) => [item.post.id, item.post]),
          );
          assert.equal(byId.get(plain)!.component.kind, 'none');
          assert.equal(byId.get(poll)!.component.kind, 'poll');
          assert.equal(byId.get(formation)!.component.kind, 'formation');
          assert.equal(byId.get(formation)!.author.kind, 'anonymous');
          assert.equal(byId.get(urgent)!.trading!.urgency, 'urgent');
          assert.equal(byId.get(urgent)!.trading!.resolution, 'resolved');
          for (const id of ids) {
            const state = await status(saver, id),
              detail: PostView = await saver.community.post(id, cancel);
            assert.equal(state.saveCount, id === plain ? 3 : 1);
            assert.equal(state.isSaved, true);
            assert.equal(detail.saveCount, state.saveCount);
            assert.equal(detail.viewer.isSaved, true);
            assert.equal(byId.get(id)!.saveCount, state.saveCount);
            assert.equal(detail.viewer.canSave, true);
          }
          const feed = await saver.community.feed(
            { spaceId, category: 'trading' },
            cancel,
          );
          assert.equal(feed.items[0].id, urgent);
          assert.equal(feed.items[0].saveCount, 1);
          assert.equal(feed.items[0].viewer.isSaved, true);
          assert.equal((await list(other)).visibleSavedCount, 1);
          assert.equal((await status(other, poll)).isSaved, false);
          const ownEpoch = (await ownRow(author, plain))!.epoch_id;
          const selfObligations = (
            await pool.query<{ action: string; status: string }>(
              'SELECT action,status FROM whaleu_community.saved_obligations WHERE epoch_id=$1',
              [ownEpoch],
            )
          ).rows;
          assert.deepEqual(selfObligations.map((row) => row.action).sort(), [
            'author_interactions',
            'save_ranking',
            'saver_reward',
          ]);
          assert.ok(selfObligations.every((row) => row.status === 'pending'));
        },
      );

      await t.test(
        'pagination binds account and page size and exact totals use the same visible set',
        async () => {
          const first = await list(saver, null, 2);
          assert.equal(first.visibleSavedCount, 5);
          assert.equal(first.items.length, 2);
          assert.ok(first.nextCursor);
          const next = await list(saver, first.nextCursor, 2);
          assert.equal(next.visibleSavedCount, 5);
          assert.equal(next.items.length, 2);
          assert.ok(next.nextCursor);
          const last = await list(saver, next.nextCursor, 2);
          assert.equal(last.visibleSavedCount, 5);
          assert.equal(last.items.length, 1);
          assert.equal(last.nextCursor, null);
          assert.deepEqual(
            [...first.items, ...next.items, ...last.items].map(
              (item) => item.post.id,
            ),
            ids.toReversed(),
          );
          for (const read of [
            () => list(other, first.nextCursor, 2),
            () => list(saver, first.nextCursor, 3),
          ])
            await assert.rejects(
              read(),
              clientFailure('business', 400, 'BAD_REQUEST'),
            );
          assert.ok(
            (await list(saver)).items.some(
              (item) => item.post.space.id === secondSpaceId,
            ),
            'Saved spans accessible scopes independently of browsing selection',
          );
        },
      );

      await t.test(
        'save no-ops preserve epoch, order and obligations; unsave/re-save starts exactly one fresh epoch',
        async () => {
          const original = await ownRow(saver, plain),
            before = await rowCounts(),
            beforePage = await list(saver);
          const first = applied(await set(saver, plain, true), plain, true);
          applied(await set(saver, plain, true), plain, true);
          assert.deepEqual(await ownRow(saver, plain), original);
          assert.deepEqual(await rowCounts(), before);
          assert.deepEqual(
            (await list(saver)).items.map((item) => item.post.id),
            beforePage.items.map((item) => item.post.id),
          );
          applied(await set(saver, plain, false), plain, false);
          const inactive = await status(saver, plain);
          assert.equal(inactive.isSaved, false);
          assert.equal(inactive.saveCount, 2);
          assert.equal(inactive.savedAt, null);
          assert.equal(inactive.saveEpochId, null);
          const afterUnsave = await rowCounts(),
            unsaved = await ownRow(saver, plain);
          applied(await set(saver, plain, false), plain, false);
          assert.deepEqual(await rowCounts(), afterUnsave);
          assert.deepEqual(await ownRow(saver, plain), unsaved);
          applied(await set(saver, plain, true), plain, true);
          const fresh = await ownRow(saver, plain);
          assert.notEqual(fresh!.epoch_id, original!.epoch_id);
          assert.ok(BigInt(fresh!.revision) > BigInt(original!.revision));
          assert.equal((await list(saver)).items[0]!.post.id, plain);
          const epochs = (
            await pool.query<{ id: string; ended_sequence: string | null }>(
              'SELECT id,ended_sequence FROM whaleu_community.saved_epochs WHERE account_id=$1 AND post_id=$2 ORDER BY started_sequence',
              [saver.credentials.accountId, plain],
            )
          ).rows;
          assert.equal(epochs.length, 2);
          assert.ok(epochs[0]!.ended_sequence);
          assert.equal(epochs[1]!.ended_sequence, null);
          assert.deepEqual(
            await saver.community.savedReceipt(first.requestId, cancel),
            first,
          );
          const after = await rowCounts();
          assert.equal(after.epochs - before.epochs, 1);
          assert.equal(after.events - before.events, 2);
          assert.equal(after.obligations - before.obligations, 6);
        },
      );

      await t.test(
        'the two preferences, default restoration and global banner remain independent across save cycles',
        async () => {
          const ownProfile = await saver.profile.profile(cancel);
          const profile = await saver.profile.updatePreferences(
            {
              expectedRevision: ownProfile.revision,
              preferences: { showOfficialAccountTip: false },
            },
            cancel,
          );
          const beforeCounts = await rowCounts();
          applied(await set(saver, poll, false, 'saved'), poll, false, 'saved');
          let state = await preferences(saver, poll);
          assert.equal(state.savedUpdatesEnabled, false);
          assert.equal(state.externalUpdatesEnabled, true);
          const revision = state.revision;
          applied(await set(saver, poll, false, 'saved'), poll, false, 'saved');
          assert.equal((await preferences(saver, poll)).revision, revision);
          applied(
            await set(saver, poll, false, 'external'),
            poll,
            false,
            'external',
          );
          state = await preferences(saver, poll);
          assert.equal(state.savedUpdatesEnabled, false);
          assert.equal(state.externalUpdatesEnabled, false);
          assert.ok(BigInt(state.revision) > BigInt(revision));
          assert.equal(
            (await status(saver, poll)).saveCount,
            1,
            'Bookmark-only still counts as saved',
          );
          assert.deepEqual(
            await rowCounts(),
            beforeCounts,
            'Preference changes create no save/reward/ranking transition',
          );
          applied(await set(saver, poll, false), poll, false);
          applied(await set(saver, poll, true), poll, true);
          assert.deepEqual(
            await preferences(saver, poll),
            state,
            'Unsave/re-save preserves both preferences and their revision',
          );
          applied(
            await set(saver, poll, true, 'external'),
            poll,
            true,
            'external',
          );
          const externalOnly = await preferences(saver, poll);
          assert.equal(externalOnly.savedUpdatesEnabled, false);
          assert.equal(externalOnly.externalUpdatesEnabled, true);
          applied(await set(saver, poll, true, 'saved'), poll, true, 'saved');
          state = await preferences(saver, poll);
          assert.equal(state.savedUpdatesEnabled, true);
          assert.equal(state.externalUpdatesEnabled, true);
          assert.notEqual(state.revision, '0');
          const retained = (
            await pool.query<{ count: number }>(
              'SELECT count(*)::integer AS count FROM whaleu_community.post_update_preference_history WHERE account_id=$1 AND post_id=$2',
              [saver.credentials.accountId, poll],
            )
          ).rows[0]!.count;
          assert.equal(
            retained,
            4,
            'Returning to logical defaults retains independent history; repeated same values do not add history',
          );
          assert.deepEqual(
            await saver.profile.profile(cancel),
            profile,
            'Saved interactions do not change banner or unrelated global settings',
          );
          const otherPreferences = await preferences(other, poll);
          assert.equal(otherPreferences.revision, '0');
          assert.equal(otherPreferences.savedUpdatesEnabled, true);
          assert.equal(otherPreferences.externalUpdatesEnabled, true);
          const unsavedOwn = await publish();
          applied(
            await set(author, unsavedOwn, false, 'external'),
            unsavedOwn,
            false,
            'external',
          );
          assert.equal(
            (await status(author, unsavedOwn)).isSaved,
            false,
            'An author can set a visible post preference without saving first',
          );
          assert.equal(
            (await preferences(author, unsavedOwn)).savedUpdatesEnabled,
            true,
          );
        },
      );

      await t.test(
        'real committed response loss survives native and Nest restarts before opposite saves or either preference',
        async () => {
          for (const channel of [null, 'saved', 'external'] as const) {
            const postId = await publish();
            if (channel !== null)
              applied(
                await set(saver, postId, false, channel),
                postId,
                false,
                channel,
              );
            const storage = memoryStorage(),
              journal = new PendingSavedStore(storage, nativeOrigin);
            const attempt = journal.freeze({
              version: 1,
              accountId: saver.credentials.accountId,
              ...intent(postId, true, channel),
            });
            assert.ok(Object.isFrozen(attempt));
            assert.equal(journal.load(other.credentials.accountId), null);
            await assert.rejects(
              saver.community.savedReceipt(attempt.clientRequestId, cancel),
              clientFailure('http', 404, 'REQUEST_NOT_FOUND'),
            );
            assert.deepEqual(
              journal.load(saver.credentials.accountId),
              attempt,
              'Receipt absence does not release an unresolved intent',
            );
            assert.throws(
              () =>
                journal.freeze({
                  ...attempt,
                  clientRequestId: randomUUID(),
                  desired: false,
                }),
              { kind: 'storage' },
            );
            transport.dropSuccess = {
              path: `/v1/community/posts/${postId}/${channel === null ? 'save' : 'update-preferences'}`,
              method: 'PUT',
            };
            await assert.rejects(
              set(saver, postId, true, channel, attempt.clientRequestId),
              { kind: 'network' },
            );
            assert.equal(
              transport.exchanges.at(-1)!.status,
              200,
              'Mutation committed before its success response was lost',
            );
            assert.deepEqual(
              journal.load(saver.credentials.accountId),
              attempt,
            );
            if (channel === null)
              assert.equal((await status(saver, postId)).isSaved, true);
            else
              assert.equal(
                (await preferences(saver, postId))[
                  channel === 'saved'
                    ? 'savedUpdatesEnabled'
                    : 'externalUpdatesEnabled'
                ],
                true,
              );
            await app!.close();
            app = undefined;
            app = await startApp(port);
            const restored = await makeClient(
                'unused-restored-saver',
                saver.credentials,
              ),
              reloaded = new PendingSavedStore(storage, nativeOrigin);
            assert.deepEqual(
              reloaded.load(saver.credentials.accountId),
              attempt,
            );
            const beforeRead = transport.exchanges.length;
            const receipt: SavedReceipt = await restored.community.savedReceipt(
              attempt.clientRequestId,
              cancel,
            );
            applied(receipt, postId, true, channel);
            reloaded.settle(attempt, receipt);
            assert.equal(reloaded.load(saver.credentials.accountId), null);
            assert.deepEqual(
              transport.exchanges
                .slice(beforeRead)
                .map((exchange) => exchange.method),
              ['GET'],
              'Recovery reads only; it never repeats the mutation',
            );
            applied(
              await set(restored, postId, false, channel),
              postId,
              false,
              channel,
            );
            const current =
                channel === null
                  ? await ownRow(restored, postId)
                  : await preferences(restored, postId),
              counts = await rowCounts();
            assert.deepEqual(
              await set(
                restored,
                postId,
                true,
                channel,
                attempt.clientRequestId,
              ),
              receipt,
            );
            assert.deepEqual(
              await restored.community.savedReceipt(
                attempt.clientRequestId,
                cancel,
              ),
              receipt,
            );
            assert.deepEqual(
              channel === null
                ? await ownRow(restored, postId)
                : await preferences(restored, postId),
              current,
              'Replaying first intent cannot undo the later opposite value or its revision',
            );
            assert.deepEqual(await rowCounts(), counts);
            await assert.rejects(
              set(restored, postId, false, channel, attempt.clientRequestId),
              clientFailure('business', 409, 'REQUEST_CONFLICT'),
            );
            await assert.rejects(
              set(restored, plain, true, channel, attempt.clientRequestId),
              clientFailure('business', 409, 'REQUEST_CONFLICT'),
            );
            await assert.rejects(
              set(
                restored,
                postId,
                true,
                channel === null ? 'saved' : null,
                attempt.clientRequestId,
              ),
              clientFailure('business', 409, 'REQUEST_CONFLICT'),
            );
            await assert.rejects(
              other.community.savedReceipt(attempt.clientRequestId, cancel),
              clientFailure('http', 404, 'REQUEST_NOT_FOUND'),
            );
            // A client request UUID is account-scoped, not a global grant or handle.
            applied(
              await set(other, postId, true, channel, attempt.clientRequestId),
              postId,
              true,
              channel,
            );
            assert.deepEqual(
              channel === null
                ? await ownRow(restored, postId)
                : await preferences(restored, postId),
              current,
            );
          }
        },
      );

      await t.test(
        'native recovery controller settles historical receipts without painting old intent over current state',
        async () => {
          const {
            SavedMutationController,
          } = require('../../../wechat/src/community/saved-controller.ts');
          const postId = await publish(),
            storage = memoryStorage(),
            pendingSaved = new PendingSavedStore(storage, nativeOrigin);
          const attempt = pendingSaved.freeze({
            version: 1,
            accountId: saver.credentials.accountId,
            ...intent(postId, true),
          });
          applied(
            await set(saver, postId, true, null, attempt.clientRequestId),
            postId,
            true,
          );
          // Another independently serialized device may already have sent its opposite.
          applied(await set(saver, postId, false), postId, false);
          const views: {
            frozen: boolean;
            preferences: PostUpdatePreferences | null;
            receiptStatus: string;
          }[] = [];
          let settlements = 0;
          const controller = new SavedMutationController(
            {
              sessions: saver.sessions,
              gateway: saver.community,
              pendingSaved,
              newRequestId: async () => randomUUID(),
            },
            (view: (typeof views)[number]) => views.push(view),
            () => {
              settlements++;
            },
          );
          t.after(() => controller.dispose());
          await controller.load(await saver.community.post(postId, cancel));
          assert.equal(views.at(-1)!.frozen, true);
          const before = transport.exchanges.length;
          await controller.recover();
          assert.equal(views.at(-1)!.frozen, false);
          assert.equal(
            views.at(-1)!.preferences,
            null,
            'Receipt settlement clears cached preferences pending a live reread',
          );
          assert.equal(settlements, 1);
          assert.equal(pendingSaved.load(saver.credentials.accountId), null);
          assert.deepEqual(
            transport.exchanges
              .slice(before)
              .map((exchange) => exchange.method),
            ['GET'],
          );
          assert.equal((await status(saver, postId)).isSaved, false);
          const failedStorage = {
            get: () => undefined,
            set: () => {
              throw new Error('Synthetic disk full');
            },
            remove: () => undefined,
          };
          const blocked = new SavedMutationController(
            {
              sessions: saver.sessions,
              gateway: saver.community,
              pendingSaved: new PendingSavedStore(failedStorage, nativeOrigin),
              newRequestId: async () => randomUUID(),
            },
            () => undefined,
          );
          t.after(() => blocked.dispose());
          const current = await saver.community.post(postId, cancel),
            beforeFailure = transport.exchanges.length;
          await blocked.setSaved(current, true);
          assert.equal(
            transport.exchanges.length,
            beforeFailure,
            'Failure to durably freeze blocks network dispatch',
          );
          assert.equal((await status(saver, postId)).isSaved, false);
        },
      );

      await t.test(
        'strict batch/list inputs and actor-free bodies reject extras before writing',
        async () => {
          const before = (
            await pool.query<{ count: number }>(
              'SELECT count(*)::integer AS count FROM whaleu_community.saved_requests',
            )
          ).rows[0]!.count;
          const postPath = `/v1/community/posts/${plain}/save`,
            preferencePath = `/v1/community/posts/${plain}/update-preferences`;
          for (const [path, method, body] of [
            [
              postPath,
              'PUT',
              {
                clientRequestId: randomUUID(),
                accountId: other.credentials.accountId,
              },
            ],
            [
              postPath,
              'DELETE',
              { clientRequestId: randomUUID(), desired: false },
            ],
            [
              preferencePath,
              'PUT',
              { clientRequestId: randomUUID(), channel: 'all', enabled: true },
            ],
            [
              preferencePath,
              'PUT',
              {
                clientRequestId: randomUUID(),
                channel: 'saved',
                enabled: 'true',
              },
            ],
            [
              preferencePath,
              'PUT',
              {
                clientRequestId: randomUUID(),
                channel: 'saved',
                enabled: true,
                externalUpdatesEnabled: false,
              },
            ],
          ] as const)
            await assert.rejects(
              raw(saver, path, method, body),
              clientFailure('business', 400, 'BAD_REQUEST'),
            );
          for (const postIds of [
            [],
            [plain, plain],
            [plain, plain.toUpperCase()],
            ['invalid'],
            Array.from({ length: 101 }, () => randomUUID()),
          ]) {
            await assert.rejects(
              raw(
                saver,
                '/v1/me/community/saved/status',
                'POST',
                { postIds },
                undefined,
                decodeSavedStatuses,
              ),
              clientFailure('business', 400, 'BAD_REQUEST'),
            );
          }
          for (const query of [
            { limit: 0 },
            { limit: 51 },
            { limit: 2, accountId: other.credentials.accountId },
            { limit: 2, category: 'trading' },
          ])
            await assert.rejects(
              raw(
                saver,
                '/v1/me/community/saved',
                'GET',
                undefined,
                query,
                decodeSavedList,
              ),
              clientFailure('business', 400, 'BAD_REQUEST'),
            );
          assert.equal(
            (
              await pool.query<{ count: number }>(
                'SELECT count(*)::integer AS count FROM whaleu_community.saved_requests',
              )
            ).rows[0]!.count,
            before,
          );
          const batchIds = [
            ...ids,
            ...Array.from({ length: 95 }, () => randomUUID()),
          ];
          const statuses: { items: SavedStatus[] } =
            await saver.community.savedStatuses(batchIds, cancel);
          assert.equal(statuses.items.length, 100);
          assert.deepEqual(
            statuses.items.map((item) => item.postId),
            batchIds,
          );
          assert.ok(
            statuses.items
              .slice(ids.length)
              .every((item) => item.status === 'unavailable'),
          );
          const beforeNative = transport.exchanges.length;
          await assert.rejects(
            saver.community.savedStatuses([plain, plain], cancel),
            { kind: 'protocol' },
          );
          await assert.rejects(saver.community.saved(null, cancel, 51), {
            kind: 'protocol',
          });
          assert.equal(
            transport.exchanges.length,
            beforeNative,
            'Native argument validation does not issue malformed requests',
          );
        },
      );

      await t.test(
        'read access is independent of phone/student publication gates, while each write rechecks its dedicated action',
        async () => {
          await grant(pool, saver.credentials.accountId, spaceId, {
            ...verified(region),
            studentVerified: false,
            identityRegionId: null,
            unverifiedCommentsAllowed: false,
          });
          applied(await set(saver, urgent, true), urgent, true);
          applied(
            await set(saver, urgent, false, 'external'),
            urgent,
            false,
            'external',
          );
          await grant(pool, saver.credentials.accountId, spaceId, {
            ...verified(region),
            phoneVerified: false,
          });
          assert.equal((await status(saver, urgent)).isSaved, true);
          assert.equal(
            (await preferences(saver, urgent)).reason,
            'PHONE_VERIFICATION_REQUIRED',
          );
          assert.equal(
            (await preferences(saver, urgent)).canSetPreference,
            false,
          );
          rejected(
            await set(saver, urgent, false),
            'PHONE_VERIFICATION_REQUIRED',
          );
          rejected(
            await set(saver, urgent, true, 'external'),
            'PHONE_VERIFICATION_REQUIRED',
          );
          await grant(pool, saver.credentials.accountId, spaceId, {
            ...verified(region),
            restrictedActions: ['save_post'],
          });
          rejected(
            await set(saver, urgent, false),
            'COMMUNITY_ACTION_RESTRICTED',
          );
          applied(
            await set(saver, urgent, true, 'external'),
            urgent,
            true,
            'external',
          );
          await grant(pool, saver.credentials.accountId, spaceId, {
            ...verified(region),
            restrictedActions: ['set_post_update_preference'],
          });
          applied(await set(saver, urgent, true), urgent, true);
          rejected(
            await set(saver, urgent, false, 'external'),
            'COMMUNITY_ACTION_RESTRICTED',
          );
          await grant(
            pool,
            saver.credentials.accountId,
            spaceId,
            verified(region),
          );
        },
      );

      await t.test(
        'current block, hidden, deleted and inactive-scope policy filters lists, batches and totals identically',
        async () => {
          await pool.query(
            'INSERT INTO whaleu_community_test.blocks(viewer,author) VALUES($1,$2)',
            [saver.credentials.accountId, author.credentials.accountId],
          );
          const blocked = await list(saver);
          assert.equal(blocked.visibleSavedCount, 1);
          assert.deepEqual(
            blocked.items.map((item) => item.post.id),
            [formation],
            'Anonymous creator keeps established persona-safe visibility policy',
          );
          assert.deepEqual(
            (await saver.community.savedStatuses([plain], cancel)).items,
            [{ postId: plain, status: 'unavailable' }],
          );
          rejected(await set(saver, plain, true), 'POST_NOT_FOUND');
          await assert.rejects(
            preferences(saver, plain),
            clientFailure('http', 404, 'POST_NOT_FOUND'),
          );
          await pool.query(
            'DELETE FROM whaleu_community_test.blocks WHERE viewer=$1',
            [saver.credentials.accountId],
          );
          applied(
            await set(saver, plain, false, 'external'),
            plain,
            false,
            'external',
          );
          await pool.query(
            "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
            [plain],
          );
          await author.community.deletePost(poll, cancel);
          await pool.query(
            'UPDATE whaleu_community.spaces SET is_active=false WHERE id=$1',
            [secondSpaceId],
          );
          const unavailable = [plain, poll, secondScope, randomUUID()];
          const batch = await saver.community.savedStatuses(
            unavailable,
            cancel,
          );
          assert.deepEqual(
            batch.items,
            unavailable.map((postId) => ({ postId, status: 'unavailable' })),
            'Hidden, deleted, inaccessible and missing parents share the same minimal projection',
          );
          const filtered = await list(saver, null, 1);
          assert.equal(filtered.visibleSavedCount, 2);
          assert.equal(filtered.items.length, 1);
          assert.ok(filtered.nextCursor);
          const last = await list(saver, filtered.nextCursor, 1);
          assert.equal(last.visibleSavedCount, 2);
          assert.equal(last.nextCursor, null);
          assert.deepEqual(
            [...filtered.items, ...last.items]
              .map((item) => item.post.id)
              .sort(),
            [urgent, formation].sort(),
          );
          assert.equal(
            (await list(author)).visibleSavedCount,
            0,
            'Hidden own content is not privileged in Saved browsing',
          );
          assert.equal(
            (await list(other)).items.some((item) => item.post.id === plain),
            false,
          );
          for (const postId of [plain, poll, secondScope]) {
            assert.ok(
              (await ownRow(saver, postId))!.epoch_id,
              'Filtering retains private save history',
            );
            rejected(await set(saver, postId, true), 'POST_NOT_FOUND');
            rejected(await set(saver, postId, true, 'saved'), 'POST_NOT_FOUND');
            await assert.rejects(
              preferences(saver, postId),
              clientFailure('http', 404, 'POST_NOT_FOUND'),
            );
          }
          assert.ok(
            visibility.seen
              .filter((subject) => subject.authorMode === 'anonymous')
              .every((subject) => !('namedAccountId' in subject)),
          );
        },
      );

      await t.test(
        'minimal original-account cleanup and immutable recovery survive parent, phone and scope loss',
        async () => {
          const before = await ownRow(other, plain);
          await grant(pool, saver.credentials.accountId, spaceId, {
            ...verified(region),
            phoneVerified: false,
            restrictedActions: ['save_post', 'set_post_update_preference'],
          });
          const cleanupSave = applied(
            await cleanup(saver, plain),
            plain,
            false,
          );
          const cleanupPreference = applied(
            await cleanup(saver, plain, 'saved'),
            plain,
            false,
            'saved',
          );
          assert.equal((await ownRow(saver, plain))!.epoch_id, null);
          assert.deepEqual(
            await ownRow(other, plain),
            before,
            'Cleanup cannot touch another account relation',
          );
          const stored = (
            await pool.query<{
              saved_updates_enabled: boolean;
              external_updates_enabled: boolean;
            }>(
              'SELECT saved_updates_enabled,external_updates_enabled FROM whaleu_community.post_update_preferences WHERE account_id=$1 AND post_id=$2',
              [saver.credentials.accountId, plain],
            )
          ).rows[0]!;
          assert.deepEqual(stored, {
            saved_updates_enabled: false,
            external_updates_enabled: false,
          });
          rejected(await cleanup(other, plain, 'saved'), 'POST_NOT_FOUND');
          rejected(
            await cleanup(other, randomUUID(), 'saved'),
            'POST_NOT_FOUND',
          );
          // A missing save cleanup is deliberately existence-neutral. No preview/count
          // is returned, whether the parent is absent or inaccessible.
          const missingId = randomUUID();
          applied(await cleanup(saver, missingId), missingId, false);
          applied(await cleanup(saver, poll), poll, false);
          applied(await cleanup(saver, secondScope), secondScope, false);
          await pool.query(
            'DELETE FROM whaleu_community_test.grants WHERE account_id=$1',
            [saver.credentials.accountId],
          );
          assert.deepEqual(
            await saver.community.savedReceipt(cleanupSave.requestId, cancel),
            cleanupSave,
          );
          assert.deepEqual(
            await saver.community.savedReceipt(
              cleanupPreference.requestId,
              cancel,
            ),
            cleanupPreference,
          );
          assert.deepEqual(
            await cleanup(saver, plain, null, cleanupSave.requestId),
            cleanupSave,
          );
          await assert.rejects(
            other.community.savedReceipt(cleanupSave.requestId, cancel),
            clientFailure('http', 404, 'REQUEST_NOT_FOUND'),
          );
          assert.equal((await ownRow(saver, plain))!.epoch_id, null);
          for (const postId of [plain, poll, secondScope]) {
            const original = initialSaveReceipts.get(postId)!;
            assert.deepEqual(
              await saver.community.savedReceipt(original.requestId, cancel),
              original,
            );
            assert.deepEqual(
              await set(saver, postId, true, null, original.requestId),
              original,
            );
            assert.equal(
              (await ownRow(saver, postId))!.epoch_id,
              null,
              'Recovery or immutable replay after parent/scope/authority loss never restores the old save',
            );
          }
        },
      );

      await t.test(
        'actual native Saved page keeps developer identities transient, separately authorized and audited',
        async () => {
          const {
            HttpIdentityPrivacyGateway,
            PrivateViewLifecycle,
          } = require('../../../wechat/src/identity-privacy/overlay.ts');
          const developerId = other.credentials.accountId,
            grantId = randomUUID();
          await pool.query(
            "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,approved_by_account_id,approval_reference) VALUES($1,$2,'developer',$2,'synthetic-saved-overlay-only')",
            [grantId, developerId],
          );
          applied(await set(other, formation, true), formation, true);
          const ordinary = await list(other);
          noPrivateFields(ordinary);
          assert.ok(
            !JSON.stringify(ordinary).includes(anonymous.credentials.accountId),
          );
          const privacy = new HttpIdentityPrivacyGateway(other.api);
          const denied = new HttpIdentityPrivacyGateway(author.api);
          await assert.rejects(
            denied.identities([{ kind: 'post', id: formation }], cancel),
            clientFailure('forbidden', 403, 'AUTHORIZATION_REQUIRED'),
          );
          type Overlay = {
            developerEnabled: boolean;
            items: Record<
              string,
              {
                accountId: string;
                nickname: string | null;
                studentNumber: string | null;
              }
            >;
            notice: string;
          };
          interface PageHarness {
            data: {
              items: SavedPage['items'];
              loaded: boolean;
              busy: boolean;
              identityOverlay: Overlay;
            };
            setData(patch: Record<string, unknown>): void;
            onShow(): void;
            onReload(): void;
            onHide(): void;
            onUnload(): void;
          }
          const observers = new Set<() => void>();
          let page: PageHarness | undefined;
          const globals = globalThis as unknown as {
            Page?: (value: unknown) => void;
            getApp?: () => unknown;
          };
          const previousPage = globals.Page,
            previousGetApp = globals.getApp;
          const runtime = {
            sessions: other.sessions,
            gateway: other.community,
            profiles: other.profile,
            identityPrivacy: privacy,
            privateViews: new PrivateViewLifecycle(),
            pendingSaved: new PendingSavedStore(memoryStorage(), nativeOrigin),
            newRequestId: async () => randomUUID(),
          };
          globals.Page = (value: unknown) => {
            page = value as PageHarness;
            page.setData = (patch) => {
              page!.data = { ...page!.data, ...patch };
              for (const notify of [...observers]) notify();
            };
          };
          globals.getApp = () => ({ community: runtime });
          const until = (predicate: () => boolean, message: string) =>
            new Promise<void>((resolve, reject) => {
              const timer = setTimeout(() => {
                observers.delete(inspect);
                reject(new Error(message));
              }, 5000);
              const inspect = () => {
                if (predicate()) {
                  clearTimeout(timer);
                  observers.delete(inspect);
                  resolve();
                }
              };
              observers.add(inspect);
              inspect();
            });
          try {
            // Execute the actual Page lifecycle and render closure, replacing only
            // native Page/getApp/setData platform hooks with this local test host.
            require('../../../wechat/src/pages/community-saved/community-saved.ts');
            assert.ok(page);
            page.onShow();
            await until(
              () => !!page!.data.identityOverlay.items[formation],
              'Saved overlay did not load',
            );
            assert.equal(page.data.identityOverlay.developerEnabled, true);
            assert.equal(
              page.data.identityOverlay.items[formation]!.accountId,
              anonymous.credentials.accountId,
            );
            assert.equal(
              page.data.identityOverlay.items[formation]!.nickname,
              'SyntheticAnon',
            );
            assert.equal(
              page.data.identityOverlay.items[formation]!.studentNumber,
              null,
            );
            noPrivateFields(page.data.items);
            assert.deepEqual(
              await list(other),
              ordinary,
              'Separate privileged view never mutates the ordinary Saved DTO',
            );
            const audits = async () =>
              (
                await pool.query<{ count: number }>(
                  "SELECT count(*)::integer AS count FROM whaleu_authorization.identity_view_audit WHERE actor_account_id=$1 AND target_kind='post' AND target_id=$2 AND outcome='disclosed'",
                  [developerId, formation],
                )
              ).rows[0]!.count;
            const firstAudit = await audits();
            assert.ok(
              firstAudit > 0,
              'Existing identity endpoint durably audits disclosure',
            );
            page.onReload();
            assert.deepEqual(
              page.data.identityOverlay.items,
              {},
              'Refresh clears private identities before starting its new list request',
            );
            await until(
              () => !!page!.data.identityOverlay.items[formation],
              'Saved overlay did not refresh',
            );
            assert.ok(
              (await audits()) > firstAudit,
              'Every refreshed identity view is reauthorized and audited',
            );
            await pool.query(
              "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
              [formation],
            );
            page.onReload();
            assert.deepEqual(page.data.identityOverlay.items, {});
            await until(
              () =>
                page!.data.loaded &&
                page!.data.identityOverlay.developerEnabled &&
                !page!.data.identityOverlay.items[formation],
              'Hidden Saved identity was retained',
            );
            assert.ok(
              !page.data.items.some((item) => item.post.id === formation),
            );
            const hidden = await privacy.identities(
              [{ kind: 'post', id: formation }],
              cancel,
            );
            assert.deepEqual(hidden, [
              {
                target: { kind: 'post', id: formation },
                status: 'unavailable',
              },
            ]);
            await pool.query(
              "UPDATE whaleu_community.posts SET visibility='approved' WHERE id=$1",
              [formation],
            );
            page.onReload();
            await until(
              () => !!page!.data.identityOverlay.items[formation],
              'Restored Saved target was not reauthorized',
            );
            other.sessions.completeLogin(
              other.sessions.beginLogin(),
              author.credentials,
            );
            assert.deepEqual(
              page.data.identityOverlay.items,
              {},
              'Account change clears transient identities synchronously',
            );
            assert.deepEqual(
              page.data.items,
              [],
              'Account change also clears the ordinary Saved window',
            );
            page.onHide();
            assert.deepEqual(page.data.identityOverlay.items, {});
          } finally {
            page?.onUnload();
            if (previousPage === undefined) delete globals.Page;
            else globals.Page = previousPage;
            if (previousGetApp === undefined) delete globals.getApp;
            else globals.getApp = previousGetApp;
            other.sessions.completeLogin(
              other.sessions.beginLogin(),
              other.credentials,
            );
            await pool.query(
              "UPDATE whaleu_community.posts SET visibility='approved' WHERE id=$1",
              [formation],
            );
            await pool.query(
              'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=$2 WHERE id=$1',
              [grantId, developerId],
            );
          }
          await assert.rejects(
            privacy.identities([{ kind: 'post', id: formation }], cancel),
            clientFailure('forbidden', 403, 'AUTHORIZATION_REQUIRED'),
          );
        },
      );

      await t.test(
        'all Saved obligations remain pending and no fabricated delivery, notification, contact or saver projection appears',
        async () => {
          const obligations = (
            await pool.query<{ status: string; action: string }>(
              'SELECT status,action FROM whaleu_community.saved_obligations',
            )
          ).rows;
          assert.ok(obligations.length > 0);
          assert.ok(obligations.every((row) => row.status === 'pending'));
          assert.ok(
            obligations.every((row) =>
              [
                'saver_reward',
                'author_reward',
                'author_interactions',
                'save_ranking',
              ].includes(row.action),
            ),
          );
          const receipts = (
            await pool.query<{ receipt: SavedReceipt }>(
              'SELECT receipt FROM whaleu_community.saved_requests',
            )
          ).rows;
          assert.ok(receipts.every((row) => row.receipt !== null));
          for (const { receipt } of receipts) {
            noPrivateFields(receipt);
            decodeSavedReceipt(receipt);
          }
          const events = (
            await pool.query<{ event_type: string; payload: unknown }>(
              "SELECT event_type,context AS payload FROM whaleu_community.outbox WHERE event_type IN ('post_saved','post_unsaved')",
            )
          ).rows;
          assert.ok(events.length > 0);
          for (const row of events) {
            const text = JSON.stringify(row.payload);
            for (const contact of Object.values(privateContacts))
              assert.ok(!text.includes(contact));
            assert.ok(!text.includes('delivered'));
            assert.ok(!text.includes('notification'));
          }
          assert.equal(
            providerExchanges,
            4,
            'Only synthetic fixture login exchanges occurred; saves/preferences/recovery never invoke identity providers',
          );
          assert.ok(
            transport.exchanges.every((exchange) =>
              exchange.path.startsWith('/v1/'),
            ),
          );
          assert.ok(
            !transport.exchanges.some((exchange) =>
              /notification|subscribe|template|push/.test(exchange.path),
            ),
            'No external enrollment or delivery endpoint is invoked',
          );
          const settings = await preferences(other, urgent);
          assert.equal(settings.inAppCapability, 'local');
          assert.equal(settings.externalCapability, 'unavailable');
        },
      );

      await t.test(
        'blocked accounts and revoked sessions cannot use minimal receipt or cleanup routes',
        async () => {
          await pool.query(
            "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
            [saver.credentials.accountId],
          );
          for (const work of [
            () => saver.community.savedReceipt(randomUUID(), cancel),
            () => cleanup(saver, plain),
            () => cleanup(saver, plain, 'saved'),
            () => list(saver),
          ])
            await assert.rejects(
              work(),
              clientFailure('forbidden', 403, 'ACCOUNT_BLOCKED'),
            );
          await other.auth.logout();
          const revoked = await makeClient(
              'unused-revoked-saved',
              other.credentials,
            ),
            before = transport.exchanges.length;
          await assert.rejects(
            cleanup(revoked, plain),
            clientFailure('auth-required', 401, 'SESSION_REVOKED'),
          );
          assert.equal(
            transport.exchanges.length,
            before + 1,
            'Revocation does not refresh or replay cleanup',
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
              'whaleu_notifications',
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
