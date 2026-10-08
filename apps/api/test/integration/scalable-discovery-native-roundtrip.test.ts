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
import type { PublishPost, PostView } from '../../src/community/contracts.js';
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
import {
  canonicalEnvelope,
  approvalDigest,
} from '../../src/community/content-review/contracts.js';
import type { LikedPage } from '../../src/community/liked/contracts.js';
import {
  DiscoveryCursorRepository,
  discoveryCursorBucket,
} from '../../src/community/discovery-cursors.js';
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
const nativeOrigin = 'https://native-scalable-discovery.invalid';

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

interface PublicPage {
  status: string;
  profileId: string;
  items: PostView[];
  total: number | null;
  totalStatus: 'known' | 'unavailable';
  continuation: 'more' | 'scan_pending' | 'end';
  nextCursor: string | null;
}
interface ProfileView {
  items: readonly PostView[];
  profile: {
    status: string;
    postsHidden?: boolean;
    postCount?: number | null;
  } | null;
  total: number | null;
  totalStatus: string | null;
  continuation: string | null;
  busy: boolean;
  loaded: boolean;
  canLoadMore: boolean;
  canPrevious: boolean;
  pageNumber: number;
  status: string;
  error: string;
}
interface LikedView extends Omit<
  ProfileView,
  'profile' | 'total' | 'totalStatus' | 'items'
> {
  items: LikedPage['items'];
  visibleLikedCount: number | null;
  visibleLikedCountStatus: string | null;
}

/** Real canonical synthetic content, not a policy substitute. Every publication
 * has a distinct exact decision, current event, head, and binding. All normal SQL
 * publication/approval guards remain enabled. Times are explicit fixture history;
 * none is copied into an existing membership's unknown liked_at. */
