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
  BallotReceipt,
  CastBallot,
  OwnBallot,
  PollView,
} from '../../src/community/polls/contracts.js';
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

// Load actual native sources, including endpoint-specific decoders. Only platform
// I/O and unavailable external safety/identity providers are synthetic adapters.
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
  decodePoll,
  decodeBallotReceipt,
  decodeOwnBallot,
} = require('../../../wechat/src/community/poll-contract.ts');

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

function created<T extends PublicationReceipt | BallotReceipt>(
  receipt: T,
): Extract<T, { outcome: 'created' }> {
  assert.equal(receipt.outcome, 'created');
  assert.ok(receipt.outcome === 'created');
  return receipt as Extract<T, { outcome: 'created' }>;
}

function rejected(receipt: BallotReceipt | PublicationReceipt, code: string) {
  assert.deepEqual(receipt, {
    requestId: receipt.requestId,
    operation: receipt.operation,
    outcome: 'rejected',
    code,
  });
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
        'sessionId',
        'voters',
        'ballots',
        'identities',
        'creation_transaction',
      ].includes(key),
      `Ordinary DTO contains private field ${key}`,
    );
    noPrivateFields(child);
  }
}

test(
  'real native poll gateway, Nest HTTP and PostgreSQL contract',
  { timeout: 60000 },
  async (t) => {
    const connectionString = process.env['TEST_DATABASE_URL'];
    assert.ok(connectionString, 'Set TEST_DATABASE_URL; no silent skips');
    const url = new URL(connectionString);
    assert.ok(
      ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
      'Integration tests require loopback',
    );
    assert.equal(url.pathname, '/whaleu_test', 'Use dedicated whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: connectionString,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '4',
      PG_CONNECTION_TIMEOUT_MS: '2000',
      PG_STATEMENT_TIMEOUT_MS: '10000',
      WECHAT_APP_ID: 'wx0000000000000000',
      WECHAT_APP_SECRET: 'synthetic-local-poll-contract-only',
      AUTH_RATE_LIMIT_KEY: 'ce'.repeat(32),
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
            appId: 'synthetic-native-poll',
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
        return { credentials, auth, community: new HttpCommunityGateway(api) };
      };
      const author = await makeClient('synthetic-poll-author');
      const voter = await makeClient('synthetic-poll-voter');
      const observer = await makeClient('synthetic-poll-observer');
      const region = randomUUID(),
        spaceId = randomUUID();
      await pool.query(
        "INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES ($1,'Synthetic Poll Region',true)",
        [region],
      );
      await pool.query(
        "INSERT INTO whaleu_community.spaces(id,kind,name,is_active,operating_region_id) VALUES ($1,'regional','Synthetic Poll Space',true,$2)",
        [spaceId, region],
      );
      for (const actor of [author, voter, observer])
        await grant(
          pool,
          actor.credentials.accountId,
          spaceId,
          verified(region),
        );
      await pool.query(
        "INSERT INTO whaleu_profile.profiles(account_id,nickname) VALUES ($1,'SyntheticPollAuthor')",
        [author.credentials.accountId],
      );
      const intent = (
        authorMode: 'named' | 'anonymous',
        selectionMode: 'single' | 'multiple',
      ): PublishPost =>
        publishPostSchema.parse({
          clientRequestId: randomUUID(),
          spaceId,
          category: 'discussion',
          text: `Synthetic ${authorMode} poll body`,
          authorMode,
          component: {
            kind: 'poll',
            question: ' 独立问题🐳\n保留换行 ',
            selectionMode,
            options: [' 甲 ', '乙🐳', '吃瓜🍉'],
          },
        });
      const namedIntent = intent('named', 'single');
      const anonymousIntent = intent('anonymous', 'multiple');
      let named!: Extract<PublicationReceipt, { outcome: 'created' }>;
      let anonymous!: Extract<PublicationReceipt, { outcome: 'created' }>;
      let single!: PollView, multiple!: PollView;
      let authorSingle!: Extract<BallotReceipt, { outcome: 'created' }>;
      let authorMultiple!: Extract<BallotReceipt, { outcome: 'created' }>;
      let voterMultiple!: Extract<BallotReceipt, { outcome: 'created' }>;
      let invalidSingle!: BallotReceipt;
      let invalidIntent!: CastBallot,
        singleIntent!: CastBallot,
        multipleIntent!: CastBallot;

      await t.test(
        'native structured publication is intent-reviewed and preserves named/anonymous privacy',
        async () => {
          const unreviewed = intent('named', 'single');
          await approve(pool, author.credentials.accountId, unreviewed.text);
          const refused: PublicationReceipt =
            await author.community.publishPost(unreviewed, cancel);
          rejected(refused, 'CONTENT_REJECTED');
          // Adding review later cannot turn this finalized request into a new write.
          await approvePoll(pool, author.credentials.accountId, unreviewed);
          assert.deepEqual(
            await author.community.publishPost(unreviewed, cancel),
            refused,
          );
          for (const body of [namedIntent, anonymousIntent])
            await approvePoll(pool, author.credentials.accountId, body);
          named = created<PublicationReceipt>(
            await author.community.publishPost(namedIntent, cancel),
          );
          anonymous = created<PublicationReceipt>(
            await author.community.publishPost(anonymousIntent, cancel),
          );
          const namedPost: PostView = await observer.community.post(
            named.resourceId,
            cancel,
          );
          const anonymousPost: PostView = await observer.community.post(
            anonymous.resourceId,
            cancel,
          );
          assert.equal(namedPost.author.kind, 'named');
          assert.equal(namedPost.author.displayName, 'SyntheticPollAuthor');
          assert.equal(anonymousPost.author.kind, 'anonymous');
          assert.deepEqual(Object.keys(anonymousPost.author).sort(), [
            'avatar',
            'displayName',
            'isPostAuthor',
            'kind',
            'personaId',
          ]);
          assert.notEqual(
            anonymousPost.author.displayName,
            namedPost.author.displayName,
          );
          assert.equal(namedPost.component.kind, 'poll');
          assert.equal(anonymousPost.component.kind, 'poll');
          assert.ok(
            namedPost.component.kind === 'poll' &&
              anonymousPost.component.kind === 'poll',
          );
          single = await observer.community.poll(named.resourceId, cancel);
          multiple = await observer.community.poll(
            anonymous.resourceId,
            cancel,
          );
          assert.deepEqual(single, namedPost.component.poll);
          assert.deepEqual(multiple, anonymousPost.component.poll);
          for (const poll of [single, multiple]) {
            assert.equal(poll.question, ' 独立问题🐳\n保留换行 ');
            assert.deepEqual(
              poll.options.map((option) => option.label),
              [' 甲 ', '乙🐳', '吃瓜🍉'],
            );
            assert.deepEqual(
              poll.options.map((option) => option.position),
              [0, 1, 2],
            );
            assert.equal(poll.deadline, null);
            assert.equal(poll.expired, false);
            assert.equal(poll.voterCount, 0);
            assert.equal(poll.selectionCount, 0);
            assert.deepEqual(poll.viewer, {
              hasVoted: false,
              selectedOptionIds: [],
              canVote: true,
              reason: null,
            });
            assert.ok(
              Object.isFrozen(poll) && Object.isFrozen(poll.options[0]),
              'Native poll decoder ran',
            );
          }
          assert.equal(single.selectionMode, 'single');
          assert.equal(multiple.selectionMode, 'multiple');
          const feed: FeedPage = await observer.community.feed(
            { spaceId },
            cancel,
          );
          assert.deepEqual(
            new Set(feed.items.map((post) => post.id)),
            new Set([named.resourceId, anonymous.resourceId]),
          );
          for (const dto of [
            namedPost,
            anonymousPost,
            single,
            multiple,
            feed,
          ]) {
            noPrivateFields(dto);
            for (const actor of [author, voter, observer])
              assert.ok(
                !JSON.stringify(dto).includes(actor.credentials.accountId),
              );
          }
        },
      );

      await t.test(
        'single/multiple native ballots produce exact aggregates and viewer-only choices',
        async () => {
          invalidIntent = {
            clientRequestId: randomUUID(),
            optionIds: single.options.slice(0, 2).map((option) => option.id),
          };
          invalidSingle = await observer.community.castBallot(
            named.resourceId,
            invalidIntent,
            cancel,
          );
          rejected(invalidSingle, 'POLL_OPTIONS_INVALID');
          // Publication and ballot requests deliberately use independent namespaces.
          singleIntent = {
            clientRequestId: named.requestId,
            optionIds: [single.options[0]!.id],
          };
          authorSingle = created<BallotReceipt>(
            await author.community.castBallot(
              named.resourceId,
              singleIntent,
              cancel,
            ),
          );
          created<BallotReceipt>(
            await voter.community.castBallot(
              named.resourceId,
              {
                clientRequestId: randomUUID(),
                optionIds: [single.options[1]!.id],
              },
              cancel,
            ),
          );
          assert.equal(authorSingle.operation, 'cast_poll_ballot');
          assert.deepEqual(
            await author.community.receipt(named.requestId, cancel),
            named,
          );
          assert.deepEqual(
            await author.community.ballotReceipt(named.requestId, cancel),
            authorSingle,
          );
          multipleIntent = {
            clientRequestId: randomUUID(),
            optionIds: [multiple.options[2]!.id, multiple.options[0]!.id],
          };
          authorMultiple = created<BallotReceipt>(
            await author.community.castBallot(
              anonymous.resourceId,
              multipleIntent,
              cancel,
            ),
          );
          await assert.rejects(
            voter.community.ballotReceipt(
              multipleIntent.clientRequestId,
              cancel,
            ),
            clientFailure('http', 404, 'REQUEST_NOT_FOUND'),
          );
          await assert.rejects(
            voter.community.ownBallot(anonymous.resourceId, cancel),
            clientFailure('http', 404, 'BALLOT_NOT_FOUND'),
          );
          // Identical client UUIDs under different accounts cannot disclose or overwrite a receipt.
          voterMultiple = created<BallotReceipt>(
            await voter.community.castBallot(
              anonymous.resourceId,
              {
                clientRequestId: multipleIntent.clientRequestId,
                optionIds: [multiple.options[0]!.id, multiple.options[1]!.id],
              },
              cancel,
            ),
          );
          assert.notEqual(voterMultiple.resourceId, authorMultiple.resourceId);
          assert.deepEqual(
            await voter.community.ballotReceipt(
              multipleIntent.clientRequestId,
              cancel,
            ),
            voterMultiple,
          );
          const authorView: PollView = await author.community.poll(
            anonymous.resourceId,
            cancel,
          );
          const voterView: PollView = await voter.community.poll(
            anonymous.resourceId,
            cancel,
          );
          const observerView: PollView = await observer.community.poll(
            anonymous.resourceId,
            cancel,
          );
          const singleView: PollView = await observer.community.poll(
            named.resourceId,
            cancel,
          );
          assert.deepEqual(
            [
              singleView.voterCount,
              singleView.selectionCount,
              singleView.options.map((option) => option.count),
            ],
            [2, 2, [1, 1, 0]],
          );
          for (const view of [authorView, voterView, observerView]) {
            assert.deepEqual(
              [
                view.voterCount,
                view.selectionCount,
                view.options.map((option) => option.count),
              ],
              [2, 4, [2, 1, 1]],
            );
            noPrivateFields(view);
            assert.ok(
              !JSON.stringify(view).includes(author.credentials.accountId),
            );
            assert.ok(
              !JSON.stringify(view).includes(voter.credentials.accountId),
            );
          }
          assert.deepEqual(authorView.viewer, {
            hasVoted: true,
            selectedOptionIds: [...multipleIntent.optionIds].sort(),
            canVote: false,
            reason: 'POLL_ALREADY_VOTED',
          });
          assert.deepEqual(
            voterView.viewer.selectedOptionIds,
            [multiple.options[0]!.id, multiple.options[1]!.id].sort(),
          );
          assert.deepEqual(observerView.viewer, {
            hasVoted: false,
            selectedOptionIds: [],
            canVote: true,
            reason: null,
          });
          const repeated: BallotReceipt = await author.community.castBallot(
            anonymous.resourceId,
            { ...multipleIntent, clientRequestId: randomUUID() },
            cancel,
          );
          rejected(repeated, 'POLL_ALREADY_VOTED');
        },
      );

      await t.test(
        'restart recovers immutable successful and rejected requests without duplicate ballots',
        async () => {
          await app!.close();
          app = undefined;
          app = await startApp(port);
          const restored = await makeClient(
            'unused-saved-author',
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
          assert.deepEqual(
            await restored.community.ballotReceipt(
              authorMultiple.requestId,
              cancel,
            ),
            authorMultiple,
          );
          assert.deepEqual(
            await restored.community.castBallot(
              anonymous.resourceId,
              {
                ...multipleIntent,
                optionIds: [...multipleIntent.optionIds].reverse(),
              },
              cancel,
            ),
            authorMultiple,
          );
          assert.deepEqual(
            await observer.community.ballotReceipt(
              invalidIntent.clientRequestId,
              cancel,
            ),
            invalidSingle,
          );
          assert.deepEqual(
            await observer.community.castBallot(
              named.resourceId,
              invalidIntent,
              cancel,
            ),
            invalidSingle,
          );
          for (const operation of [
            () =>
              restored.community.castBallot(
                anonymous.resourceId,
                { ...multipleIntent, optionIds: [multiple.options[1]!.id] },
                cancel,
              ),
            () =>
              restored.community.castBallot(
                named.resourceId,
                multipleIntent,
                cancel,
              ),
            () =>
              observer.community.castBallot(
                named.resourceId,
                { ...invalidIntent, optionIds: [single.options[0]!.id] },
                cancel,
              ),
            () =>
              restored.community.publishPost(
                {
                  ...namedIntent,
                  component: {
                    ...namedIntent.component,
                    question: 'Changed poll question',
                  },
                },
                cancel,
              ),
          ])
            await assert.rejects(
              operation(),
              clientFailure('business', 409, 'REQUEST_CONFLICT'),
            );
          const own: OwnBallot = await restored.community.ownBallot(
            anonymous.resourceId,
            cancel,
          );
          assert.deepEqual(own, {
            postId: anonymous.resourceId,
            ballotId: authorMultiple.resourceId,
            createdAt: authorMultiple.createdAt,
            selectedOptionIds: [...multipleIntent.optionIds].sort(),
          });
          assert.ok(
            Object.isFrozen(own) && Object.isFrozen(own.selectedOptionIds),
          );
          assert.equal(
            (await pool.query('SELECT * FROM whaleu_community.poll_ballots'))
              .rowCount,
            4,
          );
          assert.equal(
            (await pool.query('SELECT * FROM whaleu_community.poll_selections'))
              .rowCount,
            6,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM whaleu_community.poll_ballot_requests WHERE receipt IS NULL',
              )
            ).rowCount,
            0,
          );
          const sharedKey = await pool.query<{ receipt: BallotReceipt }>(
            'SELECT receipt FROM whaleu_community.poll_ballot_requests WHERE client_request_id=$1 ORDER BY account_id',
            [multipleIntent.clientRequestId],
          );
          assert.deepEqual(
            new Set(sharedKey.rows.map((row) => row.receipt)),
            new Set([authorMultiple, voterMultiple]),
          );
        },
      );

      await t.test(
        'hidden/deleted parents refuse poll access while own receipt/status recovery stays minimal',
        async () => {
          await pool.query(
            'INSERT INTO whaleu_community_test.blocks(viewer,author) VALUES ($1,$2)',
            [observer.credentials.accountId, author.credentials.accountId],
          );
          await assert.rejects(
            observer.community.poll(named.resourceId, cancel),
            clientFailure('http', 404, 'POST_NOT_FOUND'),
          );
          const hiddenIntent: CastBallot = {
            clientRequestId: randomUUID(),
            optionIds: [single.options[0]!.id],
          };
          const hidden: BallotReceipt = await observer.community.castBallot(
            named.resourceId,
            hiddenIntent,
            cancel,
          );
          rejected(hidden, 'POST_NOT_FOUND');
          await pool.query(
            'DELETE FROM whaleu_community_test.blocks WHERE viewer=$1',
            [observer.credentials.accountId],
          );
          assert.deepEqual(
            await observer.community.castBallot(
              named.resourceId,
              hiddenIntent,
              cancel,
            ),
            hidden,
          );
          await assert.rejects(
            observer.community.ownBallot(named.resourceId, cancel),
            clientFailure('http', 404, 'BALLOT_NOT_FOUND'),
          );
          await author.community.deletePost(named.resourceId, cancel);
          await pool.query(
            'DELETE FROM whaleu_community_test.grants WHERE account_id=$1',
            [voter.credentials.accountId],
          );
          for (const actor of [author, voter, observer]) {
            await assert.rejects(
              actor.community.poll(named.resourceId, cancel),
              clientFailure('http', 404, 'POST_NOT_FOUND'),
            );
            await assert.rejects(
              actor.community.post(named.resourceId, cancel),
              clientFailure('http', 404, 'POST_NOT_FOUND'),
            );
          }
          assert.deepEqual(
            await author.community.ballotReceipt(
              authorSingle.requestId,
              cancel,
            ),
            authorSingle,
          );
          assert.deepEqual(
            await author.community.castBallot(
              named.resourceId,
              singleIntent,
              cancel,
            ),
            authorSingle,
          );
          const ownAuthor: OwnBallot = await author.community.ownBallot(
            named.resourceId,
            cancel,
          );
          const ownVoter: OwnBallot = await voter.community.ownBallot(
            named.resourceId,
            cancel,
          );
          assert.deepEqual(ownAuthor, {
            postId: named.resourceId,
            ballotId: authorSingle.resourceId,
            createdAt: authorSingle.createdAt,
            selectedOptionIds: singleIntent.optionIds,
          });
          assert.deepEqual(ownVoter.selectedOptionIds, [single.options[1]!.id]);
          for (const own of [ownAuthor, ownVoter]) {
            assert.deepEqual(Object.keys(own).sort(), [
              'ballotId',
              'createdAt',
              'postId',
              'selectedOptionIds',
            ]);
            noPrivateFields(own);
            assert.ok(!JSON.stringify(own).includes(single.question));
          }
          const feed: FeedPage = await observer.community.feed(
            { spaceId },
            cancel,
          );
          assert.deepEqual(
            feed.items.map((post) => post.id),
            [anonymous.resourceId],
          );
          assert.equal(
            (await pool.query('SELECT * FROM whaleu_community.poll_ballots'))
              .rowCount,
            4,
          );
        },
      );

      await t.test(
        'real HTTP errors remain safely typed and native decoders refuse extra identity data',
        async () => {
          await assert.rejects(
            author.community.poll(randomUUID(), cancel),
            clientFailure('http', 404, 'POST_NOT_FOUND'),
          );
          await assert.rejects(
            observer.community.ballotReceipt(authorMultiple.requestId, cancel),
            clientFailure('http', 404, 'REQUEST_NOT_FOUND'),
          );
          assert.throws(
            () =>
              decodePoll({
                ...multiple,
                accountId: author.credentials.accountId,
              }),
            { kind: 'protocol' },
          );
          assert.throws(
            () =>
              decodeBallotReceipt({
                ...authorMultiple,
                optionIds: multipleIntent.optionIds,
              }),
            { kind: 'protocol' },
          );
          const own: OwnBallot = await author.community.ownBallot(
            anonymous.resourceId,
            cancel,
          );
          assert.throws(
            () => decodeOwnBallot({ ...own, question: multiple.question }),
            { kind: 'protocol' },
          );
          const internalMarker = 'SYNTHETIC-INTERNAL-SQL-AND-ACCOUNT-DETAIL';
          authorization.beforeResolve = async () => {
            throw new Error(internalMarker);
          };
          try {
            await assert.rejects(
              author.community.poll(anonymous.resourceId, cancel),
              (error: unknown) => {
                clientFailure('http', 500, 'INTERNAL_ERROR')(error);
                assert.ok(error instanceof Error);
                assert.equal(error.message, 'The server rejected the request');
                assert.ok(!JSON.stringify(error).includes(internalMarker));
                return true;
              },
            );
          } finally {
            authorization.beforeResolve = null;
          }
          await author.auth.logout();
          const revoked = await makeClient(
            'unused-revoked-author',
            author.credentials,
          );
          const before = transport.exchanges.length;
          await assert.rejects(
            revoked.community.castBallot(
              anonymous.resourceId,
              multipleIntent,
              cancel,
            ),
            clientFailure('auth-required', 401, 'SESSION_REVOKED'),
          );
          assert.equal(
            transport.exchanges.length,
            before + 1,
            'Revocation cannot refresh or replay the mutation',
          );
          assert.equal(
            (await pool.query('SELECT * FROM whaleu_community.poll_ballots'))
              .rowCount,
            4,
          );
          assert.ok(
            transport.exchanges
              .filter((exchange) => exchange.path.includes('/poll'))
              .every((exchange) => exchange.authorized),
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
