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
} from '../../src/community/contracts.js';
import { CommunityAccessService } from '../../src/community/community-access.service.js';
import { CommunityRepository } from '../../src/community/community.repository.js';
import { loadConfig } from '../../src/config/config.js';
import {
  DatabaseService,
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
import {
  createRuntimeActor,
  setRuntimeVerification,
  postApprovalEnvelope,
  discussionApprovalEnvelope,
} from '../support/community-runtime-fixtures.js';
import {
  seedCommunityScope,
  appendTopologyRevision,
  appendIdentitySelection,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';
import {
  seedReviewPolicy,
  approveEnvelope,
} from '../support/community-approval-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

// Only platform I/O is bridged. Every owner, policy, approval, decoder, gateway,
// controller and transaction below is the ordinary runtime implementation.
// Synthetic canonical inputs may be established by guarded disposable helpers;
// successful identity choices must be created by the real own-account endpoint.
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
  HttpCommunityGateway,
} = require('../../../wechat/src/community/gateway.ts');
const {
  createCommunityRuntime,
} = require('../../../wechat/src/community/runtime.ts');
const {
  ComposeController,
  initialComposeView,
} = require('../../../wechat/src/pages/community-compose/controller.ts');
const nativeOrigin = 'https://native-contract.invalid';
const selectorPath = '/v1/me/identity-campus';

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
                url.pathname.startsWith('/v1/me/identity-campus')
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
        'phoneNumber',
        'studentNumber',
        'assertionId',
        'snapshotId',
        'selectionId',
        'affiliationAssertionId',
        'affiliationSnapshotId',
        'topologySnapshotId',
        'originRegionId',
        'institutionId',
        'sourceReference',
        'policyReference',
        'issuer',
        'role',
        'roles',
        'grants',
        'phoneBindingReference',
        'selection_id',
      ].includes(key),
      `Own-campus public DTO leaked ${key}`,
    );
    noPrivateFields(child);
  }
}
interface ComposeView {
  loaded: boolean;
  text: string;
  canSubmit: boolean;
  blocker: string;
}

interface SelectionView {
  readonly loaded: boolean;
  readonly busy: boolean;
  readonly state:
    import('../../src/identity-campus/contracts.js').IdentityCampusState | null;
  readonly selectedId: string;
  readonly frozen: boolean;
  readonly confirmation: { readonly id: string } | null;
  readonly receiptStatus: string;
  readonly status: string;
  readonly error: string;
}
const {
  HttpIdentityCampusGateway,
} = require('../../../wechat/src/identity-campus/gateway.ts');
const {
  createIdentityCampusRuntime,
} = require('../../../wechat/src/identity-campus/runtime.ts');
const {
  PendingIdentityCampusStore,
} = require('../../../wechat/src/identity-campus/pending.ts');
const {
  IdentityCampusController,
  initialIdentityCampusView,
} = require('../../../wechat/src/pages/identity-campus/controller.ts');

