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
} from '../../src/community/contracts.js';
import type { PublishReply } from '../../src/community/discussion/contracts.js';
import type {
  ReportTarget,
  ReportReceipt,
  ReportProgress,
} from '../../src/safety/reporting/contracts.js';
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
import {
  setSyntheticSnapshot,
  syntheticAssertion,
} from '../support/verification-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

// Actual native gateways, strict decoders and controllers cross a real loopback
// HTTP socket into Nest and PostgreSQL 18.6+. Synthetic adapters supply ONLY
// platform I/O, login exchange and unavailable publication/base-visibility facts.
// Canonical verification, policy, reporting, votes, removal, notices and workers
// are real. All targets are newly published and atomically enroll native origin.
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
  HttpReportGateway,
} = require('../../../wechat/src/community/report-gateway.ts');
const {
  HttpSystemNoticesGateway,
} = require('../../../wechat/src/community/system-notices-gateway.ts');
const {
  createCommunityRuntime,
} = require('../../../wechat/src/community/runtime.ts');
const {
  ReportMutationController,
  initialReportMutationView,
  ReportProgressController,
  initialReportProgressView,
} = require('../../../wechat/src/community/report-controller.ts');
const {
  SystemNoticesController,
  initialSystemNoticesView,
  SystemNoticesBadgeController,
  initialSystemNoticesBadgeView,
} = require('../../../wechat/src/pages/system-notices/controller.ts');
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
  let failRemoval = false,
    failWrite = false;
  return {
    getStorageSync: (key: string) => structuredClone(values.get(key)),
    setStorageSync: (key: string, value: unknown) => {
      if (failWrite) throw new Error('Synthetic journal write failure');
      values.set(key, structuredClone(value));
    },
    removeStorageSync: (key: string) => {
      if (failRemoval) throw new Error('Synthetic journal cleanup failure');
      values.delete(key);
    },
    setWriteFailure: (value: boolean) => {
      failWrite = value;
    },
    snapshot: () => structuredClone([...values.entries()]),
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
function created(receipt: PublicationReceipt): string {
  assert.equal(receipt.outcome, 'created', JSON.stringify(receipt));
  assert.ok(receipt.outcome === 'created');
  return receipt.resourceId;
}
function accepted(receipt: ReportReceipt, operation: 'report' | 'vote') {
  assert.equal(receipt.outcome, 'accepted', JSON.stringify(receipt));
  assert.equal(receipt.operation, operation);
  assert.deepEqual(Object.keys(receipt).sort(), [
    'operation',
    'outcome',
    'receiptId',
    'requestId',
  ]);
  assert.ok(Object.isFrozen(receipt), 'The actual strict native decoder ran');
  return receipt;
}
function rejected(receipt: ReportReceipt, code: string) {
  assert.deepEqual(receipt, {
    requestId: receipt.requestId,
    operation: receipt.operation,
    outcome: 'rejected',
    code,
  });
}
function noPrivateReportingData(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(
      ![
        'accountId',
        'account_id',
        'ownerAccountId',
        'owner_account_id',
        'author',
        'authorId',
        'reporter',
        'reporters',
        'jurors',
        'grantId',
        'scopeEvidence',
        'phone',
        'phoneBinding',
        'studentNumber',
        'identity',
        'text',
        'preview',
        'source',
        'sourceId',
        'postId',
        'target',
        'token',
        'sessionId',
      ].includes(key),
      `Private field in reporting wire: ${key}`,
    );
    noPrivateReportingData(child);
  }
}
async function eventually(
  check: () => boolean | Promise<boolean>,
  timeout = 5000,
) {
  const end = Date.now() + timeout;
  do {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < end);
  assert.fail('Expected the real asynchronous owner/worker outcome');
}

