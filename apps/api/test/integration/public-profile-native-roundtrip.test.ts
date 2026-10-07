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
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import type {
  PublishPost,
  PublishComment,
  PostView,
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
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { mintToken, hashToken } from '../../src/identity/tokens.js';
import {
  createRuntimeActor,
  setRuntimeVerification,
  postApprovalEnvelope,
  discussionApprovalEnvelope,
} from '../support/community-runtime-fixtures.js';
import {
  seedCommunityScope,
  appendIdentitySelection,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';
import {
  seedReviewPolicy,
  approveEnvelope,
  setReviewState,
} from '../support/community-approval-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

// Only native platform I/O is bridged to loopback. These are the real gateways,
// strict decoders, controllers and ordinary AppModule policy/owner providers.
// Test-only helpers establish canonical synthetic inputs, never substitute policy.
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
  HttpProfileGateway,
} = require('../../../wechat/src/profile/gateway.ts');
const {
  HttpDiscoveryGateway,
} = require('../../../wechat/src/profile/discovery-gateway.ts');
const {
  HttpCommunityGateway,
} = require('../../../wechat/src/community/gateway.ts');
const {
  HttpBlockGateway,
} = require('../../../wechat/src/community/block-gateway.ts');
const {
  createCommunityRuntime,
} = require('../../../wechat/src/community/runtime.ts');
const nativeOrigin = 'https://native-public-profile.invalid';

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
  corruptNext: { path: string; transform: (body: unknown) => unknown } | null =
    null;
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
                result = this.corruptNext.transform(result);
                this.corruptNext = null;
              }
              if (
                status === 200 &&
                (url.pathname.startsWith('/v1/profiles/') ||
                  url.pathname === '/v1/me/public-profile-ref' ||
                  url.pathname === '/v1/me/community/liked')
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

function protocolFailure(error: unknown): boolean {
  assert.ok(error instanceof ClientError, 'Actual native typed error boundary');
  assert.equal((error as { kind: string }).kind, 'protocol');
  return true;
}
function serverFailure(code: string) {
  return (error: unknown): boolean => {
    assert.ok(
      error instanceof ClientError,
      'Actual native typed error boundary',
    );
    assert.equal(
      (error as { details: { serverCode?: string } }).details.serverCode,
      code,
    );
    return true;
  };
}
function memoryStorage() {
  const values = new Map<string, unknown>();
  return {
    values,
    get: (key: string) => structuredClone(values.get(key)),
    set: (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
    },
    remove: (key: string) => {
      values.delete(key);
    },
  };
}
function platformStorage() {
  const storage = memoryStorage();
  return {
    storage,
    getStorageSync: storage.get,
    setStorageSync: storage.set,
    removeStorageSync: storage.remove,
    getRandomValues: (input: {
      length: number;
      success(value: { randomValues: ArrayBuffer }): void;
    }) =>
      input.success({
        randomValues: Uint8Array.from(randomBytes(input.length)).buffer,
      }),
  };
}
function noPrivateFields(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(
      ![
        'accountId',
        'account_id',
        'sessionId',
        'session_id',
        'phone',
        'phoneNumber',
        'studentNumber',
        'student_number',
        'openid',
        'unionid',
        'providerSubject',
        'contacts',
        'wechat',
        'qq',
        'institutionId',
        'assertionId',
        'snapshotId',
        'affiliationAssertionId',
        'identityCampusId',
        'identitySelectionId',
        'topologySnapshotId',
        'approvalDecisionId',
        'decisionId',
        'digest',
        'provenance',
        'provenanceRef',
        'policyRevisionId',
        'envelope',
        'developer',
        'roles',
        'grants',
        'privateIdentity',
        'accessToken',
        'refreshToken',
      ].includes(key),
      `Public discovery DTO leaked ${key}`,
    );
    noPrivateFields(child);
  }
}