test(
  'real native identity-campus selection → normal AppModule → current community scope',
  { timeout: 120000 },
  async (t) => {
    const connectionString = process.env['TEST_DATABASE_URL'];
    assert.ok(
      connectionString,
      'Set TEST_DATABASE_URL to disposable loopback whaleu_test; no silent skips',
    );
    const url = new URL(connectionString);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: connectionString,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '8',
      COMMUNITY_UPDATES_PROCESSING: 'disabled',
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
      assert.equal(locked, true, 'Run disposable integration suites serially');
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
      app = await NestFactory.create(AppModule.register(config), {
        logger: false,
      });
      configureHttp(app);
      await app.listen(0, '127.0.0.1');
      const http = app.getHttpServer(),
        transport = new NodeHttpTransport(
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
          { login: async () => 'no-provider-configured' },
          systemClock,
        );
        const api = new ApiClient(nativeOrigin, transport, sessions, auth);
        return {
          credentials,
          sessions,
          auth,
          api,
          identityCampus: new HttpIdentityCampusGateway(api),
          profiles: new HttpProfileGateway(api),
          community: new HttpCommunityGateway(api),
        };
      };
      type Actor = Awaited<ReturnType<typeof makeClient>>;
      const actor = await makeClient(),
        other = await makeClient();
      const protectedTables = [
        'whaleu_verification.assertions',
        'whaleu_verification.snapshots',
        'whaleu_verification.events',
        'whaleu_verification.account_heads',
        'whaleu_authorization.role_grants',
        'whaleu_campus.community_topology_snapshots',
        'whaleu_campus.community_topology_heads',
        'whaleu_community.region_policy_revisions',
        'whaleu_community.region_policy_heads',
      ] as const;
      const snapshot = async (tables: readonly string[]) =>
        Promise.all(
          tables.map(async (table) => ({
            table,
            rows: (
              await pool.query(
                `SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`,
              )
            ).rows,
          })),
        );
      const selectionRows = async (owner = actor) =>
        (
          await pool.query(
            'SELECT * FROM whaleu_campus.community_identity_selections WHERE account_id=$1 ORDER BY revision',
            [owner.credentials.accountId],
          )
        ).rows;
      const selectionHead = async (owner = actor) =>
        (
          await pool.query(
            'SELECT * FROM whaleu_campus.community_identity_heads WHERE account_id=$1',
            [owner.credentials.accountId],
          )
        ).rows;
      const writes = (method: string, path: string) =>
        transport.exchanges.filter(
          (x) => x.method === method && x.path === path,
        ).length;
      const privateIds = new Set<string>([
        actor.credentials.accountId,
        other.credentials.accountId,
      ]);
      transport.checkResponse = (path, status, value) => {
        if (path.startsWith(selectorPath) && status === 200) {
          noPrivateFields(value);
          const json = JSON.stringify(value);
          for (const id of privateIds)
            assert.ok(
              !json.includes(id),
              'Own-campus response leaked a private authority reference',
            );
        }
      };
      const selector = (owner = actor, storage = memoryStorage()) => {
        const runtime = createIdentityCampusRuntime(
          owner,
          storage,
          nativeOrigin,
          async () => randomUUID(),
        );
        let view: SelectionView = initialIdentityCampusView();
        const controller = new IdentityCampusController(
          runtime,
          (next: SelectionView) => {
            view = next;
          },
        );
        return { runtime, storage, controller, view: () => view };
      };
      await t.test(
        'startup, repeated owner GET and ordinary sessions never manufacture authority',
        async () => {
          const before = await snapshot([
            ...protectedTables,
            'whaleu_campus.community_identity_heads',
            'whaleu_campus.community_identity_selections',
            'whaleu_campus.identity_selection_requests',
          ]);
          for (let n = 0; n < 3; n++) {
            const state = await actor.identityCampus.state(cancel);
            assert.equal(state.affiliation, 'unavailable');
            assert.equal(state.selection, 'unavailable');
            assert.equal(state.options.status, 'unavailable');
            assert.deepEqual(state.options.items, []);
            assert.equal(state.selectedCampus, null);
            assert.equal(state.canSelect, false);
            assert.equal(state.expectedStateRevision, null);
            assert.ok(Object.isFrozen(state));
          }
          assert.deepEqual(
            await snapshot([
              ...protectedTables,
              'whaleu_campus.community_identity_heads',
              'whaleu_campus.community_identity_selections',
              'whaleu_campus.identity_selection_requests',
            ]),
            before,
          );
          const login = await request(http)
            .post('/v1/auth/wechat/login')
            .send({ code: 'no-provider-bypass' });
          assert.equal(login.body.error.code, 'AUTH_NOT_CONFIGURED');
          assert.equal((await request(http).get(selectorPath)).status, 401);
        },
      );
      const scope = await seedCommunityScope(pool);
      privateIds.add(scope.institutionId);
      privateIds.add(scope.topologySnapshotId);
      const verify = async (
        owner: Actor,
        affiliation: 'verified' | 'unverified' | 'unavailable' = 'verified',
        phone: 'verified' | 'unverified' | 'unavailable' = 'verified',
      ) => {
        const facts = await setRuntimeVerification(
          pool,
          owner.credentials.accountId,
          scope.institutionId,
          scope.home.regionId,
          affiliation,
          phone,
        );
        privateIds.add(facts.assertionId);
        privateIds.add(facts.snapshotId);
        return facts;
      };
      await verify(actor);
      const browseBefore = await actor.profiles.profile(cancel);
      const browsing = await actor.profiles.selectCampus(
        {
          expectedRevision: browseBefore.revision,
          campusId: scope.foreign.campusId,
        },
        cancel,
      );
      assert.equal(browsing.selectedCampus.id, scope.foreign.campusId);
      await t.test(
        'canonical affiliation without any student number offers only explicit same-group physical campuses',
        async () => {
          const state = await actor.identityCampus.state(cancel);
          assert.equal(state.affiliation, 'verified');
          assert.equal(state.selection, 'unavailable');
          assert.equal(state.reason, 'history_unknown');
          assert.equal(state.options.status, 'known');
          assert.deepEqual(
            state.options.items.map((item: { id: string }) => item.id).sort(),
            [scope.home.campusId, scope.related.campusId].sort(),
          );
          assert.equal(state.canSelect, true);
          assert.match(state.expectedStateRevision, /^ic1:[a-f0-9]{64}$/);
          assert.deepEqual(await selectionRows(), []);
          assert.deepEqual(await selectionHead(), []);
          assert.equal(
            (
              await pool.query(
                "SELECT count(*)::integer count FROM whaleu_verification.assertions WHERE fact_kind='student_number'",
              )
            ).rows[0].count,
            0,
          );
          const cap = await actor.community.capabilities(
            scope.home.spaceId,
            'discussion',
            cancel,
          );
          assert.equal(cap.publish.availability, 'unavailable');
          assert.equal(
            cap.publish.reason,
            'COMMUNITY_UNAVAILABLE',
            'Missing history must not be invented as known choice_required',
          );
        },
      );
      await t.test(
        'readable missing-phone, restricted-safety and unknown-affiliation states do not grant writes or create a head',
        async () => {
          for (const phone of ['unverified', 'unavailable'] as const) {
            const blocked = await makeClient();
            await verify(blocked, 'verified', phone);
            const state = await blocked.identityCampus.state(cancel);
            assert.equal(state.writeEligibility.phone, phone);
            assert.equal(state.options.status, 'known');
            assert.equal(state.options.items.length, 2);
            assert.equal(state.canSelect, false);
            assert.equal(state.expectedStateRevision, null);
            assert.deepEqual(await selectionHead(blocked), []);
          }
          await verify(other, 'unavailable');
          const unknown = await other.identityCampus.state(cancel);
          assert.equal(unknown.affiliation, 'unavailable');
          assert.equal(unknown.options.status, 'unavailable');
          assert.equal(unknown.canSelect, false);
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=$1',
              [actor.credentials.accountId],
            ),
          );
          const restricted = await actor.identityCampus.state(cancel);
          assert.equal(restricted.writeEligibility.safety, 'restricted');
          assert.equal(restricted.options.items.length, 2);
          assert.equal(restricted.canSelect, false);
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              "UPDATE whaleu_safety.account_heads SET actions_allowed=true,block_coverage='missing' WHERE account_id=$1",
              [actor.credentials.accountId],
            ),
          );
          const missing = await actor.identityCampus.state(cancel);
          assert.equal(missing.writeEligibility.safety, 'unavailable');
          assert.equal(missing.canSelect, false);
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              "UPDATE whaleu_safety.account_heads SET block_coverage='complete' WHERE account_id=$1",
              [actor.credentials.accountId],
            ),
          );
          assert.deepEqual(await selectionHead(), []);
        },
      );
      await t.test(
        'active catalog omissions are unavailable, while reviewed complete empty and singleton sets remain distinct',
        async () => {
          const unexplained = randomUUID();
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              "INSERT INTO whaleu_campus.campuses(id,institution_id,full_name,district,is_active) VALUES($1,$2,'Unreviewed active campus','synthetic',true)",
              [unexplained, scope.institutionId],
            ),
          );
          const missing = await actor.identityCampus.state(cancel);
          assert.equal(missing.options.status, 'unavailable');
          assert.deepEqual(missing.options.items, []);
          assert.equal(missing.canSelect, false);
          assert.deepEqual(await selectionHead(), []);
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              'UPDATE whaleu_campus.campuses SET is_active=false WHERE id=$1',
              [unexplained],
            ),
          );
          for (const empty of [true, false]) {
            const ids = empty
              ? [scope.home.campusId, scope.related.campusId]
              : [scope.related.campusId];
            await withCommunityScopeWriter(pool, (tx) =>
              tx.query(
                'UPDATE whaleu_campus.campuses SET is_active=(id<>ALL($1::uuid[])) WHERE institution_id=$2',
                [[...ids, unexplained], scope.institutionId],
              ),
            );
            const topology = structuredClone(scope.topology);
            for (const assignment of topology.assignments)
              if (ids.includes(assignment.campusId))
                assignment.isActive = false;
            scope.topologySnapshotId = await appendTopologyRevision(
              pool,
              topology,
            );
            privateIds.add(scope.topologySnapshotId);
            const state = await actor.identityCampus.state(cancel);
            assert.equal(state.options.status, 'known');
            assert.equal(state.options.items.length, empty ? 0 : 1);
            assert.equal(state.canSelect, !empty);
            const page = selector();
            await page.controller.load();
            assert.equal(
              writes('PUT', selectorPath),
              0,
              'Neither empty nor singleton GET automatically saves',
            );
            page.controller.cancel();
            page.controller.dispose();
            assert.deepEqual(await selectionHead(), []);
          }
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              'UPDATE whaleu_campus.campuses SET is_active=true WHERE id=ANY($1::uuid[])',
              [[scope.home.campusId, scope.related.campusId]],
            ),
          );
          scope.topologySnapshotId = await appendTopologyRevision(
            pool,
            scope.topology,
          );
          privateIds.add(scope.topologySnapshotId);
        },
      );
      const platform = platformStorage(),
        communityRuntime = createCommunityRuntime(
          actor,
          platform,
          nativeOrigin,
          systemClock,
        );
      const postTarget = {
        operation: 'publish_post',
        spaceId: scope.home.spaceId,
        category: 'discussion',
      };
      let composeView: ComposeView = initialComposeView();
      let composer = new ComposeController(
        communityRuntime,
        postTarget,
        (next: ComposeView) => {
          composeView = next;
        },
      );
      await composer.load();
      composer.setText(
        'Preserved unsent text, exact original home destination',
      );
      const draftBefore = communityRuntime.drafts.load(
        actor.credentials.accountId,
        `post:${scope.home.spaceId}:discussion`,
      );
      const beforeSelection = await snapshot([
        ...protectedTables,
        'whaleu_profile.profiles',
      ]);
      let firstReceipt: import('../../src/identity-campus/contracts.js').IdentityCampusReceipt;
      await t.test(
        'explicit confirmation alone creates a real choice, keeps browsing and draft intact, and never publishes',
        async () => {
          const page = selector();
          await page.controller.load();
          assert.equal(
            page.view().selectedId,
            '',
            'Unknown history does not select preferred browse or first candidate',
          );
          page.controller.choose(scope.related.campusId);
          assert.equal(page.view().selectedId, scope.related.campusId);
          page.controller.requestConfirmation();
          assert.equal(page.view().confirmation?.id, scope.related.campusId);
          page.controller.dismissConfirmation();
          await page.controller.confirm();
          assert.equal(writes('PUT', selectorPath), 0);
          page.controller.cancel();
          assert.deepEqual(await selectionRows(), []);
          await page.controller.load();
          page.controller.choose(scope.related.campusId);
          page.controller.requestConfirmation();
          const simultaneous = [
            page.controller.confirm(),
            page.controller.confirm(),
          ];
          await Promise.all(simultaneous);
          assert.equal(
            writes('PUT', selectorPath),
            1,
            'Duplicate confirmation has one dispatch',
          );
          const events = await selectionRows();
          assert.equal(events.length, 1);
          assert.equal(events[0].campus_id, scope.related.campusId);
          assert.equal(events[0].selection_state, 'selected');
          assert.equal(events[0].coverage_state, 'complete');
          assert.equal(events[0].provenance_state, 'accepted');
          assert.equal(
            events[0].topology_snapshot_id,
            scope.topologySnapshotId,
          );
          assert.equal((await selectionHead())[0].selection_id, events[0].id);
          privateIds.add(events[0].id);
          assert.equal(page.view().state?.selection, 'valid');
          assert.equal(
            page.view().state?.selectedCampus?.id,
            scope.related.campusId,
          );
          assert.equal(
            page.runtime.pending.load(actor.credentials.accountId),
            null,
          );
          const receipts = (
            await pool.query(
              'SELECT client_request_id FROM whaleu_campus.identity_selection_requests WHERE account_id=$1',
              [actor.credentials.accountId],
            )
          ).rows;
          assert.equal(receipts.length, 1);
          firstReceipt = await actor.identityCampus.receipt(
            receipts[0].client_request_id,
            cancel,
          );
          assert.equal(firstReceipt.outcome, 'applied');
          assert.equal(firstReceipt.selectionRevision, 1);
          assert.deepEqual(
            await snapshot([...protectedTables, 'whaleu_profile.profiles']),
            beforeSelection,
          );
          assert.deepEqual(await actor.profiles.profile(cancel), browsing);
          assert.deepEqual(
            communityRuntime.drafts.load(
              actor.credentials.accountId,
              `post:${scope.home.spaceId}:discussion`,
            ),
            draftBefore,
          );
          assert.equal(composeView.text, draftBefore.text);
          assert.equal(writes('POST', '/v1/community/posts'), 0);
          assert.equal(
            (
              await pool.query(
                'SELECT count(*)::integer count FROM whaleu_community.posts',
              )
            ).rows[0].count,
            0,
          );
          page.controller.dispose();
        },
      );
      await t.test(
        'normal community resolution consumes the HTTP-created event, without bypassing review or granting management',
        async () => {
          const resolved = await app!
            .get(DatabaseService)
            .transaction(async (tx) => {
              const access = app!.get(CommunityAccessService);
              const accountId = await access.actor(
                actor.credentials.accessToken,
                tx,
              );
              const space = await app!
                .get(CommunityRepository)
                .space(scope.home.spaceId, tx);
              return access.authority(accountId, space, tx, {
                publication: true,
              });
            });
          assert.equal(resolved.runtime, true);
          assert.equal(resolved.identityStatus, 'valid');
          assert.equal(resolved.identityRegionId, scope.related.regionId);
          assert.equal(resolved.scopeRelation, 'related');
          assert.equal(
            resolved.publicationScope?.identityCampusId,
            scope.related.campusId,
          );
          assert.equal(
            resolved.publicationScope?.identitySelectionId,
            (await selectionRows())[0].id,
          );
          assert.equal(
            resolved.publicationScope?.originalSpaceId,
            scope.home.spaceId,
          );
          assert.equal(resolved.canManage, false);
          const cap = await actor.community.capabilities(
            scope.home.spaceId,
            'discussion',
            cancel,
          );
          assert.deepEqual(cap.authorModes, ['named', 'anonymous']);
          assert.equal(cap.publish.reason, 'CONTENT_REVIEW_UNAVAILABLE');
          await composer.load();
          assert.equal(composeView.text, draftBefore.text);
          assert.equal(composeView.canSubmit, false);
          assert.match(composeView.blocker, /审核/);
          await composer.submit();
          assert.equal(
            writes('POST', '/v1/community/posts'),
            0,
            'Campus confirmation never substitutes for approval',
          );
        },
      );
      await seedReviewPolicy(pool);
      const post: PublishPost = {
        clientRequestId: randomUUID(),
        spaceId: scope.home.spaceId,
        category: 'discussion',
        text: 'Synthetic accepted historical publication',
        imageAssetIds: [],
        authorMode: 'named',
        commentsPolicy: 'open',
      };
      await approveEnvelope(
        pool,
        await postApprovalEnvelope(
          app!,
          pool,
          actor.credentials.accountId,
          post,
        ),
      );
      const created = await actor.community.publishPost(post, cancel);
      assert.equal(created.outcome, 'created');
      const rootInput: PublishComment = {
        clientRequestId: randomUUID(),
        text: 'Synthetic accepted historical root',
        authorMode: 'named',
        imageAssetIds: [],
      };
      await approveEnvelope(
        pool,
        await discussionApprovalEnvelope(
          app!,
          pool,
          actor.credentials.accountId,
          created.resourceId,
          rootInput,
        ),
      );
      const root = await actor.community.publishComment(
        created.resourceId,
        rootInput,
        cancel,
      );
      assert.equal(root.outcome, 'created');
      const historyTables = [
        'whaleu_community.posts',
        'whaleu_community.root_comments',
        'whaleu_community.content_approval_bindings',
        'whaleu_community.content_approval_decisions',
        'whaleu_community.publication_requests',
      ];
      await t.test(
        'reselections only affect future scope; post, root and reply drafts stay bound to their original target and never send',
        async () => {
          composer.dispose();
          const targets = [
            postTarget,
            { operation: 'publish_comment', postId: created.resourceId },
            {
              operation: 'publish_reply',
              postId: created.resourceId,
              rootCommentId: root.resourceId,
              targetReplyId: null,
            },
          ];
          const draftKeys = [
            `post:${scope.home.spaceId}:discussion`,
            `comment:${created.resourceId}`,
            `reply:${created.resourceId}:${root.resourceId}:root`,
          ];
          const controllers = targets.map(
            (target) =>
              new ComposeController(communityRuntime, target, () => undefined),
          );
          for (const [index, editor] of controllers.entries()) {
            await editor.load();
            editor.setText(
              `Unsent draft ${index}: retain parent, identity and destination`,
            );
          }
          const drafts = draftKeys.map((key) =>
            communityRuntime.drafts.load(actor.credentials.accountId, key),
          );
          const before = await snapshot([
            ...protectedTables,
            'whaleu_profile.profiles',
            ...historyTables,
          ]);
          const postsSent = transport.exchanges.filter(
            (x) => x.method === 'POST',
          ).length;
          const page = selector();
          await page.controller.load();
          page.controller.choose(scope.home.campusId);
          page.controller.requestConfirmation();
          await page.controller.confirm();
          assert.equal(
            page.view().state?.selectedCampus?.id,
            scope.home.campusId,
          );
          assert.equal((await selectionRows()).length, 2);
          assert.deepEqual(
            await snapshot([
              ...protectedTables,
              'whaleu_profile.profiles',
              ...historyTables,
            ]),
            before,
          );
          const bound = (
            await pool.query(
              'SELECT scope FROM whaleu_community.content_approval_bindings WHERE content_id=$1',
              [created.resourceId],
            )
          ).rows[0].scope;
          assert.equal(bound.identityCampusId, scope.related.campusId);
          assert.equal(bound.originalSpaceId, scope.home.spaceId);
          assert.equal(bound.originalRegionId, scope.home.regionId);
          for (const editor of controllers) {
            editor.dispose();
          }
          for (const [index, target] of targets.entries()) {
            let view: ComposeView = initialComposeView();
            const restored = new ComposeController(
              communityRuntime,
              target,
              (next: ComposeView) => {
                view = next;
              },
            );
            await restored.load();
            assert.equal(view.text, drafts[index].text);
            assert.deepEqual(
              communityRuntime.drafts.load(
                actor.credentials.accountId,
                draftKeys[index],
              ),
              drafts[index],
            );
            restored.dispose();
          }
          assert.equal(
            transport.exchanges.filter((x) => x.method === 'POST').length,
            postsSent,
          );
          assert.equal(
            await actor.community
              .post(created.resourceId, cancel)
              .then((value: { text: string }) => value.text),
            post.text,
          );
          page.controller.dispose();
          composer = new ComposeController(
            communityRuntime,
            postTarget,
            (next: ComposeView) => {
              composeView = next;
            },
          );
        },
      );
      await t.test(
        'same-ID current choice is unchanged; changed bindings need a refreshed explicit confirmation',
        async () => {
          const current = await actor.identityCampus.state(cancel);
          const unchanged = await actor.identityCampus.select(
            {
              requestId: randomUUID(),
              campusId: scope.home.campusId,
              expectedStateRevision: current.expectedStateRevision,
            },
            cancel,
          );
          assert.equal(unchanged.outcome, 'unchanged');
          assert.equal(unchanged.selectionRevision, 2);
          assert.equal((await selectionRows()).length, 2);
          const page = selector();
          await page.controller.load();
          page.controller.choose(scope.home.campusId);
          page.controller.requestConfirmation();
          const history = await selectionRows();
          const facts = await verify(actor);
          const count = writes('PUT', selectorPath);
          await page.controller.confirm();
          assert.equal(writes('PUT', selectorPath), count + 1);
          assert.deepEqual(await selectionRows(), history);
          assert.equal(
            page.runtime.pending.load(actor.credentials.accountId),
            null,
          );
          assert.equal(page.view().state?.reason, 'inputs_changed');
          assert.equal(page.view().confirmation, null);
          assert.equal(page.view().selectedId, '');
          assert.match(page.view().receiptStatus, /再次明确确认/);
          await page.controller.confirm();
          assert.equal(
            writes('PUT', selectorPath),
            count + 1,
            'Fresh revision is never substituted into old confirmation',
          );
          page.controller.choose(scope.home.campusId);
          page.controller.requestConfirmation();
          await page.controller.confirm();
          const events = await selectionRows();
          assert.equal(events.length, 3);
          assert.deepEqual(events.slice(0, 2), history);
          assert.equal(events[2].campus_id, scope.home.campusId);
          assert.equal(events[2].affiliation_snapshot_id, facts.snapshotId);
          assert.equal(events[2].affiliation_assertion_id, facts.assertionId);
          assert.equal(page.view().state?.selection, 'valid');
          page.controller.dispose();
        },
      );
      await t.test(
        'lost committed response survives native/server restarts and resolves an old receipt separately from a superseding choice',
        async () => {
          const storage = memoryStorage(),
            page = selector(actor, storage);
          await page.controller.load();
          page.controller.choose(scope.related.campusId);
          page.controller.requestConfirmation();
          transport.dropSuccess = { path: selectorPath, method: 'PUT' };
          await page.controller.confirm();
          assert.equal(page.view().frozen, true);
          assert.equal(page.view().state, null);
          const pending = page.runtime.pending.load(
            actor.credentials.accountId,
          );
          assert.ok(pending);
          assert.deepEqual(Object.keys(pending).sort(), [
            'accountId',
            'campusId',
            'expectedStateRevision',
            'requestId',
            'version',
          ]);
          assert.equal(pending.campusId, scope.related.campusId);
          const storedJson = JSON.stringify([...storage.values.values()]);
          assert.ok(!storedJson.includes(actor.credentials.accessToken));
          assert.ok(!storedJson.includes(actor.credentials.refreshToken));
          assert.ok(!storedJson.includes('options'));
          assert.equal(
            (await selectionRows()).length,
            4,
            'Real endpoint committed before transport dropped reply',
          );
          const otherPage = selector(other, storage),
            sentBefore = writes('PUT', selectorPath);
          await otherPage.controller.load();
          assert.equal(otherPage.view().frozen, false);
          assert.equal(
            otherPage.runtime.pending.load(other.credentials.accountId),
            null,
          );
          await otherPage.controller.recover(true);
          assert.equal(writes('PUT', selectorPath), sentBefore);
          assert.deepEqual(
            page.runtime.pending.load(actor.credentials.accountId),
            pending,
          );
          otherPage.controller.dispose();
          page.controller.dispose();
          const port = Number(new URL(await app!.getUrl()).port);
          await app!.close();
          app = await NestFactory.create(AppModule.register(config), {
            logger: false,
          });
          configureHttp(app);
          await app.listen(port, '127.0.0.1');
          const superseding = await actor.identityCampus.state(cancel);
          await actor.identityCampus.select(
            {
              requestId: randomUUID(),
              campusId: scope.home.campusId,
              expectedStateRevision: superseding.expectedStateRevision,
            },
            cancel,
          );
          const head = await selectionHead();
          const restoredActor = await makeClient(actor.credentials),
            restored = selector(restoredActor, storage);
          await restored.controller.load();
          assert.equal(restored.view().frozen, true);
          assert.equal(restored.view().state, null);
          assert.deepEqual(
            new PendingIdentityCampusStore(storage, nativeOrigin).load(
              actor.credentials.accountId,
            ),
            pending,
          );
          const exchangeStart = transport.exchanges.length;
          await restored.controller.recover();
          assert.equal(
            restored.view().state?.selectedCampus?.id,
            scope.home.campusId,
          );
          assert.match(restored.view().receiptStatus, /之后的选择替代/);
          assert.equal(
            restored.runtime.pending.load(actor.credentials.accountId),
            null,
          );
          assert.deepEqual(
            await selectionHead(),
            head,
            'Recovery never restores the old head',
          );
          assert.deepEqual(
            transport.exchanges
              .slice(exchangeStart)
              .map((x) => [x.method, x.path]),
            [
              ['GET', `${selectorPath}/requests/${pending.requestId}`],
              ['GET', selectorPath],
            ],
          );
          assert.equal((await selectionRows()).length, 5);
          restored.controller.dispose();
          await assert.rejects(
            other.identityCampus.receipt(pending.requestId, cancel),
            serverFailure('IDENTITY_CAMPUS_REQUEST_NOT_FOUND'),
          );
          assert.deepEqual(
            await actor.identityCampus.receipt(firstReceipt.requestId, cancel),
            firstReceipt,
            'The first receipt remains immutable after every later selection',
          );
        },
      );
      await t.test(
        'cancel after dispatch stops waiting but preserves original recovery, and late private callbacks cannot repaint after logout',
        async () => {
          const page = selector();
          await page.controller.load();
          page.controller.choose(scope.related.campusId);
          page.controller.requestConfirmation();
          const gate = transport.holdNext(selectorPath, 'PUT');
          const completion = page.controller.confirm();
          await gate.arrived;
          const pending = page.runtime.pending.load(
            actor.credentials.accountId,
          );
          assert.ok(pending);
          page.controller.cancel();
          assert.match(page.view().status, /停止等待/);
          assert.equal(page.view().state, null);
          assert.deepEqual(
            page.runtime.pending.load(actor.credentials.accountId),
            pending,
          );
          gate.release();
          await completion;
          assert.equal(page.view().state, null);
          const putCount = writes('PUT', selectorPath);
          await page.controller.recover();
          assert.equal(
            page.view().state?.selectedCampus?.id,
            scope.related.campusId,
          );
          assert.equal(writes('PUT', selectorPath), putCount);
          page.controller.dispose();
          const isolated = await makeClient(actor.credentials),
            late = selector(isolated);
          const readGate = transport.holdNext(selectorPath);
          const read = late.controller.load();
          await readGate.arrived;
          isolated.sessions.logout();
          assert.equal(late.view().state, null);
          assert.equal(late.view().selectedId, '');
          readGate.release();
          await read;
          assert.equal(late.view().state, null);
          assert.equal(late.view().confirmation, null);
          assert.equal(late.view().loaded, false);
          late.controller.dispose();
        },
      );
      await t.test(
        'missing receipt is not permission to replace the request, and persistence failure prevents dispatch',
        async () => {
          const storage = memoryStorage(),
            page = selector(actor, storage);
          const state = await actor.identityCampus.state(cancel);
          const pending = {
            version: 1,
            accountId: actor.credentials.accountId,
            requestId: randomUUID(),
            campusId: scope.home.campusId,
            expectedStateRevision: state.expectedStateRevision,
          };
          page.runtime.pending.freeze(pending);
          await page.controller.load();
          const count = writes('PUT', selectorPath);
          await page.controller.recover();
          assert.equal(page.view().frozen, true);
          assert.deepEqual(
            page.runtime.pending.load(actor.credentials.accountId),
            pending,
          );
          assert.match(page.view().error, /暂未查到回执/);
          page.controller.choose(scope.related.campusId);
          page.controller.requestConfirmation();
          await page.controller.confirm();
          assert.equal(writes('PUT', selectorPath), count);
          await page.controller.recover(true);
          assert.equal(writes('PUT', selectorPath), count + 1);
          assert.equal(
            page.view().state?.selectedCampus?.id,
            scope.home.campusId,
          );
          assert.equal(
            (await actor.identityCampus.receipt(pending.requestId, cancel))
              .campusId,
            pending.campusId,
          );
          page.controller.dispose();
          const failedStorage = {
            ...memoryStorage(),
            set: () => {
              throw new Error('Synthetic disk full');
            },
          };
          const failed = selector(actor, failedStorage);
          await failed.controller.load();
          failed.controller.choose(scope.related.campusId);
          failed.controller.requestConfirmation();
          const before = writes('PUT', selectorPath);
          await failed.controller.confirm();
          assert.equal(writes('PUT', selectorPath), before);
          assert.notEqual(failed.view().error, '');
          failed.controller.dispose();
        },
      );
      await t.test(
        'real HTTP payloads reject hostile or contradictory native shapes instead of stripping authority fields',
        async () => {
          const current = await actor.identityCampus.state(cancel);
          const patches: Record<string, unknown>[] = [
            { accountId: actor.credentials.accountId },
            { selection: 'valid', selectedCampus: null },
            {
              options: { status: 'unavailable', items: current.options.items },
            },
            {
              options: {
                status: 'known',
                items: [current.options.items[0], current.options.items[0]],
              },
            },
            {
              options: {
                status: 'known',
                items: [{ ...current.options.items[0], id: '../escape' }],
              },
            },
            { canSelect: true, expectedStateRevision: null },
            { affiliation: 'unavailable' },
            {
              writeEligibility: { phone: 'verified', safety: 'unavailable' },
              canSelect: true,
            },
            { guidance: 'await_affiliation' },
          ];
          for (const patch of patches) {
            transport.corruptNext = {
              path: selectorPath,
              transform: (value) => ({
                ...(value as Record<string, unknown>),
                ...patch,
              }),
            };
            await assert.rejects(
              actor.identityCampus.state(cancel),
              protocolFailure,
            );
          }
          for (const patch of [
            { requestId: randomUUID() },
            { campusId: scope.foreign.campusId },
            { selectionRevision: 0 },
            { sourceReference: 'private' },
          ]) {
            const state = await actor.identityCampus.state(cancel);
            const intent = {
              requestId: randomUUID(),
              campusId: scope.home.campusId,
              expectedStateRevision: state.expectedStateRevision,
            };
            transport.corruptNext = {
              path: selectorPath,
              transform: (value) => ({
                ...(value as Record<string, unknown>),
                ...patch,
              }),
            };
            await assert.rejects(
              actor.identityCampus.select(intent, cancel),
              protocolFailure,
            );
            const genuine = await actor.identityCampus.receipt(
              intent.requestId,
              cancel,
            );
            assert.equal(genuine.requestId, intent.requestId);
            assert.equal(genuine.campusId, intent.campusId);
          }
          const before = await selectionRows();
          const state = await actor.identityCampus.state(cancel);
          for (const extra of [
            { accountId: other.credentials.accountId },
            { studentVerified: true },
            { role: 'school_admin' },
            { topologySnapshotId: scope.topologySnapshotId },
            { selectedCampusId: scope.foreign.campusId },
          ]) {
            const result = await request(app!.getHttpServer())
              .put(selectorPath)
              .set('Authorization', `Bearer ${actor.credentials.accessToken}`)
              .send({
                requestId: randomUUID(),
                campusId: scope.home.campusId,
                expectedStateRevision: state.expectedStateRevision,
                ...extra,
              });
            assert.equal(result.status, 400);
          }
          assert.deepEqual(await selectionRows(), before);
        },
      );
      await t.test(
        'known required remains a separate safe fact and reading it never selects',
        async () => {
          const required = await makeClient(),
            facts = await verify(required);
          await appendIdentitySelection(
            pool,
            required.credentials.accountId,
            facts,
            scope,
            null,
            'selection_required',
          );
          const state = await required.identityCampus.state(cancel);
          assert.equal(state.selection, 'selection_required');
          assert.equal(state.reason, 'choice_required');
          assert.equal(state.canSelect, true);
          assert.equal(state.selectedCampus, null);
          const page = selector(required);
          await page.controller.load();
          assert.equal(page.view().selectedId, '');
          assert.match(page.view().status, /请选择身份校区/);
          const count = writes('PUT', selectorPath);
          page.controller.requestConfirmation();
          await page.controller.confirm();
          assert.equal(writes('PUT', selectorPath), count);
          assert.equal((await selectionRows(required)).length, 1);
          assert.equal(
            (await selectionRows(required))[0].selection_state,
            'selection_required',
          );
          page.controller.dispose();
        },
      );
      composer.dispose();
    } finally {
      await app?.close();
      if (ownsSchemas)
        for (const schema of migrationSchemaNames)
          await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      if (locked)
        await suite?.query('SELECT pg_advisory_unlock($1,$2)', [
          MIGRATION_LOCK[0],
          2,
        ]);
      suite?.release();
      await pool.end();
    }
  },
);