test(
  'native report/jury/system-notice controllers → real Nest HTTP → PostgreSQL',
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
      WECHAT_APP_ID: 'wx0000000000000000',
      WECHAT_APP_SECRET: 'synthetic-local-report-contract-only',
      AUTH_RATE_LIMIT_KEY: 'cf'.repeat(32),
      SAFETY_JURY_INTERVAL_MS: '25',
    });
    assert.equal(config.SAFETY_JURY_PROCESSING, 'disabled');
    const pool = new Pool(poolOptions(config));
    let suite: PoolClient | undefined, app: INestApplication | undefined;
    let locked = false,
      ownsSchemas = false,
      providerExchanges = 0;
    const visibility = new FixtureVisibility();
    const startApp = async (
      port = 0,
      syntheticBase = true,
      automatic = false,
    ): Promise<INestApplication> => {
      let builder = Test.createTestingModule({
        imports: [
          AppModule.register(
            automatic
              ? { ...config, SAFETY_JURY_PROCESSING: 'automatic' }
              : config,
          ),
        ],
      })
        .overrideProvider(IDENTITY_PROVIDER)
        .useValue({
          exchange: async (code: string) => {
            providerExchanges++;
            return {
              provider: 'wechat',
              appId: 'synthetic-native-reports',
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
      // Preserve the production safety visibility adapter. Only its unavailable
      // upstream base authority is replaced by this explicit synthetic fixture.
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
          reports: new HttpReportGateway(api),
          notices: new HttpSystemNoticesGateway(api),
        };
      };
      type Actor = Awaited<ReturnType<typeof makeClient>>;
      const owner = await makeClient('synthetic-report-owner');
      const peers: Actor[] = [];
      for (let i = 0; i < 11; i++)
        peers.push(await makeClient(`synthetic-report-peer-${i}`));
      const observer = await makeClient('synthetic-report-unverified');
      const actors = [owner, ...peers, observer],
        reporters = peers.slice(0, 5),
        jurors = peers.slice(5);
      const region = randomUUID(),
        spaceId = randomUUID(),
        issuer = randomUUID();
      await pool.query(
        "INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES($1,'Synthetic Reporting Region',true)",
        [region],
      );
      await pool.query(
        "INSERT INTO whaleu_community.spaces(id,kind,name,is_active,operating_region_id) VALUES($1,'regional','Synthetic Reporting Space',true,$2)",
        [spaceId, region],
      );
      await pool.query(
        "INSERT INTO whaleu_campus.institutions(id,name) VALUES($1,'Synthetic Reporting Institution')",
        [issuer],
      );
      // Publication test bindings are not privileged role grants and never supply
      // report eligibility or weight. The reporting source reads canonical facts.
      await grant(pool, owner.credentials.accountId, spaceId, verified(region));
      const verify = async (actor: Actor, conflictingNumber = false) => {
        await setSyntheticSnapshot(pool, actor.credentials.accountId, [
          syntheticAssertion(actor.credentials.accountId, issuer, 'phone'),
          syntheticAssertion(
            actor.credentials.accountId,
            issuer,
            'affiliation',
          ),
          ...(conflictingNumber
            ? [
                syntheticAssertion(
                  actor.credentials.accountId,
                  issuer,
                  'student_number',
                  { coverage_state: 'conflict' },
                ),
              ]
            : []),
        ]);
      };
      for (const actor of [owner, ...peers])
        await verify(actor, actor === reporters[1]);
      // An active new-native account has no verified phone/affiliation/number.
      await setSyntheticSnapshot(pool, observer.credentials.accountId, []);
      transport.checkResponse = (path, _status, body) => {
        if (
          !path.includes('/safety/report') &&
          !path.includes('/safety/jury') &&
          !path.includes('/system-notices')
        )
          return;
        noPrivateReportingData(body);
        for (const actor of actors)
          assert.ok(
            !JSON.stringify(body).includes(actor.credentials.accountId),
            'Wire must not expose private identities',
          );
      };
      const publish = async (overrides: Partial<PublishPost> = {}) => {
        const body = publishPostSchema.parse({
          clientRequestId: randomUUID(),
          spaceId,
          category: 'discussion',
          authorMode: 'anonymous',
          text: `Synthetic report post ${randomUUID()}`,
          imageAssetIds: [],
          commentsPolicy: 'open',
          component: { kind: 'none' },
          ...overrides,
        });
        await approve(pool, owner.credentials.accountId, body.text);
        const id = created(await owner.community.publishPost(body, cancel));
        const provenance = (
          await pool.query<{ source_request_id: string; provenance: string }>(
            'SELECT source_request_id,provenance FROM whaleu_community.report_origins WHERE kind=$1 AND target_id=$2',
            ['post', id],
          )
        ).rows[0];
        assert.deepEqual(provenance, {
          source_request_id: body.clientRequestId,
          provenance: 'native_publication',
        });
        return id;
      };
      const root = async (postId: string) => {
        const body = {
          clientRequestId: randomUUID(),
          text: `Synthetic root ${randomUUID()}`,
          imageAssetIds: [],
          authorMode: 'anonymous',
        };
        await approve(
          pool,
          owner.credentials.accountId,
          body.text,
          'publish_comment',
        );
        return created(
          await owner.community.publishComment(postId, body, cancel),
        );
      };
      const reply = async (postId: string, rootId: string) => {
        const body: PublishReply = {
          clientRequestId: randomUUID(),
          text: `Synthetic reply ${randomUUID()}`,
          imageAssetIds: [],
          authorMode: 'anonymous',
          targetReplyId: null,
        };
        await approveReply(
          pool,
          owner.credentials.accountId,
          postId,
          rootId,
          body,
        );
        return created(
          await owner.community.publishReply(rootId, body, cancel),
        );
      };
      const reportIntent = (
        id: string,
        kind: ReportTarget['kind'] = 'post',
        clientRequestId: string = randomUUID(),
      ) => ({ operation: 'report', clientRequestId, target: { kind, id } });
      const voteIntent = (
        postId: string,
        juryId: string,
        vote: 'keep' | 'remove',
        clientRequestId: string = randomUUID(),
      ) => ({ operation: 'vote', clientRequestId, postId, juryId, vote });
      const report = (
        actor: Actor,
        id: string,
        kind: ReportTarget['kind'] = 'post',
      ): Promise<ReportReceipt> =>
        actor.reports.apply(reportIntent(id, kind), cancel);
      const progress = (
        actor: Actor,
        id: string,
        kind: ReportTarget['kind'] = 'post',
      ): Promise<ReportProgress> =>
        actor.reports.progress({ kind, id }, cancel);
      const openJury = async (id: string) => {
        for (const actor of reporters)
          accepted(await report(actor, id), 'report');
        const view = await progress(jurors[0]!, id);
        assert.ok(view.kind === 'post' && view.jury);
        return view.jury.juryId;
      };
      const runtimeFor = (actor: Actor, wx = platformStorage()) =>
        createCommunityRuntime(actor, wx, nativeOrigin, systemClock);
      const raw = (
        actor: Actor,
        path: string,
        method = 'GET',
        body?: unknown,
      ) =>
        transport.send({
          url: `${nativeOrigin}${path}`,
          method,
          headers: {
            Authorization: `Bearer ${actor.credentials.accessToken}`,
            'content-type': 'application/json',
          },
          ...(body === undefined ? {} : { body }),
          timeoutMs: 5000,
        });
      const baselineProviderExchanges = providerExchanges;
      let keepPost = '',
        keepJury = '',
        removedPost = '',
        removedNotice = '';
      let durableReceipt: ReportReceipt | undefined;

      await t.test(
        'five reports open one jury, canonical affiliation ignores number conflict, anonymous author/reporters cannot vote',
        async () => {
          keepPost = await publish();
          const candidate = await reporters[0]!.community.post(
            keepPost,
            cancel,
          );
          assert.equal(candidate.author.kind, 'anonymous');
          const runtime = runtimeFor(reporters[0]!);
          let view = initialReportMutationView();
          const mutation = new ReportMutationController(
            runtime,
            'report',
            (next: typeof view) => {
              view = next;
            },
          );
          mutation.requestReport('post', candidate);
          mutation.dismiss();
          const before = transport.exchanges.length;
          await mutation.confirm();
          assert.equal(
            transport.exchanges.length,
            before,
            'Cancelled confirmation sends nothing',
          );
          mutation.requestReport('post', candidate);
          const held = transport.holdNext('/v1/me/safety/reports', 'POST');
          const running = mutation.confirm();
          await held.arrived;
          await mutation.confirm();
          mutation.requestReport('post', { ...candidate, id: randomUUID() });
          const pending = runtime.pendingReports.load(
            reporters[0]!.credentials.accountId,
          );
          assert.ok(pending);
          held.release();
          await running;
          assert.equal(view.frozen, false);
          assert.match(view.receiptStatus, /不代表已审核或已删除/);
          durableReceipt = accepted(
            await reporters[0]!.reports.receipt(
              pending.intent.clientRequestId,
              cancel,
            ),
            'report',
          );
          assert.equal(
            (await progress(reporters[0]!, keepPost)).reportCount,
            1,
          );
          for (const [index, actor] of reporters.slice(1).entries()) {
            accepted(await report(actor, keepPost), 'report');
            const current = await progress(jurors[0]!, keepPost);
            assert.ok(current.kind === 'post');
            assert.equal(current.reportCount, index + 2);
            assert.equal(current.effectiveWeight, index + 2);
            assert.equal(current.jury !== null, index === 3);
          }
          const current = await progress(jurors[0]!, keepPost);
          assert.ok(current.kind === 'post' && current.jury);
          keepJury = current.jury.juryId;
          assert.equal(
            Date.parse(current.jury.deadline) -
              Date.parse(current.jury.createdAt),
            86_400_000,
          );
          for (const actor of [owner, ...reporters]) {
            const ineligible = await progress(actor, keepPost);
            assert.ok(ineligible.kind === 'post' && ineligible.jury);
            assert.equal(
              ineligible.jury.voteCapability.code,
              'JURY_INELIGIBLE',
            );
            rejected(
              await actor.reports.apply(
                voteIntent(keepPost, keepJury, 'remove'),
                cancel,
              ),
              'JURY_INELIGIBLE',
            );
          }
          const own = await progress(owner, keepPost);
          assert.equal(
            own.isSelf,
            true,
            'True anonymous author remains privately known',
          );
          rejected(await report(owner, keepPost), 'REPORT_SELF_NOT_ALLOWED');
          rejected(
            await report(reporters[0]!, keepPost),
            'REPORT_ALREADY_REPORTED',
          );
          rejected(await report(jurors[0]!, keepPost), 'REPORTING_CLOSED');
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_safety.post_juries WHERE post_id=$1',
                [keepPost],
              )
            ).rowCount,
            1,
          );
          mutation.dispose();
        },
      );

      await t.test(
        'native weighted projection separates actual count from frozen weight, including four plus five overflow',
        async () => {
          const manager = reporters[4]!,
            grantId = randomUUID();
          // Explicit disposable test-only scoped grant. Never installed by runtime,
          // migration or seed; no real user/region is involved, and it is revoked
          // before any later test then discarded with this suite-owned schema.
          await pool.query(
            "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference,valid_from,expires_at) VALUES($1,$2,'school_admin',$3,$2,'synthetic-native-report-contract-only',clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 hour')",
            [grantId, manager.credentials.accountId, region],
          );
          const single = await publish(),
            overflow = await publish();
          try {
            accepted(await report(manager, single), 'report');
            const one = await progress(observer, single);
            assert.ok(one.kind === 'post' && one.jury);
            assert.equal(one.reportCount, 1);
            assert.equal(one.effectiveWeight, 5);
            for (const actor of reporters.slice(0, 4))
              accepted(await report(actor, overflow), 'report');
            accepted(await report(manager, overflow), 'report');
            const combined = await progress(observer, overflow);
            assert.ok(combined.kind === 'post' && combined.jury);
            assert.equal(combined.reportCount, 5);
            assert.equal(
              combined.effectiveWeight,
              9,
              'Effective weight is not incorrectly capped at threshold five',
            );
            const evidence = (
              await pool.query<{
                weight: number;
                grant_id: string;
                scope_evidence: string;
              }>(
                'SELECT r.weight,r.grant_id,r.scope_evidence FROM whaleu_safety.reports r JOIN whaleu_safety.report_cases c ON c.id=r.case_id WHERE c.target_id=$1 AND r.account_id=$2',
                [overflow, manager.credentials.accountId],
              )
            ).rows[0];
            assert.deepEqual(evidence, {
              weight: 5,
              grant_id: grantId,
              scope_evidence: `regional:${region}`,
            });
          } finally {
            await pool.query(
              'UPDATE whaleu_authorization.role_grants SET revoked_at=clock_timestamp(),revoked_by_account_id=account_id WHERE id=$1',
              [grantId],
            );
          }
          const frozen = await progress(observer, overflow);
          assert.ok(frozen.kind === 'post');
          assert.equal(
            frozen.effectiveWeight,
            9,
            'Revoking the fixture grant cannot change accepted historical evidence',
          );
        },
      );

      await t.test(
        'readable progress has no certification gate and failed native reads stay unknown independently of detail',
        async () => {
          const current = await progress(observer, keepPost);
          assert.ok(current.kind === 'post' && current.jury);
          assert.equal(current.reportCount, 5);
          assert.equal(current.jury.voteCapability.status, 'unavailable');
          assert.equal(
            current.jury.voteCapability.code,
            'VERIFICATION_UNAVAILABLE',
          );
          const runtime = runtimeFor(observer);
          let view = initialReportProgressView(),
            detailView = initialDetailView();
          const controller = new ReportProgressController(
            runtime,
            { kind: 'post', id: keepPost },
            (next: typeof view) => {
              view = next;
            },
          );
          const detail = new DetailController(
            runtime,
            keepPost,
            (next: typeof detailView) => {
              detailView = next;
            },
          );
          await Promise.all([controller.load(), detail.load()]);
          assert.equal(view.loaded, true);
          assert.equal(view.showTallies, true);
          assert.equal(view.canVote, false);
          assert.ok(detailView.post);
          transport.failNext = `/v1/me/safety/report-progress/post/${keepPost}`;
          await controller.load();
          assert.equal(view.loaded, false);
          assert.equal(view.progress, null);
          assert.match(view.status, /不能据此认定/);
          assert.ok(
            detailView.post,
            'Progress failure does not suppress detail',
          );
          controller.dispose();
          detail.dispose();
        },
      );

      await t.test(
        'native keep vote survives lost response and server restart, is immutable, closes at six and never reopens',
        async () => {
          const actor = jurors[0]!,
            wx = platformStorage(),
            runtime = runtimeFor(actor, wx);
          let view = initialReportMutationView('vote'),
            status = initialReportProgressView();
          const mutation = new ReportMutationController(
            runtime,
            'vote',
            (next: typeof view) => {
              view = next;
            },
          );
          const controller = new ReportProgressController(
            runtime,
            { kind: 'post', id: keepPost },
            (next: typeof status) => {
              status = next;
            },
          );
          await controller.load();
          assert.equal(status.canVote, true);
          assert.equal(
            status.showTallies,
            false,
            'Eligible unvoted jurors do not see inline tallies',
          );
          mutation.requestVote(status.progress, 'keep');
          mutation.requestVote(status.progress, 'remove');
          transport.dropSuccess = {
            path: '/v1/me/safety/jury-votes',
            method: 'POST',
          };
          await mutation.confirm();
          assert.equal(view.frozen, true);
          const pending = runtime.pendingJuryVotes.load(
            actor.credentials.accountId,
          );
          assert.equal(pending.intent.vote, 'keep');
          assert.equal(
            runtime.pendingReports.load(actor.credentials.accountId),
            null,
          );
          mutation.dispose();
          controller.dispose();
          await app!.close();
          app = await startApp(port);
          const restored = await makeClient('unused', actor.credentials),
            restoredRuntime = runtimeFor(restored, wx);
          let restoredView = initialReportMutationView('vote');
          const recovered = new ReportMutationController(
            restoredRuntime,
            'vote',
            (next: typeof restoredView) => {
              restoredView = next;
            },
          );
          recovered.load();
          await recovered.recover(true);
          assert.equal(restoredView.frozen, false);
          assert.equal(
            restoredRuntime.pendingJuryVotes.load(actor.credentials.accountId),
            null,
          );
          const receipt = accepted(
            await actor.reports.receipt(pending.intent.clientRequestId, cancel),
            'vote',
          );
          assert.deepEqual(
            await actor.reports.apply(pending.intent, cancel),
            receipt,
          );
          await assert.rejects(
            actor.reports.apply({ ...pending.intent, vote: 'remove' }, cancel),
            clientFailure('business', 409, 'REQUEST_CONFLICT'),
          );
          rejected(
            await actor.reports.apply(
              voteIntent(keepPost, keepJury, 'remove'),
              cancel,
            ),
            'JURY_ALREADY_VOTED',
          );
          for (const juror of jurors.slice(1))
            accepted(
              await juror.reports.apply(
                voteIntent(keepPost, keepJury, 'keep'),
                cancel,
              ),
              'vote',
            );
          const closed = await progress(owner, keepPost);
          assert.ok(closed.kind === 'post' && closed.jury);
          assert.equal(closed.jury.state, 'kept');
          assert.equal(closed.jury.keepVotes, 6);
          assert.equal(closed.jury.removeVotes, 0);
          rejected(await report(jurors[0]!, keepPost), 'REPORTING_CLOSED');
          assert.deepEqual(await owner.notices.unread(cancel), {
            unreadCount: 0,
          });
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_safety.post_juries WHERE post_id=$1',
                [keepPost],
              )
            ).rowCount,
            1,
          );
          recovered.dispose();
        },
      );

      await t.test(
        'six native remove votes atomically remove content and leave one owner-only notice despite journal cleanup failure',
        async () => {
          removedPost = await publish();
          const juryId = await openJury(removedPost);
          for (const actor of jurors.slice(0, 5))
            accepted(
              await actor.reports.apply(
                voteIntent(removedPost, juryId, 'remove'),
                cancel,
              ),
              'vote',
            );
          const actor = jurors[5]!,
            wx = platformStorage(),
            runtime = runtimeFor(actor, wx);
          let view = initialReportMutationView('vote'),
            detailView = initialDetailView();
          const mutation = new ReportMutationController(
            runtime,
            'vote',
            (next: typeof view) => {
              view = next;
            },
          );
          const detail = new DetailController(
            runtime,
            removedPost,
            (next: typeof detailView) => {
              detailView = next;
            },
          );
          await detail.load();
          assert.ok(detailView.post);
          const stale = transport.holdNext(
              `/v1/community/posts/${removedPost}`,
            ),
            reading = detail.load();
          await stale.arrived;
          mutation.requestVote(await progress(actor, removedPost), 'remove');
          wx.setRemoveFailure(true);
          await mutation.confirm();
          assert.equal(
            view.frozen,
            true,
            'A committed server receipt does not erase an unclean local journal',
          );
          assert.match(view.receiptStatus, /已受理/);
          assert.equal(
            detailView.post,
            null,
            'Removal invalidation clears content before fallible cleanup',
          );
          stale.release();
          await reading;
          await eventually(() => !detailView.busy);
          assert.equal(
            detailView.post,
            null,
            'Late older content cannot restore a removed post',
          );
          const pending = runtime.pendingJuryVotes.load(
            actor.credentials.accountId,
          );
          assert.ok(pending);
          const receipt = accepted(
            await actor.reports.receipt(pending.intent.clientRequestId, cancel),
            'vote',
          );
          wx.setRemoveFailure(false);
          await mutation.recover();
          assert.equal(view.frozen, false);
          assert.equal(
            runtime.pendingJuryVotes.load(actor.credentials.accountId),
            null,
          );
          assert.deepEqual(
            await actor.reports.apply(pending.intent, cancel),
            receipt,
          );
          await assert.rejects(
            progress(reporters[0]!, removedPost),
            clientFailure('http', 404, 'REPORT_TARGET_UNAVAILABLE'),
          );
          await assert.rejects(
            owner.community.post(removedPost, cancel),
            clientFailure('http', 404, 'POST_NOT_FOUND'),
          );
          const outcome = (
            await pool.query<{
              state: string;
              removed: boolean;
              votes: number;
              notices: number;
              events: number;
              work: string;
            }>(
              `SELECT j.state,p.deleted_at IS NOT NULL AS removed,(SELECT count(*)::integer FROM whaleu_safety.jury_ballots b WHERE b.jury_id=j.id) AS votes,(SELECT count(*)::integer FROM whaleu_notifications.system_notices n WHERE n.decision_id=j.decision_id) AS notices,(SELECT count(*)::integer FROM whaleu_community.outbox e WHERE e.event_key='moderation:'||j.decision_id::text) AS events,w.state AS work FROM whaleu_safety.post_juries j JOIN whaleu_community.posts p ON p.id=j.post_id JOIN whaleu_safety.jury_work w ON w.jury_id=j.id WHERE j.id=$1`,
              [juryId],
            )
          ).rows[0];
          assert.deepEqual(outcome, {
            state: 'removed',
            removed: true,
            votes: 6,
            notices: 1,
            events: 1,
            work: 'completed',
          });
          const notices = await owner.notices.list(null, cancel);
          assert.equal(notices.items.length, 1);
          assert.deepEqual(Object.keys(notices.items[0]).sort(), [
            'createdAt',
            'keepVotes',
            'kind',
            'noticeId',
            'readAt',
            'removeVotes',
          ]);
          removedNotice = notices.items[0].noticeId;
          assert.equal(notices.items[0].kind, 'post_jury_removed');
          assert.equal(notices.items[0].removeVotes, 6);
          assert.equal(notices.unreadCount, 1);
          assert.deepEqual((await actor.notices.list(null, cancel)).items, []);
          await assert.rejects(
            actor.notices.read(removedNotice, cancel),
            clientFailure('http', 404, 'NOTICE_NOT_FOUND'),
          );
          const noBan = (
            await pool.query<{ actions_allowed: boolean }>(
              'SELECT actions_allowed FROM whaleu_safety.account_heads WHERE account_id=$1',
              [owner.credentials.accountId],
            )
          ).rows[0];
          assert.equal(
            noBan?.actions_allowed,
            true,
            'Jury removal does not ban or restrict its author',
          );
          detail.dispose();
          mutation.dispose();
        },
      );

      await t.test(
        'separate native system-notice list/badge survives verification loss and idempotent lost read response',
        async () => {
          await setSyntheticSnapshot(pool, owner.credentials.accountId, []);
          const runtime = runtimeFor(owner);
          let view = initialSystemNoticesView(),
            badgeView = initialSystemNoticesBadgeView();
          const controller = new SystemNoticesController(
            runtime,
            (next: typeof view) => {
              view = next;
            },
          );
          const badge = new SystemNoticesBadgeController(
            runtime,
            (next: typeof badgeView) => {
              badgeView = next;
            },
          );
          await Promise.all([controller.load(), badge.load()]);
          assert.equal(view.loaded, true);
          assert.equal(view.items.length, 1);
          assert.equal(
            view.items[0].readAt,
            null,
            'List is not an acknowledgment',
          );
          assert.equal(badgeView.unreadCount, 1);
          transport.dropSuccess = {
            path: `/v1/me/system-notices/${removedNotice}/read`,
            method: 'PUT',
          };
          await controller.acknowledge(removedNotice);
          assert.equal(
            view.items[0].readAt,
            null,
            'Uncertain response does not fabricate a confirmed read',
          );
          const committed = await owner.notices.read(removedNotice, cancel);
          await controller.acknowledge(removedNotice);
          assert.equal(view.items[0].readAt, committed.readAt);
          assert.equal(view.unreadCount, 0);
          assert.deepEqual(
            await owner.notices.read(removedNotice, cancel),
            committed,
          );
          await badge.load();
          assert.equal(badgeView.unreadCount, 0);
          const stale = transport.holdNext('/v1/me/system-notices'),
            reading = controller.load();
          await stale.arrived;
          owner.sessions.completeLogin(
            owner.sessions.beginLogin(),
            observer.credentials,
          );
          stale.release();
          await reading;
          assert.deepEqual(view.items, []);
          assert.equal(view.loaded, false);
          owner.sessions.completeLogin(
            owner.sessions.beginLogin(),
            owner.credentials,
          );
          await controller.load();
          assert.equal(view.items[0].noticeId, removedNotice);
          controller.dispose();
          badge.dispose();
          await verify(owner);
        },
      );

      await t.test(
        'root and reply tenth reports remove deterministically with one retained provider-disabled review and no jury notice',
        async () => {
          const postId = await publish(),
            rootId = await root(postId),
            childId = await reply(postId, rootId);
          const otherRoot = await root(postId),
            replyId = await reply(postId, otherRoot);
          const pin = await owner.community.pinComment(
            postId,
            rootId,
            true,
            randomUUID(),
            cancel,
          );
          assert.equal(pin.outcome, 'applied');
          const before = await owner.notices.list(null, cancel);
          for (const [kind, id] of [
            ['reply', replyId],
            ['comment', rootId],
          ] as const) {
            rejected(await report(owner, id, kind), 'REPORT_SELF_NOT_ALLOWED');
            let first: ReportReceipt | null = null;
            for (const [index, actor] of peers.slice(0, 10).entries()) {
              const receipt = accepted(await report(actor, id, kind), 'report');
              if (index === 0) {
                first = receipt;
                rejected(
                  await report(actor, id, kind),
                  'REPORT_ALREADY_REPORTED',
                );
              }
              if (index < 9) {
                const view = await progress(observer, id, kind);
                assert.ok(view.kind !== 'post');
                assert.equal(view.reportCount, index + 1);
                assert.equal(view.review, 'provider_disabled');
                assert.equal('jury' in view, false);
              }
            }
            await assert.rejects(
              progress(observer, id, kind),
              clientFailure('http', 404, 'REPORT_TARGET_UNAVAILABLE'),
            );
            assert.ok(first);
            assert.deepEqual(
              await peers[0]!.reports.receipt(first.requestId, cancel),
              first,
            );
            const state = (
              await pool.query<{
                report_count: number;
                state: string;
                status: string;
                attempts: number;
                obligations: number;
              }>(
                `SELECT c.report_count,c.state,o.status,o.attempts,(SELECT count(*)::integer FROM whaleu_safety.review_obligations WHERE case_id=c.id) AS obligations FROM whaleu_safety.report_cases c JOIN whaleu_safety.review_obligations o ON o.case_id=c.id WHERE c.kind=$1 AND c.target_id=$2`,
                [kind, id],
              )
            ).rows[0];
            assert.deepEqual(state, {
              report_count: 10,
              state: 'removed',
              status: 'provider_disabled',
              attempts: 0,
              obligations: 1,
            });
          }
          await assert.rejects(
            progress(observer, childId, 'reply'),
            clientFailure('http', 404, 'REPORT_TARGET_UNAVAILABLE'),
          );
          assert.deepEqual(
            await owner.notices.list(null, cancel),
            before,
            'Discussion removal does not emit post-jury notices',
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.comment_pins WHERE comment_id=$1',
                [rootId],
              )
            ).rowCount,
            0,
            'Tenth root report releases its existing pin atomically',
          );
          const origins = await pool.query(
            'SELECT kind FROM whaleu_community.report_origins WHERE target_id=ANY($1::uuid[])',
            [[rootId, childId, otherRoot, replyId]],
          );
          assert.equal(
            origins.rowCount,
            4,
            'All discussion targets enrolled through native publication',
          );
        },
      );

      await t.test(
        'lost report response, persistence failure, account switch and older progress preserve exact intent ownership',
        async () => {
          const postId = await publish(),
            actor = reporters[0]!,
            wx = platformStorage(),
            runtime = runtimeFor(actor, wx);
          let view = initialReportMutationView(),
            status = initialReportProgressView();
          const mutation = new ReportMutationController(
            runtime,
            'report',
            (next: typeof view) => {
              view = next;
            },
          );
          const controller = new ReportProgressController(
            runtime,
            { kind: 'post', id: postId },
            (next: typeof status) => {
              status = next;
            },
          );
          const candidate = await actor.community.post(postId, cancel);
          wx.setWriteFailure(true);
          mutation.requestReport('post', candidate);
          const before = transport.exchanges.length;
          await mutation.confirm();
          assert.equal(
            transport.exchanges.length,
            before,
            'No dispatch unless exact durable intent was persisted',
          );
          wx.setWriteFailure(false);
          mutation.load();
          const stale = transport.holdNext(
              `/v1/me/safety/report-progress/post/${postId}`,
            ),
            reading = controller.load();
          await stale.arrived;
          mutation.requestReport('post', candidate);
          transport.dropSuccess = {
            path: '/v1/me/safety/reports',
            method: 'POST',
          };
          await mutation.confirm();
          assert.equal(view.frozen, true);
          const pending = runtime.pendingReports.load(
            actor.credentials.accountId,
          );
          assert.ok(pending);
          mutation.dispose();
          let recoveredView = initialReportMutationView();
          const recovered = new ReportMutationController(
            runtime,
            'report',
            (next: typeof recoveredView) => {
              recoveredView = next;
            },
          );
          recovered.load();
          await recovered.recover();
          await eventually(
            () => status.loaded && status.progress?.reportCount === 1,
          );
          stale.release();
          await reading;
          assert.equal(
            status.progress.reportCount,
            1,
            'Late pre-mutation count cannot overwrite fresh progress',
          );
          assert.equal(recoveredView.frozen, false);
          assert.equal(
            JSON.stringify(wx.snapshot()).includes('accessToken'),
            false,
          );
          const another = await publish();
          recovered.requestReport(
            'post',
            await actor.community.post(another, cancel),
          );
          const switched = transport.holdNext('/v1/me/safety/reports', 'POST'),
            running = recovered.confirm();
          await switched.arrived;
          actor.sessions.completeLogin(
            actor.sessions.beginLogin(),
            observer.credentials,
          );
          switched.release();
          await running;
          assert.equal(recoveredView.receiptStatus, '');
          assert.ok(runtime.pendingReports.load(actor.credentials.accountId));
          assert.equal(
            runtime.pendingReports.load(observer.credentials.accountId),
            null,
          );
          assert.equal(status.progress, null);
          actor.sessions.completeLogin(
            actor.sessions.beginLogin(),
            actor.credentials,
          );
          recovered.load();
          await recovered.recover();
          assert.equal(recoveredView.frozen, false);
          const cancelled = await publish();
          recovered.requestReport(
            'post',
            await actor.community.post(cancelled, cancel),
          );
          const afterDispatch = transport.holdNext(
              '/v1/me/safety/reports',
              'POST',
            ),
            dispatched = recovered.confirm();
          await afterDispatch.arrived;
          recovered.cancel();
          afterDispatch.release();
          await dispatched;
          assert.ok(runtime.pendingReports.load(actor.credentials.accountId));
          assert.equal(recoveredView.receiptStatus, '');
          recovered.load();
          await recovered.recover();
          assert.equal(recoveredView.frozen, false);
          recovered.dispose();
          controller.dispose();
        },
      );

      await t.test(
        'strict HTTP inputs and strict native response decoders reject extra/private fields without accepting success',
        async () => {
          const actor = reporters[0]!,
            postId = await publish();
          for (const extra of [
            { reason: 'synthetic' },
            { weight: 5 },
            { ownerAccountId: owner.credentials.accountId },
            { campusId: region },
          ]) {
            const response = await raw(actor, '/v1/me/safety/reports', 'POST', {
              clientRequestId: randomUUID(),
              target: { kind: 'post', id: postId },
              ...extra,
            });
            assert.equal(response.status, 400);
          }
          for (const path of [
            `/v1/me/safety/report-progress/post/${postId}?extra=1`,
            `/v1/me/safety/report-progress/post/${postId}?id=${postId}&id=${postId}`,
            '/v1/me/system-notices?limit=1&limit=2',
            '/v1/me/system-notices/unread-count?extra=1',
          ]) {
            assert.equal((await raw(actor, path)).status, 400);
          }
          assert.equal(
            (
              await raw(actor, '/v1/me/safety/jury-votes', 'POST', {
                clientRequestId: randomUUID(),
                postId: keepPost,
                juryId: keepJury,
                vote: 'abstain',
              })
            ).status,
            400,
          );
          assert.equal(
            (
              await raw(
                owner,
                `/v1/me/system-notices/${removedNotice}/read`,
                'PUT',
                { readAt: new Date().toISOString() },
              )
            ).status,
            400,
          );
          const fresh = await progress(actor, postId);
          assert.equal(
            fresh.reportCount,
            0,
            'Rejected request fields have no report side effects',
          );
          transport.corruptNext = {
            path: `/v1/me/safety/report-progress/post/${postId}`,
            extra: { unrecognized: true },
          };
          await assert.rejects(progress(actor, postId), (error: unknown) => {
            assert.equal((error as { kind: string }).kind, 'protocol');
            return true;
          });
          transport.corruptNext = {
            path: '/v1/me/system-notices',
            extra: { unrecognized: true },
          };
          await assert.rejects(
            owner.notices.list(null, cancel),
            (error: unknown) => {
              assert.equal((error as { kind: string }).kind, 'protocol');
              return true;
            },
          );
          const wx = platformStorage(),
            runtime = runtimeFor(actor, wx);
          let view = initialReportMutationView();
          const mutation = new ReportMutationController(
            runtime,
            'report',
            (next: typeof view) => {
              view = next;
            },
          );
          mutation.requestReport(
            'post',
            await actor.community.post(postId, cancel),
          );
          transport.corruptNext = {
            path: '/v1/me/safety/reports',
            extra: { unrecognized: true },
          };
          await mutation.confirm();
          assert.equal(view.frozen, true);
          assert.equal(view.receiptStatus, '');
          assert.ok(
            runtime.pendingReports.load(actor.credentials.accountId),
            'Malformed committed receipt retains recovery barrier',
          );
          await mutation.recover();
          assert.equal(view.frozen, false);
          const wrongKind = await raw(
            actor,
            `/v1/me/safety/report-progress/comment/${postId}`,
          );
          assert.equal(wrongKind.status, 404);
          mutation.dispose();
        },
      );

      await t.test(
        'disabled due work stays pending; restart in automatic mode settles through native owner notice without page-driven settlement',
        async () => {
          const postId = await publish();
          // Test-only clock compression at initial insertion, scoped to ONE new native
          // post. Production jury rows remain immutable and keep the exact 24-hour
          // created/deadline relationship. No origin, ballot or verdict is fabricated.
          await pool.query(`CREATE TABLE whaleu_community_test.jury_clock(post_id uuid PRIMARY KEY);
        CREATE FUNCTION whaleu_community_test.compress_jury_clock() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF EXISTS(SELECT 1 FROM whaleu_community_test.jury_clock WHERE post_id=NEW.post_id) THEN
          NEW.deadline:=date_trunc('milliseconds',clock_timestamp())+interval '2 seconds';
          NEW.created_at:=NEW.deadline-interval '24 hours';
        END IF; RETURN NEW; END $$;
        CREATE TRIGGER synthetic_jury_clock BEFORE INSERT ON whaleu_safety.post_juries FOR EACH ROW EXECUTE FUNCTION whaleu_community_test.compress_jury_clock();`);
          await pool.query(
            'INSERT INTO whaleu_community_test.jury_clock(post_id) VALUES($1)',
            [postId],
          );
          const juryId = await openJury(postId);
          accepted(
            await jurors[0]!.reports.apply(
              voteIntent(postId, juryId, 'remove'),
              cancel,
            ),
            'vote',
          );
          await pool.query(
            'DROP TRIGGER synthetic_jury_clock ON whaleu_safety.post_juries',
          );
          await eventually(
            async () =>
              (
                await pool.query<{ due: boolean }>(
                  'SELECT deadline<=clock_timestamp() AS due FROM whaleu_safety.post_juries WHERE id=$1',
                  [juryId],
                )
              ).rows[0]?.due === true,
          );
          const due = await progress(observer, postId);
          assert.ok(due.kind === 'post' && due.jury);
          assert.equal(due.jury.state, 'settlement_pending');
          assert.equal(due.jury.removeVotes, 1);
          assert.deepEqual(await owner.notices.unread(cancel), {
            unreadCount: 0,
          });
          assert.equal(
            (
              await pool.query<{ state: string }>(
                'SELECT state FROM whaleu_safety.post_juries WHERE id=$1',
                [juryId],
              )
            ).rows[0]?.state,
            'pending',
            'Reading due progress is never settlement',
          );
          await app!.close();
          app = await startApp(port, true, true);
          // Observe only the real native owner-only endpoint. No worker.run or manual
          // helper is invoked; application lifecycle starts the actual due dispatcher.
          await eventually(
            async () => (await owner.notices.unread(cancel)).unreadCount === 1,
          );
          const list = await owner.notices.list(null, cancel);
          assert.equal(list.items.length, 2);
          const automaticNotice = list.items.find(
            (item: { noticeId: string }) => item.noticeId !== removedNotice,
          );
          assert.ok(automaticNotice);
          assert.equal(automaticNotice.keepVotes, 0);
          assert.equal(automaticNotice.removeVotes, 1);
          await assert.rejects(
            progress(observer, postId),
            clientFailure('http', 404, 'REPORT_TARGET_UNAVAILABLE'),
          );
          await app!.close();
          app = await startApp(port, true, true);
          assert.deepEqual(
            await owner.notices.list(null, cancel),
            list,
            'Another worker lifecycle does not duplicate a completed notice',
          );
          const result = (
            await pool.query<{
              state: string;
              reason: string;
              notices: number;
            }>(
              `SELECT j.state,d.reason,(SELECT count(*)::integer FROM whaleu_notifications.system_notices n WHERE n.decision_id=d.id) AS notices FROM whaleu_safety.post_juries j JOIN whaleu_safety.report_decisions d ON d.id=j.decision_id WHERE j.id=$1`,
              [juryId],
            )
          ).rows[0];
          assert.deepEqual(result, {
            state: 'removed',
            reason: 'deadline',
            notices: 1,
          });
          assert.equal(
            (
              await pool.query<{ attempts: number }>(
                'SELECT sum(attempts)::integer AS attempts FROM whaleu_safety.review_obligations',
              )
            ).rows[0]?.attempts,
            0,
            'Local jury enablement never activates discussion review',
          );
        },
      );

      await t.test(
        'minimal owner receipt survives target/verification loss and runtime base visibility remains honestly unavailable',
        async () => {
          const actor = reporters[0]!;
          const original = (
            await pool.query<{ receipt: ReportReceipt }>(
              `SELECT r.receipt FROM whaleu_safety.report_requests r JOIN whaleu_safety.reports e ON e.account_id=r.account_id AND e.request_id=r.client_request_id JOIN whaleu_safety.report_cases c ON c.id=e.case_id WHERE r.account_id=$1 AND c.kind='post' AND c.target_id=$2`,
              [actor.credentials.accountId, removedPost],
            )
          ).rows[0]!.receipt;
          await setSyntheticSnapshot(pool, actor.credentials.accountId, []);
          const recovered = accepted(
            await actor.reports.receipt(original.requestId, cancel),
            'report',
          );
          assert.deepEqual(recovered, original);
          assert.deepEqual(
            await actor.reports.apply(
              reportIntent(removedPost, 'post', original.requestId),
              cancel,
            ),
            original,
          );
          await assert.rejects(
            progress(actor, removedPost),
            clientFailure('http', 404, 'REPORT_TARGET_UNAVAILABLE'),
          );
          await assert.rejects(
            observer.reports.receipt(original.requestId, cancel),
            clientFailure('http', 404, 'REQUEST_NOT_FOUND'),
          );
          assert.ok(durableReceipt);
          await app!.close();
          app = await startApp(port, false);
          await assert.rejects(
            progress(observer, keepPost),
            clientFailure('http', 503, 'COMMUNITY_UNAVAILABLE'),
          );
          assert.deepEqual(
            await actor.reports.receipt(original.requestId, cancel),
            original,
          );
          assert.deepEqual(
            await actor.reports.receipt(durableReceipt.requestId, cancel),
            durableReceipt,
          );
          const notices = await owner.notices.list(null, cancel);
          assert.equal(
            notices.items.length,
            2,
            'Owner system notices do not depend on deleted target or base visibility',
          );
          assert.equal(
            providerExchanges,
            baselineProviderExchanges,
            'Only initial synthetic logins exchange with a fixture; all moderation stays local',
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_authorization.role_grants WHERE revoked_at IS NULL',
              )
            ).rowCount,
            0,
            'Only the explicitly scoped disposable grant fixture was used and is already revoked',
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