test(
  'real native discovery → normal AppModule → PostgreSQL privacy and lifecycle',
  { timeout: 180000 },
  async (t) => {
    const connectionString = process.env['TEST_DATABASE_URL'];
    assert.ok(
      connectionString,
      'Use disposable loopback whaleu_test; no silent skips',
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
      COMMUNITY_UPDATES_PROCESSING: 'disabled',
    });
    const pool = new Pool(poolOptions(config));
    let app: INestApplication | undefined, suite: PoolClient | undefined;
    let locked = false,
      ownsSchemas = false;
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) AS locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert.equal(locked, true, 'Serialize disposable database suites');
      assert.ok(
        supportedPostgresVersion(
          (
            await pool.query<{ v: number }>(
              "SELECT current_setting('server_version_num')::integer AS v",
            )
          ).rows[0]!.v,
        ),
      );
      assert.equal(
        (
          await pool.query<{ n: number }>(
            "SELECT count(*)::integer AS n FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
          )
        ).rows[0]!.n,
        0,
        'Refuse existing application schemas',
      );
      ownsSchemas = true;
      await runMigrations(
        pool,
        await readMigrations(
          fileURLToPath(new URL('../../migrations', import.meta.url)),
        ),
        { mode: 'up' },
      );
      const start = async (port = 0) => {
        app = await NestFactory.create(AppModule.register(config), {
          logger: false,
        });
        configureHttp(app);
        await app.listen(port, '127.0.0.1');
      };
      await start();
      const transport = new NodeHttpTransport(
        Number(new URL(await app!.getUrl()).port),
      );
      const cancel = new Cancellation();
      const privateValues = new Set<string>();
      const makeClient = async (saved?: SessionCredentials) => {
        const credentials = saved ?? (await createRuntimeActor(app!));
        privateValues.add(credentials.accountId);
        privateValues.add(credentials.sessionId);
        privateValues.add(credentials.accessToken);
        privateValues.add(credentials.refreshToken);
        const sessions = new SessionStore();
        sessions.completeLogin(sessions.beginLogin(), credentials);
        const auth = new AuthService(
          sessions,
          new HttpAuthGateway(nativeOrigin, transport, systemClock),
          { login: async () => 'no-provider-configured' },
          systemClock,
        );
        const api = new ApiClient(nativeOrigin, transport, sessions, auth);
        return {
          credentials,
          sessions,
          auth,
          api,
          profiles: new HttpProfileGateway(api),
          discovery: new HttpDiscoveryGateway(api),
          community: new HttpCommunityGateway(api),
          blocks: new HttpBlockGateway(api),
        };
      };
      type Actor = Awaited<ReturnType<typeof makeClient>>;
      const author = await makeClient(),
        peer = await makeClient(),
        reader = await makeClient(),
        guest = await makeClient();
      guest.sessions.logout();
      const profilePath = (id: string) => `/v1/profiles/${id}`;
      const isDiscovery = (path: string) =>
        path.startsWith('/v1/profiles/') ||
        path === '/v1/me/public-profile-ref' ||
        path === '/v1/me/community/liked';
      transport.checkResponse = (path, _status, value) => {
        if (!isDiscovery(path)) return;
        noPrivateFields(value);
        const serialized = JSON.stringify(value);
        for (const secret of privateValues)
          assert.ok(
            !serialized.includes(secret),
            'Private owner/contact data escaped the discovery boundary',
          );
      };
      const sameAccountSession = async (actor: Actor) => {
        const identity = (
          await pool.query<{ app_id: string; subject: string }>(
            'SELECT app_id,subject FROM whaleu_identity.provider_identities WHERE account_id=$1',
            [actor.credentials.accountId],
          )
        ).rows[0]!;
        const accessToken = mintToken('access'),
          refreshToken = mintToken('refresh');
        const session = await app!.get(IdentityRepository).createSession(
          {
            provider: 'wechat',
            appId: identity.app_id,
            subject: identity.subject,
          },
          {
            access: hashToken(accessToken),
            refresh: hashToken(refreshToken),
          },
        );
        assert.equal(session.accountId, actor.credentials.accountId);
        assert.notEqual(session.sessionId, actor.credentials.sessionId);
        return makeClient({ ...session, accessToken, refreshToken });
      };
      const rowCount = async (table: string) =>
        Number(
          (await pool.query(`SELECT count(*) FROM ${table}`)).rows[0]!.count,
        );
      let authorProfileId = '',
        peerProfileId = '';
      await t.test(
        'own public reference reads are nullable and read-only; private UUIDs are never alternate public selectors',
        async () => {
          assert.equal(await rowCount('whaleu_profile.profiles'), 0);
          for (let n = 0; n < 3; n++) {
            assert.deepEqual(await reader.discovery.ownProfileRef(cancel), {
              profileId: null,
            });
            await reader.profiles.profile(cancel);
          }
          assert.equal(await rowCount('whaleu_profile.profiles'), 0);
          const unavailable = (
            await request(app!.getHttpServer()).get(
              profilePath(author.credentials.accountId),
            )
          ).body;
          assert.deepEqual(unavailable, {
            status: 'unavailable',
            profileId: author.credentials.accountId,
          });
          // The supplied selector is echoed, so check it separately from undisclosed owner IDs.
          assert.equal(await rowCount('whaleu_profile.profiles'), 0);
          await author.profiles.updateProfile(
            {
              expectedRevision: 0,
              nickname: 'Author',
              bio: 'Current public biography',
            },
            cancel,
          );
          await peer.profiles.updateProfile(
            { expectedRevision: 0, nickname: 'Peer', bio: '' },
            cancel,
          );
          authorProfileId = (await author.discovery.ownProfileRef(cancel))
            .profileId;
          peerProfileId = (await peer.discovery.ownProfileRef(cancel))
            .profileId;
          assert.ok(authorProfileId && peerProfileId);
          assert.notEqual(authorProfileId, author.credentials.accountId);
          assert.notEqual(peerProfileId, peer.credentials.accountId);
          const updated = await author.profiles.profile(cancel);
          await author.profiles.updateProfile(
            {
              expectedRevision: updated.revision,
              nickname: 'Renamed',
              bio: updated.bio,
            },
            cancel,
          );
          assert.deepEqual(await author.discovery.ownProfileRef(cancel), {
            profileId: authorProfileId,
          });
          for (const selector of ['1', 'student-number', 'openid:synthetic']) {
            const result = await request(app!.getHttpServer()).get(
              profilePath(selector),
            );
            assert.equal(result.status, 400);
          }
          const invalid = await request(app!.getHttpServer())
            .get(profilePath(authorProfileId))
            .set('Authorization', 'Bearer invalid');
          assert.equal(
            invalid.status,
            401,
            'Invalid optional authentication is never downgraded to guest',
          );
        },
      );

      const scope = await seedCommunityScope(pool);
      for (const value of [
        scope.institutionId,
        scope.topologySnapshotId,
        scope.home.campusId,
        scope.related.campusId,
      ])
        privateValues.add(value);
      await seedReviewPolicy(pool);
      const verify = async (
        actor: Actor,
        publisher = false,
        phone: 'verified' | 'unverified' = 'verified',
      ) => {
        const facts = await setRuntimeVerification(
          pool,
          actor.credentials.accountId,
          scope.institutionId,
          scope.home.regionId,
          publisher ? 'verified' : 'unavailable',
          phone,
        );
        privateValues.add(facts.assertionId);
        privateValues.add(facts.snapshotId);
        if (publisher)
          privateValues.add(
            await appendIdentitySelection(
              pool,
              actor.credentials.accountId,
              facts,
              scope,
              scope.home.campusId,
            ),
          );
      };
      await verify(author, true);
      await verify(peer, true);
      await verify(reader, false, 'unverified');
      const postIntent = (
        text: string,
        authorMode: 'named' | 'anonymous' = 'named',
        spaceId = scope.home.spaceId,
      ): PublishPost => ({
        clientRequestId: randomUUID(),
        spaceId,
        category: 'discussion',
        text,
        imageAssetIds: [],
        authorMode,
        commentsPolicy: 'open',
      });
      const publish = async (actor: Actor, body: PublishPost) => {
        const approval = await approveEnvelope(
          pool,
          await postApprovalEnvelope(
            app!,
            pool,
            actor.credentials.accountId,
            body,
          ),
        );
        privateValues.add(approval.decisionId);
        const receipt = await actor.community.publishPost(body, cancel);
        assert.equal(receipt.outcome, 'created');
        return { id: receipt.resourceId as string, body, approval };
      };
      const chosen = {
        wechat: 'PRIVATE chosen-wechat',
        qq: 'PRIVATE arbitrary qq',
        phone: 'PRIVATE chosen phone',
      };
      Object.values(chosen).forEach((value) => privateValues.add(value));
      const tradeIntent = (
        text: string,
        subtype: 'shuma' | 'qiugou' = 'shuma',
        urgency: 'normal' | 'urgent' = 'normal',
      ): PublishPost => ({
        ...postIntent(text),
        category: 'trading',
        trading: {
          subtype,
          urgency,
          price: '12.5',
          location: 'Synthetic pickup',
          contacts: chosen,
        },
      });
      const named = await publish(author, postIntent('Public named one'));
      const second = await publish(author, postIntent('Public named two'));
      const global = await publish(
        author,
        postIntent('Public global', 'named', scope.global.spaceId),
      );
      const anonymous = await publish(
        author,
        postIntent('Anonymous ownership stays private', 'anonymous'),
      );
      const hidden = await publish(
        author,
        postIntent('Hidden author recovery'),
      );
      const deleted = await publish(
        author,
        postIntent('Deleted author recovery'),
      );
      const held = await publish(author, postIntent('Held review'));
      await withCommunityScopeWriter(pool, (tx) =>
        tx.query(
          "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
          [hidden.id],
        ),
      );
      await author.community.deletePost(deleted.id, cancel);
      await setReviewState(pool, held.approval.decisionId, 'held');
      const sale = await publish(author, tradeIntent('Open normal sale'));
      const urgent = await publish(
        author,
        tradeIntent('Open urgent sale', 'shuma', 'urgent'),
      );
      const wanted = await publish(
        author,
        tradeIntent('Wanted subtype', 'qiugou'),
      );
      const resolved = await publish(author, tradeIntent('Resolved listing'));
      await author.community.setTradingResolution(
        resolved.id,
        'resolved',
        randomUUID(),
        cancel,
      );
      const eligiblePosts = [named.id, second.id, global.id].sort();
      const eligibleTrades = [sale.id, urgent.id, wanted.id].sort();
      const ids = (items: readonly { id: string }[]) =>
        items.map((item) => item.id).sort();
      const allPages = async (
        actor: Actor,
        kind: 'posts' | 'trading',
        limit = 1,
      ) => {
        const items: PostView[] = [];
        let cursor: string | null = null;
        const seen = new Set<string>();
        do {
          const result: {
            status: string;
            total: number;
            items: PostView[];
            nextCursor: string | null;
          } = await actor.discovery.list(
            authorProfileId,
            kind,
            cursor,
            cancel,
            undefined,
            limit,
          );
          assert.equal(result.status, 'available');
          assert.equal(
            result.total,
            kind === 'posts' ? eligiblePosts.length : eligibleTrades.length,
          );
          for (const item of result.items as PostView[]) {
            assert.ok(
              !seen.has(item.id),
              'Stable keyset paging never repeats an item',
            );
            seen.add(item.id);
            items.push(item);
          }
          cursor = result.nextCursor;
        } while (cursor);
        return items;
      };
      await t.test(
        'guest and unverified native browsing uses one eligible public count/page set and no borrowed display authority',
        async () => {
          for (const actor of [guest, reader, author]) {
            const profile = await actor.discovery.profile(
              authorProfileId,
              cancel,
            );
            assert.equal(profile.status, 'available');
            assert.equal(profile.displayName, 'Renamed');
            assert.equal(profile.isOwn, actor === author);
            assert.equal(profile.postCount, eligiblePosts.length);
            assert.equal(profile.tradeCount, eligibleTrades.length);
            assert.equal(profile.displayAvailability, 'unavailable');
            for (const field of [
              'avatar',
              'affiliation',
              'publicUid',
              'title',
              'level',
              'totalInteractions',
            ])
              assert.equal(profile[field], null, field);
            assert.deepEqual(
              ids(await allPages(actor, 'posts')),
              eligiblePosts,
            );
            assert.deepEqual(
              ids(await allPages(actor, 'trading')),
              eligibleTrades,
            );
          }
          const saleOnly = await reader.discovery.list(
            authorProfileId,
            'trading',
            null,
            cancel,
            'shuma',
            10,
          );
          assert.deepEqual(ids(saleOnly.items), [sale.id, urgent.id].sort());
          assert.equal(saleOnly.total, 2);
          const wantedOnly = await reader.discovery.list(
            authorProfileId,
            'trading',
            null,
            cancel,
            'qiugou',
            10,
          );
          assert.deepEqual(ids(wantedOnly.items), [wanted.id]);
          assert.equal(wantedOnly.total, 1);
          const own = await author.community.mine(null, cancel);
          assert.ok(
            own.items.some(
              (item: { id: string; status: string }) =>
                item.id === hidden.id && item.status === 'hidden',
            ),
          );
          assert.ok(
            own.items.some(
              (item: { id: string; status: string }) =>
                item.id === deleted.id && item.status === 'deleted',
            ),
          );
          assert.ok(
            own.items.some((item: { id: string }) => item.id === anonymous.id),
          );
          assert.ok(
            (await author.community.ownTrading(null, cancel)).items.some(
              (item: PostView) => item.id === resolved.id,
            ),
          );
          await assert.rejects(
            reader.community.tradingContacts(resolved.id, cancel),
            serverFailure('POST_NOT_FOUND'),
          );
        },
      );

      const setPrivacy = async (enabled: boolean) => {
        const own = await author.profiles.profile(cancel);
        await author.profiles.updatePreferences(
          {
            expectedRevision: own.revision,
            preferences: { hideProfilePosts: enabled },
          },
          cancel,
        );
      };
      await t.test(
        'privacy hides both other-viewer lists and counts while preserving basics, direct posts, self and recovery',
        async () => {
          await setPrivacy(true);
          for (const actor of [reader, guest]) {
            const profile = await actor.discovery.profile(
              authorProfileId,
              cancel,
            );
            assert.equal(profile.status, 'available');
            assert.equal(profile.displayName, 'Renamed');
            assert.equal(profile.postsHidden, true);
            assert.equal(profile.postCount, 0);
            assert.equal(profile.tradeCount, 0);
            for (const kind of ['posts', 'trading'])
              assert.deepEqual(
                await actor.discovery.list(authorProfileId, kind, null, cancel),
                {
                  status: 'hidden',
                  profileId: authorProfileId,
                  items: [],
                  total: 0,
                  nextCursor: null,
                },
              );
          }
          assert.deepEqual(ids(await allPages(author, 'posts')), eligiblePosts);
          assert.deepEqual(
            ids(await allPages(author, 'trading')),
            eligibleTrades,
          );
          assert.equal(
            (await reader.community.post(named.id, cancel)).id,
            named.id,
          );
          const ordinary = await reader.community.feed(
            { spaceId: scope.home.spaceId },
            cancel,
          );
          assert.ok(
            ordinary.items.some((item: PostView) => item.id === named.id),
          );
          await setPrivacy(false);
          assert.equal(
            (await reader.discovery.profile(authorProfileId, cancel))
              .postsHidden,
            false,
          );
        },
      );

      await t.test(
        'strict session/kind/profile/limit/subtype-bound cursors survive server restart and stale anchors require restart',
        async () => {
          const first = await reader.discovery.list(
            authorProfileId,
            'posts',
            null,
            cancel,
            undefined,
            1,
          );
          assert.ok(first.nextCursor);
          const cursorJson = Buffer.from(
            first.nextCursor,
            'base64url',
          ).toString('utf8');
          noPrivateFields(JSON.parse(cursorJson));
          for (const value of privateValues)
            assert.ok(!cursorJson.includes(value));
          assert.ok(
            cursorJson.includes(first.items[0].id),
            'Cursor only anchors a returned visible item',
          );
          const raw = (
            profileId: string,
            kind: string,
            query: Record<string, unknown>,
            token = reader.credentials.accessToken,
          ) =>
            request(app!.getHttpServer())
              .get(`${profilePath(profileId)}/${kind}`)
              .set('Authorization', `Bearer ${token}`)
              .query(query);
          for (const [profileId, kind, query, token] of [
            [
              peerProfileId,
              'posts',
              { limit: 1, cursor: first.nextCursor },
              reader.credentials.accessToken,
            ],
            [
              authorProfileId,
              'trading',
              { limit: 1, cursor: first.nextCursor },
              reader.credentials.accessToken,
            ],
            [
              authorProfileId,
              'posts',
              { limit: 2, cursor: first.nextCursor },
              reader.credentials.accessToken,
            ],
            [
              authorProfileId,
              'posts',
              { limit: 1, cursor: first.nextCursor },
              peer.credentials.accessToken,
            ],
            [
              authorProfileId,
              'posts',
              {
                limit: 1,
                cursor: first.nextCursor,
                accountId: reader.credentials.accountId,
              },
              reader.credentials.accessToken,
            ],
          ] as const)
            assert.equal(
              (await raw(profileId, kind, query, token)).status,
              400,
            );
          assert.equal(
            (
              await request(app!.getHttpServer())
                .get(`${profilePath(authorProfileId)}/posts`)
                .query({ limit: 1, cursor: first.nextCursor })
            ).status,
            400,
          );
          for (const cursor of [
            '!',
            'A'.repeat(1025),
            Buffer.from(
              JSON.stringify({
                ...JSON.parse(cursorJson),
                accountId: reader.credentials.accountId,
              }),
            ).toString('base64url'),
          ])
            assert.equal(
              (await raw(authorProfileId, 'posts', { limit: 1, cursor }))
                .status,
              400,
            );
          const newLogin = await sameAccountSession(reader);
          assert.equal(
            (
              await raw(
                authorProfileId,
                'posts',
                { limit: 1, cursor: first.nextCursor },
                newLogin.credentials.accessToken,
              )
            ).status,
            400,
          );
          const tradeFirst = await reader.discovery.list(
            authorProfileId,
            'trading',
            null,
            cancel,
            'shuma',
            1,
          );
          assert.ok(tradeFirst.nextCursor);
          assert.equal(
            (
              await raw(authorProfileId, 'trading', {
                limit: 1,
                cursor: tradeFirst.nextCursor,
                tradingSubtype: 'qiugou',
              })
            ).status,
            400,
          );
          const port = Number(new URL(await app!.getUrl()).port);
          await app!.close();
          await start(port);
          const next = await reader.discovery.list(
            authorProfileId,
            'posts',
            first.nextCursor,
            cancel,
            undefined,
            1,
          );
          assert.equal(next.items.length, 1);
          assert.notEqual(next.items[0].id, first.items[0].id);
          const anchorId = first.items[0].id;
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
              [anchorId],
            ),
          );
          await assert.rejects(
            reader.discovery.list(
              authorProfileId,
              'posts',
              first.nextCursor,
              cancel,
              undefined,
              1,
            ),
            serverFailure('DISCOVERY_RESTART_REQUIRED'),
          );
          const restart = await reader.discovery.list(
            authorProfileId,
            'posts',
            null,
            cancel,
            undefined,
            10,
          );
          assert.equal(restart.total, 2);
          assert.ok(
            !restart.items.some((item: PostView) => item.id === anchorId),
          );
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              "UPDATE whaleu_community.posts SET visibility='approved' WHERE id=$1",
              [anchorId],
            ),
          );
        },
      );

      const unblock = async (
        actor: Actor,
        current: { relationshipId: string; revision: string },
      ) =>
        actor.blocks.apply(
          {
            clientRequestId: randomUUID(),
            operation: 'unblock_named',
            relationshipId: current.relationshipId,
            expectedRevision: current.revision,
            blocked: false,
          },
          cancel,
        );
      await t.test(
        'profile-sourced safety is phone-only, bilateral for profiles and outgoing-only for ordinary feeds',
        async () => {
          await verify(reader);
          const intent = {
            clientRequestId: randomUUID(),
            operation: 'block_named',
            source: { kind: 'profile', id: authorProfileId },
            blocked: true,
          };
          const blocked = await reader.blocks.apply(intent, cancel);
          assert.equal(blocked.receipt.outcome, 'applied');
          assert.ok(blocked.current?.blocked);
          assert.deepEqual(
            await reader.blocks.apply(intent, cancel),
            blocked,
            'Exact repeated intent is idempotent',
          );
          const profile = await reader.discovery.profile(
            authorProfileId,
            cancel,
          );
          assert.deepEqual(profile, {
            status: 'blocked_by_you',
            profileId: authorProfileId,
            relationship: blocked.current,
          });
          assert.deepEqual(
            await reader.discovery.list(authorProfileId, 'posts', null, cancel),
            profile,
          );
          assert.deepEqual(
            await reader.discovery.list(
              authorProfileId,
              'trading',
              null,
              cancel,
            ),
            profile,
          );
          await assert.rejects(
            reader.community.post(named.id, cancel),
            serverFailure('POST_BLOCKED_BY_YOU'),
          );
          assert.equal(
            (await reader.community.post(anonymous.id, cancel)).author.kind,
            'anonymous',
          );
          const feed = await reader.community.feed(
            { spaceId: scope.home.spaceId },
            cancel,
          );
          assert.ok(!feed.items.some((item: PostView) => item.id === named.id));
          assert.ok(
            feed.items.some((item: PostView) => item.id === anonymous.id),
          );
          await unblock(reader, blocked.current);
          assert.equal(
            (await reader.discovery.profile(authorProfileId, cancel)).status,
            'available',
          );

          const incoming = await author.blocks.apply(
            {
              clientRequestId: randomUUID(),
              operation: 'block_named',
              source: { kind: 'profile', id: peerProfileId },
              blocked: true,
            },
            cancel,
          );
          assert.equal(incoming.receipt.outcome, 'applied');
          assert.deepEqual(
            await peer.discovery.profile(authorProfileId, cancel),
            { status: 'unavailable', profileId: authorProfileId },
          );
          assert.deepEqual(
            await peer.discovery.list(authorProfileId, 'posts', null, cancel),
            { status: 'unavailable', profileId: authorProfileId },
          );
          const incomingFeed = await peer.community.feed(
            { spaceId: scope.home.spaceId },
            cancel,
          );
          assert.ok(
            incomingFeed.items.some((item: PostView) => item.id === named.id),
            'Incoming-only block does not change ordinary feed projection',
          );
          await assert.rejects(
            peer.community.post(named.id, cancel),
            serverFailure('POST_NOT_FOUND'),
          );
          await unblock(author, incoming.current);
          const self = await author.blocks.apply(
            {
              clientRequestId: randomUUID(),
              operation: 'block_named',
              source: { kind: 'profile', id: authorProfileId },
              blocked: true,
            },
            cancel,
          );
          assert.equal(self.receipt.outcome, 'rejected');
          assert.equal(self.receipt.code, 'BLOCK_TARGET_NOT_ALLOWED');
          const forged = await reader.blocks.apply(
            {
              clientRequestId: randomUUID(),
              operation: 'block_named',
              source: { kind: 'profile', id: author.credentials.accountId },
              blocked: true,
            },
            cancel,
          );
          assert.equal(forged.receipt.outcome, 'rejected');
          assert.equal(
            (await reader.discovery.profile(authorProfileId, cancel)).status,
            'available',
          );
        },
      );

      const discussion = async (
        postId: string,
        mode: 'named' | 'anonymous',
        rootId: string | null = null,
      ) => {
        const body: PublishComment | PublishReply = {
          clientRequestId: randomUUID(),
          text: `Synthetic ${rootId ? 'reply' : 'root'} ${mode}`,
          imageAssetIds: [],
          authorMode: mode,
          ...(rootId ? { targetReplyId: null } : {}),
        };
        const approval = await approveEnvelope(
          pool,
          await discussionApprovalEnvelope(
            app!,
            pool,
            peer.credentials.accountId,
            postId,
            body,
            rootId,
          ),
        );
        privateValues.add(approval.decisionId);
        const receipt = rootId
          ? await peer.community.publishReply(rootId, body, cancel)
          : await peer.community.publishComment(postId, body, cancel);
        assert.equal(receipt.outcome, 'created');
        return receipt.resourceId as string;
      };
      const anonymousRoot = await discussion(named.id, 'anonymous');
      const namedRootOnAnonymous = await discussion(anonymous.id, 'named');
      const anonymousReplyOnNamedRoot = await discussion(
        anonymous.id,
        'anonymous',
        namedRootOnAnonymous,
      );
      interface LikedRow {
        kind: 'post' | 'comment' | 'reply';
        targetId: string;
        postId: string;
        rootCommentId: string | null;
        likedAt: string | null;
        likeId: string;
        preview: { author: { kind: string; profileId?: string }; text: string };
      }
      await t.test(
        'canonical named author links stay current while anonymous self/root/reply personas remain unlinkable',
        async () => {
          const {
            authorProfilePath,
          } = require('../../../wechat/src/profile/author-navigation.ts');
          const before = (
            await pool.query(
              'SELECT id,display_name FROM whaleu_community.thread_personas ORDER BY id',
            )
          ).rows;
          const own = await peer.profiles.profile(cancel);
          await peer.profiles.updateProfile(
            { expectedRevision: own.revision, nickname: 'PeerUpdated' },
            cancel,
          );
          const namedView = await reader.community.post(named.id, cancel);
          const root = await reader.community.comment(
            namedRootOnAnonymous,
            cancel,
          );
          const anonymousView = await author.community.post(
            anonymous.id,
            cancel,
          );
          const anonymousComment = await reader.community.comment(
            anonymousRoot,
            cancel,
          );
          const anonymousReply = await reader.community.reply(
            anonymousReplyOnNamedRoot,
            cancel,
          );
          assert.equal(root.author.displayName, 'PeerUpdated');
          assert.equal(
            authorProfilePath(namedView.author),
            `/pages/public-profile/public-profile?profileId=${authorProfileId}`,
          );
          assert.equal(
            authorProfilePath(root.author),
            `/pages/public-profile/public-profile?profileId=${peerProfileId}`,
          );
          assert.equal(
            (await reader.discovery.profile(peerProfileId, cancel)).displayName,
            'PeerUpdated',
          );
          assert.equal(anonymousView.viewer.isSelf, true);
          for (const author of [
            anonymousView.author,
            anonymousComment.author,
            anonymousReply.author,
          ]) {
            assert.equal(authorProfilePath(author), null);
            assert.equal(author.profileId, undefined);
          }
          assert.equal(
            authorProfilePath({
              ...root.author,
              accountId: peer.credentials.accountId,
            }),
            null,
          );
          assert.deepEqual(
            (
              await pool.query(
                'SELECT id,display_name FROM whaleu_community.thread_personas ORDER BY id',
              )
            ).rows,
            before,
          );
        },
      );

      await t.test(
        'own liked native history resolves each target mode and full parent/root chain without borrowing parent anonymity',
        async () => {
          await reader.community.like(named.id, true, cancel);
          await reader.community.discussionLike(
            'comment',
            anonymousRoot,
            true,
            randomUUID(),
            cancel,
          );
          await reader.community.discussionLike(
            'comment',
            namedRootOnAnonymous,
            true,
            randomUUID(),
            cancel,
          );
          await reader.community.discussionLike(
            'reply',
            anonymousReplyOnNamedRoot,
            true,
            randomUUID(),
            cancel,
          );
          await verify(reader, false, 'unverified');
          const page = await reader.discovery.liked(null, cancel);
          assert.equal(page.visibleLikedCount, 4);
          const find = (targetId: string) =>
            page.items.find(
              (item: LikedRow) => item.targetId === targetId,
            ) as LikedRow;
          assert.equal(find(named.id).preview.author.kind, 'named');
          assert.equal(find(anonymousRoot).preview.author.kind, 'anonymous');
          assert.equal(find(anonymousRoot).preview.author.profileId, undefined);
          assert.equal(find(namedRootOnAnonymous).preview.author.kind, 'named');
          assert.equal(
            find(namedRootOnAnonymous).preview.author.profileId,
            peerProfileId,
          );
          assert.equal(
            find(anonymousReplyOnNamedRoot).preview.author.kind,
            'anonymous',
          );
          assert.equal(
            find(anonymousReplyOnNamedRoot).preview.author.profileId,
            undefined,
          );
          assert.equal(
            find(anonymousReplyOnNamedRoot).rootCommentId,
            namedRootOnAnonymous,
          );
          assert.ok(
            page.items.every(
              (item: LikedRow) =>
                item.likeId !== item.targetId && item.likedAt !== null,
            ),
          );
          const gathered: LikedRow[] = [];
          let after: string | null = null;
          do {
            const batch: {
              items: LikedRow[];
              visibleLikedCount: number;
              nextCursor: string | null;
            } = await reader.discovery.liked(after, cancel, 1);
            assert.equal(batch.visibleLikedCount, 4);
            gathered.push(...batch.items);
            after = batch.nextCursor;
          } while (after);
          assert.equal(new Set(gathered.map((item) => item.likeId)).size, 4);
          assert.deepEqual(
            gathered.map((item) => item.likeId),
            page.items.map((item: LikedRow) => item.likeId),
          );
          assert.deepEqual(
            (await peer.discovery.liked(null, cancel)).items,
            [],
          );
          await assert.rejects(
            guest.discovery.liked(null, cancel),
            (error: unknown) =>
              error instanceof ClientError &&
              (error as { kind: string }).kind === 'auth-required',
          );
          assert.equal(
            (
              await request(app!.getHttpServer())
                .get(`${profilePath(authorProfileId)}/liked`)
                .set(
                  'Authorization',
                  `Bearer ${reader.credentials.accessToken}`,
                )
            ).status,
            404,
          );
          const ownQuery = await request(app!.getHttpServer())
            .get('/v1/me/community/liked')
            .set('Authorization', `Bearer ${reader.credentials.accessToken}`)
            .query({ accountId: peer.credentials.accountId });
          assert.equal(ownQuery.status, 400);
          await verify(reader);
          const block = await reader.blocks.apply(
            {
              clientRequestId: randomUUID(),
              operation: 'block_named',
              source: { kind: 'profile', id: peerProfileId },
              blocked: true,
            },
            cancel,
          );
          const blocked = await reader.discovery.liked(null, cancel);
          assert.equal(blocked.visibleLikedCount, 2);
          assert.deepEqual(
            blocked.items.map((item: LikedRow) => item.targetId).sort(),
            [named.id, anonymousRoot].sort(),
            'Anonymous target remains independent, but anonymous reply requires visible named root',
          );
          await unblock(reader, block.current);
          for (const [table, id] of [
            ['root_comments', namedRootOnAnonymous],
            ['posts', anonymous.id],
          ] as const) {
            await withCommunityScopeWriter(pool, (tx) =>
              tx.query(
                `UPDATE whaleu_community.${table} SET visibility='hidden' WHERE id=$1`,
                [id],
              ),
            );
            const hiddenPage = await reader.discovery.liked(null, cancel);
            assert.equal(hiddenPage.visibleLikedCount, 2);
            assert.ok(
              !hiddenPage.items.some((item: LikedRow) =>
                [namedRootOnAnonymous, anonymousReplyOnNamedRoot].includes(
                  item.targetId,
                ),
              ),
            );
            await withCommunityScopeWriter(pool, (tx) =>
              tx.query(
                `UPDATE whaleu_community.${table} SET visibility='approved' WHERE id=$1`,
                [id],
              ),
            );
          }
          assert.equal(
            (await reader.discovery.liked(null, cancel)).visibleLikedCount,
            4,
          );
        },
      );

      await t.test(
        'liked cursor ownership, exact limit, stable opaque identities and unlike/re-like restart are enforced at the native boundary',
        async () => {
          const first = await reader.discovery.liked(null, cancel, 1);
          assert.ok(first.nextCursor);
          const wire = Buffer.from(first.nextCursor, 'base64url').toString(
            'utf8',
          );
          noPrivateFields(JSON.parse(wire));
          for (const value of privateValues) assert.ok(!wire.includes(value));
          const badLimit = await request(app!.getHttpServer())
            .get('/v1/me/community/liked')
            .set('Authorization', `Bearer ${reader.credentials.accessToken}`)
            .query({ limit: 2, cursor: first.nextCursor });
          assert.equal(badLimit.status, 400);
          const wrongOwner = await request(app!.getHttpServer())
            .get('/v1/me/community/liked')
            .set('Authorization', `Bearer ${peer.credentials.accessToken}`)
            .query({ limit: 1, cursor: first.nextCursor });
          assert.equal(wrongOwner.status, 400);
          const anchor = first.items[0] as LikedRow;
          const like = async (liked: boolean) =>
            anchor.kind === 'post'
              ? reader.community.like(anchor.targetId, liked, cancel)
              : reader.community.discussionLike(
                  anchor.kind,
                  anchor.targetId,
                  liked,
                  randomUUID(),
                  cancel,
                );
          await like(false);
          await assert.rejects(
            reader.discovery.liked(first.nextCursor, cancel, 1),
            serverFailure('DISCOVERY_RESTART_REQUIRED'),
          );
          await like(true);
          const current = await reader.discovery.liked(null, cancel);
          assert.notEqual(
            current.items.find(
              (item: LikedRow) => item.targetId === anchor.targetId,
            ).likeId,
            anchor.likeId,
          );
          await assert.rejects(
            reader.discovery.liked(first.nextCursor, cancel, 1),
            serverFailure('DISCOVERY_RESTART_REQUIRED'),
          );
        },
      );

      await t.test(
        'native exact decoders reject extra nested private fields and contradictory server shapes rather than stripping them',
        async () => {
          for (const patch of [
            { accountId: author.credentials.accountId },
            { profileId: peerProfileId },
            { totalInteractions: 0 },
            { title: { name: 'Unowned title' } },
            { postsHidden: true, postCount: 1 },
            { displayAvailability: 'available' },
          ]) {
            transport.corruptNext = {
              path: profilePath(authorProfileId),
              transform: (value) => ({
                ...(value as Record<string, unknown>),
                ...patch,
              }),
            };
            await assert.rejects(
              reader.discovery.profile(authorProfileId, cancel),
              protocolFailure,
            );
          }
          for (const transform of [
            (value: Record<string, unknown>) => ({
              ...value,
              accountId: author.credentials.accountId,
            }),
            (value: Record<string, unknown>) => ({ ...value, total: 0 }),
            (value: Record<string, unknown>) => ({
              ...value,
              items: (value['items'] as PostView[]).map((item) => ({
                ...item,
                author: { ...item.author, studentNumber: 'private' },
              })),
            }),
            (value: Record<string, unknown>) => ({
              ...value,
              items: (value['items'] as PostView[]).map((item) => ({
                ...item,
                author: {
                  kind: 'named',
                  profileId: peerProfileId,
                  displayName: 'Wrong author',
                },
              })),
            }),
          ]) {
            transport.corruptNext = {
              path: `${profilePath(authorProfileId)}/posts`,
              transform: (value) => transform(value as Record<string, unknown>),
            };
            await assert.rejects(
              reader.discovery.list(authorProfileId, 'posts', null, cancel),
              protocolFailure,
            );
          }
          transport.corruptNext = {
            path: '/v1/me/public-profile-ref',
            transform: (value) => ({
              ...(value as Record<string, unknown>),
              accountId: author.credentials.accountId,
            }),
          };
          await assert.rejects(
            author.discovery.ownProfileRef(cancel),
            protocolFailure,
          );
          for (const mutate of [
            (item: LikedRow) => ({
              ...item,
              accountId: reader.credentials.accountId,
            }),
            (item: LikedRow) => ({ ...item, likeId: 'not-an-opaque-uuid' }),
            (item: LikedRow) => ({
              ...item,
              preview: { ...item.preview, contacts: chosen },
            }),
            (item: LikedRow) => ({
              ...item,
              preview: {
                ...item.preview,
                author: { ...item.preview.author, developer: true },
              },
            }),
          ]) {
            transport.corruptNext = {
              path: '/v1/me/community/liked',
              transform: (value) => {
                const page = value as { items: LikedRow[] };
                return { ...page, items: page.items.map(mutate) };
              },
            };
            await assert.rejects(
              reader.discovery.liked(null, cancel),
              protocolFailure,
            );
          }
          // Decoder-only historical fixture: backend migration/null provenance is tested
          // by the dedicated liked-history suite, never fabricated in canonical storage.
          transport.corruptNext = {
            path: '/v1/me/community/liked',
            transform: (value) => {
              const page = value as { items: LikedRow[] };
              return {
                ...page,
                items: page.items.map((item) => ({ ...item, likedAt: null })),
              };
            },
          };
          const undated = await reader.discovery.liked(null, cancel);
          assert.ok(
            undated.items.every((item: LikedRow) => item.likedAt === null),
          );
        },
      );

      const {
        PublicProfileController,
        initialPublicProfileView,
      } = require('../../../wechat/src/pages/public-profile/controller.ts');
      const {
        LikedController,
        initialLikedView,
      } = require('../../../wechat/src/pages/community-liked/controller.ts');
      interface ProfileView {
        profile: {
          profileId: string;
          status: string;
          postsHidden?: boolean;
        } | null;
        items: readonly PostView[];
        total: number | null;
        loaded: boolean;
        busy: boolean;
        noProfile: boolean;
        canLoadMore: boolean;
        canPrevious: boolean;
        pageNumber: number;
        tab: string;
      }
      interface LikedView {
        items: readonly LikedRow[];
        visibleLikedCount: number | null;
        loaded: boolean;
        busy: boolean;
        canLoadMore: boolean;
      }
      const profilePage = (
        actor: Actor,
        target: string | null = authorProfileId,
      ) => {
        const wx = platformStorage(),
          runtime = createCommunityRuntime(actor, wx, nativeOrigin);
        let view: ProfileView = initialPublicProfileView();
        const controller = new PublicProfileController(
          runtime,
          target,
          (next: ProfileView) => {
            view = next;
          },
        );
        return { controller, runtime, storage: wx.storage, view: () => view };
      };
      const likedPage = (actor: Actor) => {
        const wx = platformStorage(),
          runtime = createCommunityRuntime(actor, wx, nativeOrigin);
        let view: LikedView = initialLikedView();
        const controller = new LikedController(runtime, (next: LikedView) => {
          view = next;
        });
        return { controller, runtime, storage: wx.storage, view: () => view };
      };
      await t.test(
        'native self-entry preserves a missing profile and target/tab changes discard delayed real HTTP results',
        async () => {
          const self = profilePage(reader, null),
            before = await rowCount('whaleu_profile.profiles');
          await self.controller.load();
          assert.equal(self.view().noProfile, true);
          assert.equal(self.view().profile, null);
          assert.equal(await rowCount('whaleu_profile.profiles'), before);
          self.controller.dispose();
          const page = profilePage(reader);
          await page.controller.load();
          assert.deepEqual(ids(page.view().items), eligiblePosts);
          const held = transport.holdNext(
            `${profilePath(authorProfileId)}/posts`,
          );
          const oldLoad = page.controller.load();
          await held.arrived;
          await page.controller.setTarget(peerProfileId);
          assert.equal(page.view().profile?.profileId, peerProfileId);
          assert.deepEqual(page.view().items, []);
          held.release();
          await oldLoad;
          assert.equal(page.view().profile?.profileId, peerProfileId);
          await page.controller.setTarget(authorProfileId);
          const oldPosts = transport.holdNext(
            `${profilePath(authorProfileId)}/posts`,
          );
          const loadingPosts = page.controller.load();
          await oldPosts.arrived;
          await page.controller.setTab('trading');
          oldPosts.release();
          await loadingPosts;
          assert.equal(page.view().tab, 'trading');
          assert.deepEqual(ids(page.view().items), eligibleTrades);
          await page.controller.setTradingSubtype('qiugou');
          assert.deepEqual(ids(page.view().items), [wanted.id]);
          await setPrivacy(true);
          await page.controller.load();
          assert.equal(page.view().profile?.postsHidden, true);
          assert.deepEqual(page.view().items, []);
          assert.equal(page.view().canLoadMore, false);
          assert.equal(
            page.storage.values.size,
            0,
            'Discovery projections never enter persistence',
          );
          await setPrivacy(false);
          page.controller.dispose();
        },
      );

      await t.test(
        'cancel, app hide, logout, account switch and same-account new login synchronously clear both native pages and reject late callbacks',
        async () => {
          for (const transition of [
            'cancel',
            'hide',
            'logout',
            'switch',
            'new-login',
          ] as const) {
            const current = await makeClient(reader.credentials);
            const page = profilePage(current),
              likes = likedPage(current);
            await page.controller.load();
            await likes.controller.load();
            assert.ok(page.view().items.length);
            assert.equal(likes.view().visibleLikedCount, 4);
            const heldProfile = transport.holdNext(
              `${profilePath(authorProfileId)}/posts`,
            );
            const delayedProfile = page.controller.load();
            await heldProfile.arrived;
            const heldLikes = transport.holdNext('/v1/me/community/liked');
            const delayedLikes = likes.controller.load();
            await heldLikes.arrived;
            if (transition === 'cancel') {
              page.controller.cancel();
              likes.controller.cancel();
            } else if (transition === 'hide') {
              page.runtime.privateViews.clear();
              likes.runtime.privateViews.clear();
            } else if (transition === 'logout') current.sessions.logout();
            else {
              const replacement =
                transition === 'switch'
                  ? peer
                  : await sameAccountSession(reader);
              current.sessions.completeLogin(
                current.sessions.beginLogin(),
                replacement.credentials,
              );
            }
            assert.equal(page.view().profile, null, transition);
            assert.deepEqual(page.view().items, [], transition);
            assert.equal(page.view().loaded, false, transition);
            assert.deepEqual(likes.view().items, [], transition);
            assert.equal(likes.view().visibleLikedCount, null, transition);
            heldProfile.release();
            heldLikes.release();
            await Promise.all([delayedProfile, delayedLikes]);
            assert.equal(page.view().profile, null, transition);
            assert.deepEqual(page.view().items, [], transition);
            assert.deepEqual(likes.view().items, [], transition);
            assert.equal(page.storage.values.size, 0);
            assert.equal(likes.storage.values.size, 0);
            page.controller.dispose();
            likes.controller.dispose();
          }
        },
      );

      await t.test(
        'native next/previous use fresh current pages and repeated next taps cannot duplicate requests or retain newly hidden previous bodies',
        async () => {
          for (let index = 0; index < 18; index++) {
            const post = await publish(
              author,
              postIntent(`Native pagination item ${index}`),
            );
            eligiblePosts.push(post.id);
          }
          eligiblePosts.sort();
          const page = profilePage(reader);
          await page.controller.load();
          assert.equal(page.view().items.length, 20);
          assert.equal(page.view().total, 21);
          assert.equal(page.view().pageNumber, 1);
          const previouslyVisible = page.view().items[0]!.id;
          const listPath = `${profilePath(authorProfileId)}/posts`;
          const count = () =>
            transport.exchanges.filter((exchange) =>
              exchange.path.startsWith(listPath + '?'),
            ).length;
          const before = count(),
            gate = transport.holdNext(listPath);
          const next = page.controller.more();
          await gate.arrived;
          await page.controller.more();
          assert.equal(
            page.view().items.length,
            0,
            'New read clears older bodies immediately',
          );
          gate.release();
          await next;
          assert.equal(count(), before + 1);
          assert.equal(page.view().items.length, 1);
          assert.equal(page.view().pageNumber, 2);
          assert.equal(page.view().canPrevious, true);
          assert.equal(page.view().canLoadMore, false);
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
              [previouslyVisible],
            ),
          );
          await page.controller.previous();
          assert.equal(page.view().pageNumber, 1);
          assert.equal(page.view().total, 20);
          assert.equal(page.view().items.length, 20);
          assert.ok(
            !page.view().items.some((item) => item.id === previouslyVisible),
          );
          assert.equal(
            new Set(page.view().items.map((item) => item.id)).size,
            20,
          );
          assert.equal(page.storage.values.size, 0);
          noPrivateFields(page.view());
          page.controller.dispose();
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