test(
  'scalable native discovery → normal AppModule → PostgreSQL',
  { timeout: 480000 },
  async (t) => {
    const connectionString = process.env['TEST_DATABASE_URL'];
    assert.ok(
      connectionString,
      'Use disposable loopback whaleu_test; no silent skips',
    );
    const database = new URL(connectionString);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(database.hostname));
    assert.equal(database.pathname, '/whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: connectionString,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '16',
      COMMUNITY_UPDATES_PROCESSING: 'disabled',
    });
    const pool = new Pool(poolOptions(config));
    let app: INestApplication | undefined, suite: PoolClient | undefined;
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
      assert.equal(locked, true, 'Disposable integration suites run serially');
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
      owns = true;
      const migrations = await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      );
      const likedMigration = migrations.findIndex(
        (migration) => migration.name === '0019_community_liked_history.sql',
      );
      assert.ok(likedMigration > 0);
      await runMigrations(pool, migrations.slice(0, likedMigration), {
        mode: 'up',
      });
      const start = async (port = 0) => {
        app = await NestFactory.create(AppModule.register(config), {
          logger: false,
        });
        configureHttp(app);
        await app.listen(port, '127.0.0.1');
      };
      await start();
      const port = Number(new URL(await app!.getUrl()).port);
      const transport = new NodeHttpTransport(port);
      const cancel = new Cancellation();
      const privateValues = new Set<string>();
      const makeClient = async (saved?: SessionCredentials) => {
        const credentials = saved ?? (await createRuntimeActor(app!));
        for (const value of [
          credentials.accountId,
          credentials.sessionId,
          credentials.accessToken,
          credentials.refreshToken,
        ])
          privateValues.add(value);
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
        small = await makeClient(),
        hiddenAuthor = await makeClient();
      const reader = await makeClient(),
        other = await makeClient(),
        hiddenReader = await makeClient(),
        guest = await makeClient();
      guest.sessions.logout();
      const scope = await seedCommunityScope(pool);
      const policyId = await seedReviewPolicy(pool);
      privateValues.add(policyId);
      for (const actor of [author, small, hiddenAuthor, reader]) {
        const facts = await setRuntimeVerification(
          pool,
          actor.credentials.accountId,
          scope.institutionId,
          scope.home.regionId,
        );
        await appendIdentitySelection(
          pool,
          actor.credentials.accountId,
          facts,
          scope,
          scope.home.campusId,
        );
        await actor.profiles.updateProfile(
          {
            expectedRevision: 0,
            nickname:
              actor === author
                ? 'HistoryAuthor'
                : actor === small
                  ? 'SmallAuthor'
                  : actor === reader
                    ? 'Reader'
                    : 'HiddenAuthor',
            bio: '',
          },
          cancel,
        );
      }
      const authorProfileId = (await author.discovery.ownProfileRef(cancel))
        .profileId as string;
      const smallProfileId = (await small.discovery.ownProfileRef(cancel))
        .profileId as string;
      const hiddenProfileId = (
        await hiddenAuthor.discovery.ownProfileRef(cancel)
      ).profileId as string;
      const intent = (text: string): PublishPost => ({
        clientRequestId: randomUUID(),
        spaceId: scope.home.spaceId,
        category: 'discussion',
        text,
        imageAssetIds: [],
        authorMode: 'named',
        commentsPolicy: 'open',
      });
      const seedPosts = async (
        actor: Actor,
        count: number,
        text: string,
        times: (index: number) => string,
        held: (index: number) => boolean,
      ) => {
        const envelope = canonicalEnvelope(
          await postApprovalEnvelope(
            app!,
            pool,
            actor.credentials.accountId,
            intent(text),
          ),
        );
        const digest = approvalDigest(envelope);
        const rows = Array.from({ length: count }, (_, i) => ({
          id: randomUUID(),
          decision: randomUUID(),
          event: randomUUID(),
          at: times(i),
          state: held(i) ? 'held' : 'allow',
        }));
        for (const row of rows) privateValues.add(row.decision);
        await withCommunityScopeWriter(pool, async (tx) => {
          await tx.query(
            'CREATE TEMP TABLE scalable_seed(id uuid, decision uuid, event uuid, at timestamptz, state text) ON COMMIT DROP',
          );
          await tx.query(
            'INSERT INTO scalable_seed SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id uuid,decision uuid,event uuid,at timestamptz,state text)',
            [JSON.stringify(rows)],
          );
          await tx.query(
            `INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy,published_at)
          SELECT id,$1,$2,'discussion',$3,'named','open',at FROM scalable_seed`,
            [scope.home.spaceId, actor.credentials.accountId, text],
          );
          await tx.query(
            `INSERT INTO whaleu_community.content_approval_decisions
          (id,account_id,operation,envelope_version,digest,envelope,policy_revision_id,result,coverage,provenance,issuer,provenance_ref,evaluated_at,consume_until,visibility_model,visibility_until)
          SELECT decision,$1,'publish_post',1,$2,$3::jsonb,$4,'allow','complete','accepted','synthetic-review-owner','scalable-exact-fixture',clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 hour','durable',NULL FROM scalable_seed`,
            [
              actor.credentials.accountId,
              digest,
              JSON.stringify(envelope),
              policyId,
            ],
          );
          await tx.query(`INSERT INTO whaleu_community.content_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
          SELECT event,decision,state,'complete','accepted','synthetic-review-owner','scalable-current-fixture',clock_timestamp() FROM scalable_seed`);
          await tx.query(
            'INSERT INTO whaleu_community.content_approval_heads(decision_id,event_id) SELECT decision,event FROM scalable_seed',
          );
          await tx.query(
            `INSERT INTO whaleu_community.content_approval_bindings(content_kind,content_id,content_version,decision_id,account_id,operation,envelope_version,digest,envelope,scope)
          SELECT 'post',id,1,decision,$1,'publish_post',1,$2,$3::jsonb,$4::jsonb FROM scalable_seed`,
            [
              actor.credentials.accountId,
              digest,
              JSON.stringify(envelope),
              JSON.stringify(envelope.scope),
            ],
          );
        });
        return rows;
      };
      // 1 visible, 300 held, then 1,101 visible, including genuinely old publications.
      const history = await seedPosts(
        author,
        1402,
        'Synthetic scalable named history',
        (i) =>
          i === 1401
            ? '1500-01-01T00:00:00.000Z'
            : i === 1400
              ? '1600-01-01T00:00:00.000Z'
              : i === 1300 || i === 1301
                ? '1800-01-01T00:00:00.000Z'
                : i === 1398 || i === 1399
                  ? '1700-01-01T00:00:00.000Z'
                  : new Date(Date.UTC(2020, 0, 1) - i * 1000).toISOString(),
        (i) => i >= 1 && i <= 300,
      );
      const allHidden = await seedPosts(
        hiddenAuthor,
        270,
        'Synthetic held history',
        (i) => new Date(Date.UTC(2010, 0, 1) - i * 1000).toISOString(),
        () => true,
      );
      const smallPosts = await seedPosts(
        small,
        3,
        'Synthetic small named history',
        (i) => new Date(Date.UTC(2019, 0, 1) - i * 1000).toISOString(),
        () => false,
      );
      const undated = history.slice(-62);
      await pool.query(
        'INSERT INTO whaleu_community.post_likes(post_id,account_id) SELECT unnest($1::uuid[]),$2',
        [undated.map((row) => row.id), reader.credentials.accountId],
      );
      await app!.close();
      app = undefined;
      await runMigrations(pool, migrations, { mode: 'up' });
      await start(port);
      const migrated = (
        await pool.query<{ post_id: string; liked_at: Date | null }>(
          'SELECT post_id,liked_at FROM whaleu_community.post_likes WHERE account_id=$1',
          [reader.credentials.accountId],
        )
      ).rows;
      assert.equal(migrated.length, 62);
      assert.ok(migrated.every((row) => row.liked_at === null));
      await pool.query(
        `INSERT INTO whaleu_community.post_likes(post_id,account_id,liked_at)
      SELECT x.id,$1,x.at FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,at timestamptz)`,
        [reader.credentials.accountId, JSON.stringify(history.slice(0, -62))],
      );
      await pool.query(
        `INSERT INTO whaleu_community.post_likes(post_id,account_id,liked_at)
      SELECT x.id,$1,x.at FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,at timestamptz)`,
        [hiddenReader.credentials.accountId, JSON.stringify(allHidden)],
      );
      const forbiddenAnchors = new Set(
        history.filter((row) => row.state === 'held').map((row) => row.id),
      );
      for (const row of allHidden) forbiddenAnchors.add(row.id);
      const tokens = new Set<string>();
      transport.checkResponse = (path, _status, value) => {
        if (!(
          path.startsWith('/v1/profiles/') || path === '/v1/me/community/liked'
        ))
          return;
        noPrivateFields(value);
        const wire = JSON.stringify(value);
        for (const secret of privateValues)
          assert.ok(
            !wire.includes(secret),
            'Private identity/review escaped response',
          );
        for (const anchor of forbiddenAnchors)
          assert.ok(
            !wire.includes(anchor),
            'Filtered coordinate escaped response',
          );
        if (
          value &&
          typeof value === 'object' &&
          'nextCursor' in value &&
          typeof value.nextCursor === 'string'
        ) {
          const token = value.nextCursor;
          tokens.add(token);
          assert.match(token, /^[A-Za-z0-9_-]{43}$/);
          assert.equal(Buffer.from(token, 'base64url').length, 32);
          assert.throws(
            () => JSON.parse(Buffer.from(token, 'base64url').toString('utf8')),
            'Wire token is random opaque bytes, not encoded metadata',
          );
        }
      };
      const profileList = (
        after: string | null = null,
        limit = 50,
        actor = reader,
        target = authorProfileId,
      ): Promise<PublicPage> =>
        actor.discovery.list(target, 'posts', after, cancel, undefined, limit);
      const likedList = (
        after: string | null = null,
        limit = 50,
        actor = reader,
      ): Promise<LikedPage> => actor.discovery.liked(after, cancel, limit);
      const sameSession = async (actor: Actor) => {
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
        return makeClient({ ...session, accessToken, refreshToken });
      };
      const profilePath = `/v1/profiles/${authorProfileId}/posts`;
      const setPrivacy = async (hidden: boolean) => {
        const current = await author.profiles.profile(cancel);
        await author.profiles.updatePreferences(
          {
            expectedRevision: current.revision,
            preferences: { hideProfilePosts: hidden },
          },
          cancel,
        );
      };
      const walkProfile = async (actor = reader, target = authorProfileId) => {
        const seen = new Set<string>(),
          cursors = new Set<string>();
        let next: string | null = null,
          emptyHops = 0;
        let previous: PostView | null = null;
        do {
          const page = await profileList(next, 50, actor, target);
          assert.equal(page.status, 'available');
          assert.equal(page.total, target === hiddenProfileId ? 0 : 1102);
          assert.equal(page.totalStatus, 'known');
          for (const item of page.items) {
            if (previous)
              assert.ok(
                previous.publishedAt > item.publishedAt ||
                  (previous.publishedAt === item.publishedAt &&
                    previous.id > item.id),
                'Stable dated ordering and UUID tie-break survive page boundaries',
              );
            previous = item;
            assert.ok(!seen.has(item.id));
            seen.add(item.id);
          }
          if (!page.items.length && page.nextCursor) {
            emptyHops++;
            assert.equal(page.continuation, 'scan_pending');
          }
          if (page.nextCursor) {
            assert.ok(!cursors.has(page.nextCursor), 'No cursor cycles');
            cursors.add(page.nextCursor);
          }
          assert.equal(page.continuation === 'end', page.nextCursor === null);
          next = page.nextCursor;
        } while (next);
        return { seen, emptyHops };
      };
      await t.test(
        'histories beyond 1,024 reach oldest named entries and dated-to-undated likes exactly once',
        async () => {
          const basic = await reader.discovery.profile(authorProfileId, cancel);
          assert.equal(basic.status, 'available');
          assert.equal(basic.postCount, 1102);
          assert.equal(basic.postCountStatus, 'known');
          assert.equal(basic.tradeCount, 0);
          assert.equal(basic.tradeCountStatus, 'known');
          const smallBasic = await reader.discovery.profile(
            smallProfileId,
            cancel,
          );
          assert.equal(smallBasic.postCount, 3);
          assert.equal(smallBasic.postCountStatus, 'known');
          const smallPage = await profileList(null, 50, reader, smallProfileId);
          assert.equal(smallPage.total, 3);
          assert.equal(smallPage.totalStatus, 'known');
          assert.equal(smallPage.continuation, 'end');
          const result = await walkProfile();
          assert.equal(result.seen.size, 1102);
          assert.ok(result.emptyHops >= 1);
          for (const row of history.filter((row) => row.state === 'allow'))
            assert.ok(result.seen.has(row.id));
          const seen = new Set<string>(),
            cursors = new Set<string>();
          let cursor: string | null = null,
            undatedStarted = false,
            unknownTimes = 0,
            undatedPages = 0;
          let previous: LikedPage['items'][number] | null = null;
          do {
            const page = await likedList(cursor);
            if (page.items.some((item) => item.likedAt === null))
              undatedPages++;
            assert.equal(page.visibleLikedCount, 1102);
            assert.equal(page.visibleLikedCountStatus, 'known');
            for (const item of page.items) {
              assert.ok(!seen.has(item.targetId));
              if (previous) {
                if (previous.likedAt === item.likedAt)
                  assert.ok(
                    previous.likeId > item.likeId ||
                      (previous.likeId === item.likeId &&
                        previous.kind > item.kind),
                    'Stable membership and kind tie-break',
                  );
                else if (previous.likedAt !== null && item.likedAt !== null)
                  assert.ok(previous.likedAt > item.likedAt);
              }
              previous = item;
              seen.add(item.targetId);
              if (item.likedAt === null) {
                undatedStarted = true;
                unknownTimes++;
              } else
                assert.equal(
                  undatedStarted,
                  false,
                  'Known times cannot resume after the undated section',
                );
            }
            if (page.nextCursor) {
              assert.ok(!cursors.has(page.nextCursor));
              cursors.add(page.nextCursor);
            }
            assert.equal(page.continuation === 'end', page.nextCursor === null);
            cursor = page.nextCursor;
          } while (cursor);
          assert.equal(seen.size, 1102);
          assert.equal(unknownTimes, 62);
          assert.ok(
            undatedPages >= 2,
            'Undated-only continuation reaches subsequent native pages',
          );
          for (const row of undated)
            assert.ok(seen.has(row.id), 'No old-content source-age cutoff');
        },
      );
      await t.test(
        'held-only pages keep scan continuation while an independent proof establishes exact zero',
        async () => {
          const first = await profileList(null, 1);
          assert.deepEqual(
            first.items.map((item) => item.id),
            [history[0]!.id],
          );
          const one = await profileList(first.nextCursor, 1),
            two = await profileList(one.nextCursor, 1);
          for (const page of [one, two]) {
            assert.equal(page.items.length, 0);
            assert.equal(page.continuation, 'scan_pending');
            assert.ok(page.nextCursor);
          }
          const three = await profileList(two.nextCursor, 1);
          assert.deepEqual(
            three.items.map((item) => item.id),
            [history[301]!.id],
          );
          const all = await walkProfile(reader, hiddenProfileId);
          assert.equal(all.seen.size, 0);
          assert.equal(all.emptyHops, 2);
          let next: string | null = null,
            hops = 0;
          do {
            const page = await likedList(next, 50, hiddenReader);
            hops++;
            assert.equal(page.items.length, 0);
            assert.equal(page.visibleLikedCount, 0);
            assert.equal(page.visibleLikedCountStatus, 'known');
            assert.equal(
              page.continuation,
              page.nextCursor ? 'scan_pending' : 'end',
            );
            next = page.nextCursor;
          } while (next);
          assert.equal(hops, 3);
        },
      );
      await t.test(
        'immutable input replay, lost response, restart, and previous visible guard survive empty hops',
        async () => {
          const first = await profileList(null, 1),
            one = await profileList(first.nextCursor, 1),
            two = await profileList(one.nextCursor, 1);
          assert.deepEqual(await profileList(first.nextCursor, 1), one);
          assert.deepEqual(await profileList(one.nextCursor, 1), two);
          const carried = (
            await pool.query<{
              position: { visible: { id: string }; after: { id: string } };
            }>(
              'SELECT position FROM whaleu_community.discovery_cursors WHERE cursor=$1',
              [two.nextCursor],
            )
          ).rows[0]!.position;
          assert.equal(carried.visible.id, history[0]!.id);
          assert.notEqual(
            carried.after.id,
            carried.visible.id,
            'Last authorized visible guard survives multiple empty batches',
          );
          transport.dropSuccess = { path: profilePath, method: 'GET' };
          await assert.rejects(profileList(two.nextCursor, 1));
          const recovered = await profileList(two.nextCursor, 1);
          assert.equal(recovered.items[0]!.id, history[301]!.id);
          await app!.close();
          app = undefined;
          await start(port);
          assert.deepEqual(
            await profileList(two.nextCursor, 1),
            recovered,
            'Durable coordinate survives process restart',
          );
          await setReviewState(pool, history[301]!.decision, 'held');
          const freshReplay = await profileList(two.nextCursor, 1);
          assert.equal(
            freshReplay.items[0]!.id,
            history[302]!.id,
            'Replay reauthorizes output instead of returning cached cards',
          );
          assert.notEqual(freshReplay.nextCursor, recovered.nextCursor);
          await setReviewState(pool, history[301]!.decision, 'allow');
          assert.deepEqual(await profileList(two.nextCursor, 1), recovered);
          await setReviewState(pool, history[0]!.decision, 'held');
          await assert.rejects(
            profileList(two.nextCursor, 1),
            serverFailure('DISCOVERY_RESTART_REQUIRED'),
          );
          await setReviewState(pool, history[0]!.decision, 'allow');
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              'UPDATE whaleu_community.posts SET deleted_at=clock_timestamp() WHERE id=$1',
              [history[0]!.id],
            ),
          );
          await assert.rejects(
            profileList(two.nextCursor, 1),
            serverFailure('DISCOVERY_RESTART_REQUIRED'),
          );
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              'UPDATE whaleu_community.posts SET deleted_at=NULL WHERE id=$1',
              [history[0]!.id],
            ),
          );
          const likedFirst = await likedList(null, 1),
            likedOne = await likedList(likedFirst.nextCursor, 1),
            likedTwo = await likedList(likedOne.nextCursor, 1);
          assert.equal(likedTwo.items.length, 0);
          await withCommunityScopeWriter(pool, async (tx) => {
            await tx.query(
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
              [history[0]!.id],
            );
            await tx.query(
              'DELETE FROM whaleu_community.post_likes WHERE post_id=$1 AND account_id=$2',
              [history[0]!.id, reader.credentials.accountId],
            );
          });
          await assert.rejects(
            likedList(likedTwo.nextCursor, 1),
            serverFailure('DISCOVERY_RESTART_REQUIRED'),
          );
          await pool.query(
            'INSERT INTO whaleu_community.post_likes(post_id,account_id,liked_at) VALUES($1,$2,$3)',
            [history[0]!.id, reader.credentials.accountId, history[0]!.at],
          );
          await assert.rejects(
            likedList(likedTwo.nextCursor, 1),
            serverFailure('DISCOVERY_RESTART_REQUIRED'),
          );
          const freshLike = await likedList(null, 1);
          assert.notEqual(
            freshLike.items[0]!.likeId,
            likedFirst.items[0]!.likeId,
            'Re-like is a new membership identity even at equal fixture time',
          );
        },
      );
      await t.test(
        'every cursor scope dimension rejects cross-owner/session/guest/kind/target/subtype/limit reuse',
        async () => {
          const first = await profileList(null, 1),
            liked = await likedList(null, 1),
            secondSession = await sameSession(reader);
          const bad = serverFailure('BAD_REQUEST');
          for (const actor of [other, guest, secondSession])
            await assert.rejects(profileList(first.nextCursor, 1, actor), bad);
          await assert.rejects(profileList(first.nextCursor, 2), bad);
          await assert.rejects(
            profileList(first.nextCursor, 1, reader, smallProfileId),
            bad,
          );
          await assert.rejects(
            reader.discovery.list(
              authorProfileId,
              'trading',
              first.nextCursor,
              cancel,
              undefined,
              1,
            ),
            bad,
          );
          await assert.rejects(likedList(first.nextCursor, 1), bad);
          await assert.rejects(profileList(liked.nextCursor, 1), bad);
          for (const actor of [other, secondSession])
            await assert.rejects(likedList(liked.nextCursor, 1, actor), bad);
          await assert.rejects(likedList(liked.nextCursor, 2), bad);
          const guestFirst = await profileList(null, 1, guest);
          await assert.rejects(
            profileList(guestFirst.nextCursor, 1, reader),
            bad,
          );
          for (const value of ['bad', 'A'.repeat(44), 'A'.repeat(42) + 'B'])
            await assert.rejects(profileList(value, 1), bad);
          const tradeIntent: PublishPost = {
            ...intent('Synthetic subtype-bound trade'),
            category: 'trading',
            trading: {
              subtype: 'shuma',
              urgency: 'normal',
              price: '1',
              location: 'Synthetic',
              contacts: { wechat: 'SyntheticContact', qq: '', phone: '' },
            },
          };
          for (let i = 0; i < 2; i++) {
            const body = {
              ...tradeIntent,
              clientRequestId: randomUUID(),
              text: `Synthetic subtype-bound trade ${i}`,
            };
            await approveEnvelope(
              pool,
              await postApprovalEnvelope(
                app!,
                pool,
                small.credentials.accountId,
                body,
              ),
            );
            const receipt = await small.community.publishPost(body, cancel);
            assert.equal(receipt.outcome, 'created');
          }
          const trade = await reader.discovery.list(
            smallProfileId,
            'trading',
            null,
            cancel,
            'shuma',
            1,
          );
          assert.ok(trade.nextCursor);
          await assert.rejects(
            reader.discovery.list(
              smallProfileId,
              'trading',
              trade.nextCursor,
              cancel,
              'qiugou',
              1,
            ),
            bad,
          );
          await assert.rejects(
            reader.discovery.list(
              smallProfileId,
              'trading',
              trade.nextCursor,
              cancel,
              undefined,
              1,
            ),
            bad,
          );
        },
      );
      await t.test(
        'missing, expired, corrupt references require safe restart; derivative state is immutable and payload-free',
        async () => {
          const first = await profileList(null, 2),
            cursor = first.nextCursor!;
          const row = (
            await pool.query(
              'SELECT * FROM whaleu_community.discovery_cursors WHERE cursor=$1',
              [cursor],
            )
          ).rows[0]!;
          assert.deepEqual(
            Object.keys(row).sort(),
            [
              'bucket_hash',
              'coordinate_hash',
              'created_at',
              'cursor',
              'expires_at',
              'position',
              'scope_hash',
            ].sort(),
          );
          assert.deepEqual(Object.keys(row.position).sort(), [
            'after',
            'kind',
            'v',
            'visible',
          ]);
          assert.ok(
            !JSON.stringify(row).includes('Synthetic scalable named history'),
          );
          assert.ok(
            !JSON.stringify(row).includes(reader.credentials.accountId),
          );
          await assert.rejects(
            pool.query(
              'UPDATE whaleu_community.discovery_cursors SET position=position||\'{"kind":"liked"}\'::jsonb WHERE cursor=$1',
              [cursor],
            ),
            /immutable/,
          );
          await assert.rejects(
            pool.query(
              "UPDATE whaleu_community.discovery_cursors SET expires_at=expires_at+interval '1 day' WHERE cursor=$1",
              [cursor],
            ),
            /immutable/,
          );
          await pool.query(
            'DELETE FROM whaleu_community.discovery_cursors WHERE cursor=$1',
            [cursor],
          );
          await assert.rejects(
            profileList(cursor, 2),
            serverFailure('DISCOVERY_RESTART_REQUIRED'),
          );
          await assert.rejects(
            profileList(randomBytes(32).toString('base64url'), 2),
            serverFailure('DISCOVERY_RESTART_REQUIRED'),
          );
          const insert = (position: unknown, created: Date, expires: Date) =>
            pool.query(
              `INSERT INTO whaleu_community.discovery_cursors(cursor,scope_hash,bucket_hash,coordinate_hash,position,created_at,expires_at) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)`,
              [
                cursor,
                row.scope_hash,
                row.bucket_hash,
                row.coordinate_hash,
                JSON.stringify(position),
                created,
                expires,
              ],
            );
          await insert(
            row.position,
            new Date(Date.now() - 172800000),
            new Date(Date.now() - 86400000),
          );
          await assert.rejects(
            profileList(cursor, 2),
            serverFailure('DISCOVERY_RESTART_REQUIRED'),
          );
          const fresh = await profileList(null, 2);
          assert.notEqual(
            fresh.nextCursor,
            cursor,
            'Exact coordinate cannot revive an expired reference',
          );
          await assert.rejects(
            profileList(cursor, 2),
            serverFailure('DISCOVERY_RESTART_REQUIRED'),
          );
          await pool.query(
            'DELETE FROM whaleu_community.discovery_cursors WHERE cursor=$1',
            [fresh.nextCursor],
          );
          await insert(
            {
              ...row.position,
              after: { ...row.position.after, id: randomUUID() },
            },
            row.created_at,
            row.expires_at,
          );
          await assert.rejects(
            profileList(cursor, 2),
            serverFailure('DISCOVERY_RESTART_REQUIRED'),
          );
          await pool.query(
            'DELETE FROM whaleu_community.discovery_cursors WHERE cursor=$1',
            [cursor],
          );
          const state = await pool.query(
            "SELECT table_name FROM information_schema.tables WHERE table_schema='whaleu_community' AND table_name LIKE 'discovery%'",
          );
          assert.deepEqual(state.rows.map((item) => item.table_name).sort(), [
            'discovery_count_epochs',
            'discovery_cursors',
          ]);
        },
      );
      await t.test(
        'bounded per-owner cursor cleanup never caps forward traversal or revives evicted refs',
        async () => {
          let page = await profileList(null, 1),
            cursor = page.nextCursor;
          const oldest = cursor;
          const ids = new Set(page.items.map((item) => item.id));
          for (let hop = 0; hop < 265; hop++) {
            page = await profileList(cursor, 1);
            for (const item of page.items) {
              assert.ok(!ids.has(item.id));
              ids.add(item.id);
            }
            assert.ok(
              page.nextCursor,
              'History remains traversable after quota pruning',
            );
            cursor = page.nextCursor;
          }
          assert.ok(ids.size > 256);
          const bucket = discoveryCursorBucket(reader.credentials.accountId);
          assert.ok(
            (
              await pool.query<{ n: number }>(
                'SELECT count(*)::integer AS n FROM whaleu_community.discovery_cursors WHERE bucket_hash=$1',
                [bucket.hash],
              )
            ).rows[0]!.n <= 256,
          );
          await assert.rejects(
            profileList(oldest, 1),
            serverFailure('DISCOVERY_RESTART_REQUIRED'),
          );
          const last = await profileList(cursor, 1);
          assert.ok(last.items.length);
          const newFirst = await profileList(null, 1);
          assert.notEqual(newFirst.nextCursor, oldest);
          await assert.rejects(
            profileList(oldest, 1),
            serverFailure('DISCOVERY_RESTART_REQUIRED'),
          );
          // Explicit cleanup touches only expired derivative metadata, never content.
          const tx = await pool.connect();
          try {
            await tx.query('BEGIN');
            assert.equal(
              await app!.get(DiscoveryCursorRepository).cleanupExpired(tx, 256),
              0,
            );
            await tx.query('COMMIT');
          } finally {
            tx.release();
          }
          assert.equal(
            (
              await pool.query<{ n: number }>(
                'SELECT count(*)::integer AS n FROM whaleu_community.posts WHERE account_id=$1',
                [author.credentials.accountId],
              )
            ).rows[0]!.n,
            1402,
          );
        },
      );
      await t.test(
        'privacy, block, inactive owner, and revoked session are freshly checked on valid continuation',
        async () => {
          const first = await profileList(null, 1);
          await setPrivacy(true);
          const hidden = await profileList(first.nextCursor, 1);
          assert.equal(hidden.status, 'hidden');
          assert.equal(hidden.total, 0);
          assert.equal(hidden.totalStatus, 'known');
          assert.equal(hidden.continuation, 'end');
          assert.equal(hidden.nextCursor, null);
          assert.equal(hidden.items.length, 0);
          const basics = await reader.discovery.profile(
            authorProfileId,
            cancel,
          );
          assert.equal(basics.postsHidden, true);
          assert.equal(basics.postCount, 0);
          assert.equal(basics.postCountStatus, 'known');
          await setPrivacy(false);
          const likeBeforeBlock = await likedList(null, 1);
          const likeEmptyOne = await likedList(likeBeforeBlock.nextCursor, 1);
          const likeEmptyTwo = await likedList(likeEmptyOne.nextCursor, 1);
          const block = await reader.blocks.apply(
            {
              operation: 'block_named',
              blocked: true,
              clientRequestId: randomUUID(),
              source: { kind: 'profile', id: authorProfileId },
            },
            cancel,
          );
          assert.equal(block.receipt.outcome, 'applied');
          assert.equal(
            (await profileList(first.nextCursor, 1)).status,
            'blocked_by_you',
          );
          await assert.rejects(
            likedList(likeEmptyTwo.nextCursor, 1),
            serverFailure('DISCOVERY_RESTART_REQUIRED'),
          );
          const likerFirst = await likedList(null, 1); // The entire named target is filtered now.
          assert.equal(likerFirst.items.length, 0);
          await reader.blocks.apply(
            {
              operation: 'unblock_named',
              blocked: false,
              clientRequestId: randomUUID(),
              relationshipId: block.receipt.relationshipId,
              expectedRevision: block.receipt.revision,
            },
            cancel,
          );
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
              [author.credentials.accountId],
            ),
          );
          assert.equal(
            (await profileList(first.nextCursor, 1)).status,
            'unavailable',
          );
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              "UPDATE whaleu_identity.accounts SET status='active' WHERE id=$1",
              [author.credentials.accountId],
            ),
          );
          const disposable = await sameSession(reader),
            ownFirst = await profileList(null, 1, disposable);
          await pool.query(
            "UPDATE whaleu_identity.sessions SET revoked_at=clock_timestamp(),revoke_reason='logout' WHERE id=$1",
            [disposable.credentials.sessionId],
          );
          await assert.rejects(
            profileList(ownFirst.nextCursor, 1, disposable),
            serverFailure('SESSION_REVOKED'),
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
      const profilePage = (actor: Actor, target = authorProfileId) => {
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
        'real native pending/Previous/branch/duplicate taps/cancel/hide/session navigation drops old cards without auto work',
        async () => {
          const page = profilePage(reader);
          await page.controller.load();
          assert.equal(page.view().items.length, 1);
          assert.equal(page.view().continuation, 'scan_pending');
          assert.equal(page.view().total, 1102);
          const requestCount = transport.exchanges.length;
          await new Promise((resolve) => setTimeout(resolve, 20));
          assert.equal(
            transport.exchanges.length,
            requestCount,
            'No automatic hidden-range polling',
          );
          const gate = transport.holdNext(profilePath);
          const more = page.controller.more();
          await gate.arrived;
          await page.controller.more();
          assert.equal(page.view().items.length, 0);
          gate.release();
          await more;
          assert.equal(page.view().pageNumber, 2);
          assert.equal(page.view().items.length, 0);
          assert.equal(page.view().canLoadMore, true);
          assert.equal(page.view().continuation, 'scan_pending');
          assert.ok(!page.view().status.includes('没有'));
          assert.equal(
            transport.exchanges.length,
            requestCount + 2,
            'One basic and one list read despite duplicate tap',
          );
          await page.controller.previous();
          assert.equal(page.view().pageNumber, 1);
          assert.equal(page.view().items.length, 1);
          await page.controller.more();
          assert.equal(page.view().pageNumber, 2);
          await page.controller.more();
          assert.equal(page.view().pageNumber, 3);
          assert.ok(page.view().items.length > 0);
          await page.controller.previous();
          assert.equal(page.view().items.length, 0);
          assert.equal(page.view().pageNumber, 2);
          await page.controller.more();
          assert.equal(
            page.view().pageNumber,
            3,
            'Previous then branch does not trip stale future cursor history',
          );
          const hold = transport.holdNext(profilePath),
            pending = page.controller.load();
          await hold.arrived;
          page.controller.cancel();
          hold.release();
          await pending;
          assert.equal(page.view().items.length, 0);
          assert.equal(page.view().canLoadMore, false);
          await page.controller.load();
          await setPrivacy(true);
          await page.controller.more();
          assert.equal(page.view().items.length, 0);
          assert.equal(page.view().profile?.postsHidden, true);
          assert.equal(page.view().canPrevious, false);
          await setPrivacy(false);
          await page.controller.setTarget(smallProfileId);
          assert.equal(page.view().items.length, 3);
          assert.equal(page.view().profile?.postCount, 3);
          await page.controller.setTarget(authorProfileId);
          await page.controller.setTab('trading');
          assert.equal(page.view().items.length, 0);
          assert.equal(page.view().total, 0);
          assert.equal(page.view().continuation, 'end');
          assert.equal(
            page.storage.values.size,
            0,
            'No old cards/cursors persisted',
          );
          page.controller.dispose();
          const likes = likedPage(hiddenReader);
          await likes.controller.load();
          assert.equal(likes.view().items.length, 0);
          assert.equal(likes.view().canLoadMore, true);
          assert.equal(likes.view().visibleLikedCount, 0);
          await likes.controller.more();
          await likes.controller.more();
          assert.equal(likes.view().continuation, 'end');
          assert.equal(likes.view().visibleLikedCountStatus, 'known');
          assert.ok(likes.view().status.includes('没有'));
          assert.equal(likes.storage.values.size, 0);
          likes.controller.dispose();
          const session = await sameSession(reader),
            sessionPage = profilePage(session);
          await sessionPage.controller.load();
          session.sessions.completeLogin(
            session.sessions.beginLogin(),
            (await sameSession(reader)).credentials,
          );
          assert.equal(sessionPage.view().items.length, 0);
          assert.equal(sessionPage.view().canLoadMore, false);
          assert.equal(sessionPage.view().canPrevious, false);
          sessionPage.controller.dispose();
        },
      );
      assert.ok(tokens.size > 256);
      assert.ok(
        transport.exchanges.every((exchange) =>
          exchange.path.startsWith('/v1/'),
        ),
        'No external provider or automatic contact actions',
      );
      assert.equal(smallPosts.length, 3);
    } finally {
      try {
        await app?.close();
      } finally {
        try {
          if (owns)
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
