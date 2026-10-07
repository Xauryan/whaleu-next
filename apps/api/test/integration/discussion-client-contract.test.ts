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
import type {
  CommentView,
  PostView,
  PublicationReceipt,
  PublishPost,
  PublishComment,
  ReplyView,
} from '../../src/community/contracts.js';
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
import { STUDENT_IDENTITY_SOURCE } from '../../src/identity-privacy/contracts.js';
import type {
  PrivateIdentity,
  StudentIdentitySource,
  VerifiedStudentIdentity,
} from '../../src/identity-privacy/contracts.js';
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

// Execute the real native sources. Only platform I/O and unavailable external
// providers are substituted, in this test module only; no runtime bypass exists.
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
  decodeComment,
  decodePost,
  decodeReceipt,
} = require('../../../wechat/src/community/contract.ts');
const {
  decodeReply,
  decodeReplies,
  decodeDiscussionContext,
  decodeDiscussionReceipt,
} = require('../../../wechat/src/community/discussion-contract.ts');
const {
  HttpIdentityPrivacyGateway,
  IdentityOverlayController,
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

class FixtureStudents implements StudentIdentitySource {
  async resolve(
    accountId: string,
    tx: PoolClient,
  ): Promise<VerifiedStudentIdentity> {
    const row = (
      await tx.query<{ student_number: string }>(
        'SELECT student_number FROM whaleu_community_test.students WHERE account_id=$1 FOR SHARE',
        [accountId],
      )
    ).rows[0];
    return row
      ? {
          status: 'verified',
          studentNumber: row.student_number,
          validUntil: null,
        }
      : { status: 'unverified' };
  }
}
function created(
  receipt: PublicationReceipt,
): Extract<PublicationReceipt, { outcome: 'created' }> {
  assert.equal(receipt.outcome, 'created');
  assert.ok(receipt.outcome === 'created');
  return receipt;
}
interface OverlayView {
  developerEnabled: boolean;
  items: Readonly<Record<string, PrivateIdentity>>;
  notice: string;
}
function noPrivateFields(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(
      ![
        'accountId',
        'studentNumber',
        'studentNumberStatus',
        'identity',
        'identities',
        'account_id',
        'sessionId',
        'phone',
        'pinActor',
        'namedAccountId',
      ].includes(key),
      `Ordinary DTO contains private field ${key}`,
    );
    noPrivateFields(child);
  }
}

interface ReplyIntent extends PublishComment {
  targetReplyId: string | null;
}
interface Roots {
  items: CommentView[];
  nextCursor: string | null;
}
interface Replies {
  items: ReplyView[];
  nextCursor: string | null;
}
interface Context {
  comment: CommentView;
  reply: ReplyView | null;
  replies: Replies;
}
type MutationOperation =
  'set_comment_like' | 'set_reply_like' | 'set_comment_pin';
type MutationReceipt = {
  requestId: string;
  operation: MutationOperation;
} & (
  | { outcome: 'applied'; resourceId: string; desired: boolean }
  | { outcome: 'rejected'; code: string }
);
function applied(
  receipt: MutationReceipt,
  operation: MutationOperation,
  resourceId: string,
  desired: boolean,
) {
  assert.deepEqual(receipt, {
    requestId: receipt.requestId,
    operation,
    outcome: 'applied',
    resourceId,
    desired,
  });
  noPrivateFields(receipt);
  assert.ok(
    Object.isFrozen(receipt),
    'The native mutation receipt decoder ran',
  );
}
function rejected(receipt: PublicationReceipt | MutationReceipt, code: string) {
  assert.deepEqual(receipt, {
    requestId: receipt.requestId,
    operation: receipt.operation,
    outcome: 'rejected',
    code,
  });
}

test(
  'real native discussion/privacy gateways, Nest HTTP and PostgreSQL contract',
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
      'Integration tests require dedicated whaleu_test database',
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
      WECHAT_APP_SECRET: 'synthetic-local-discussion-contract-only',
      AUTH_RATE_LIMIT_KEY: 'df'.repeat(32),
    });
    const pool = new Pool(poolOptions(config));
    let suite: PoolClient | undefined;
    let locked = false,
      ownsSchemas = false;
    let app: INestApplication | undefined;
    const content = new FixtureContent();
    const startApp = async (port = 0): Promise<INestApplication> => {
      const module = await Test.createTestingModule({
        imports: [AppModule.register(config)],
      })
        .overrideProvider(IDENTITY_PROVIDER)
        .useValue({
          exchange: async (code: string) => ({
            provider: 'wechat',
            appId: 'synthetic-native-discussion',
            subject: code,
          }),
        })
        .overrideProvider(COMMUNITY_AUTHORIZATION)
        .useValue(new FixtureAuthorization())
        .overrideProvider(COMMUNITY_VISIBILITY)
        .useValue(new FixtureVisibility())
        .overrideProvider(CONTENT_PUBLICATION_GATE)
        .useValue(content)
        .overrideProvider(MEDIA_ATTACHMENT)
        .useValue(new FixtureMedia())
        .overrideProvider(STUDENT_IDENTITY_SOURCE)
        .useValue(new FixtureStudents())
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
        'Another suite owns the disposable database; run serially',
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
        'Refusing existing whaleu schemas; use a fresh disposable database',
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
      await pool.query(
        'CREATE TABLE whaleu_community_test.students(account_id uuid PRIMARY KEY,student_number text NOT NULL)',
      );
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
          sessions,
          auth,
          credentials,
          api,
          community: new HttpCommunityGateway(api),
          privacy: new HttpIdentityPrivacyGateway(api),
        };
      };
      const author = await makeClient('synthetic-discussion-author');
      const developer = await makeClient('synthetic-discussion-developer');
      const other = await makeClient('synthetic-discussion-other');
      const observer = await makeClient('synthetic-discussion-observer');
      const region = randomUUID(),
        spaceId = randomUUID(),
        institution = randomUUID(),
        campus = randomUUID();
      const developerGrant = randomUUID();
      const studentNumber = 'SYNTHETIC-20260001';
      await pool.query(
        "INSERT INTO whaleu_campus.institutions(id,name) VALUES ($1,'Synthetic Native Contract University')",
        [institution],
      );
      await pool.query(
        "INSERT INTO whaleu_campus.campuses(id,institution_id,full_name,district,is_active) VALUES ($1,$2,'Synthetic Native Campus','Synthetic District',true)",
        [campus, institution],
      );
      await pool.query(
        "INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES ($1,'Synthetic Native Region',true)",
        [region],
      );
      await pool.query(
        'INSERT INTO whaleu_campus.campus_region_assignments(campus_id,operating_region_id) VALUES ($1,$2)',
        [campus, region],
      );
      await pool.query(
        "INSERT INTO whaleu_community.spaces(id,kind,name,is_active,operating_region_id) VALUES ($1,'regional','Synthetic Native Space',true,$2)",
        [spaceId, region],
      );
      for (const actor of [author, developer, other, observer])
        await grant(
          pool,
          actor.credentials.accountId,
          spaceId,
          verified(region),
        );
      await pool.query(
        "INSERT INTO whaleu_profile.profiles(account_id,nickname) VALUES ($1,'SyntheticAuthor')",
        [author.credentials.accountId],
      );
      await pool.query(
        'INSERT INTO whaleu_community_test.students(account_id,student_number) VALUES ($1,$2)',
        [author.credentials.accountId, studentNumber],
      );
      await pool.query(
        "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,approved_by_account_id,approval_reference) VALUES ($1,$2,'developer',$2,'synthetic-fixture-only'),($3,$4,'super_admin',$2,'synthetic-fixture-only')",
        [
          developerGrant,
          developer.credentials.accountId,
          randomUUID(),
          other.credentials.accountId,
        ],
      );
      const intent = (
        text: string,
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
      const namedIntent = intent('Synthetic named discussion parent');
      const anonymousIntent = intent(
        'Synthetic anonymous discussion parent',
        'anonymous',
      );
      let named!: Extract<PublicationReceipt, { outcome: 'created' }>;
      let anonymous!: Extract<PublicationReceipt, { outcome: 'created' }>;
      let rootA!: Extract<PublicationReceipt, { outcome: 'created' }>;
      let rootB!: Extract<PublicationReceipt, { outcome: 'created' }>;
      let rootC!: Extract<PublicationReceipt, { outcome: 'created' }>;
      let anonymousRoot!: Extract<PublicationReceipt, { outcome: 'created' }>;
      const replies: Extract<PublicationReceipt, { outcome: 'created' }>[] = [];
      const replyBodies: ReplyIntent[] = [];
      const rootBody = (
        text: string,
        authorMode: 'named' | 'anonymous',
      ): PublishComment => ({
        clientRequestId: randomUUID(),
        text,
        authorMode,
        imageAssetIds: [],
      });
      const publishRoot = async (
        actor: typeof author,
        postId: string,
        text: string,
        mode: 'named' | 'anonymous',
      ) => {
        const body = rootBody(text, mode);
        await approve(
          pool,
          actor.credentials.accountId,
          text,
          'publish_comment',
        );
        return created(
          await actor.community.publishComment(postId, body, cancel),
        );
      };
      const publishReply = async (
        actor: typeof author,
        postId: string,
        rootId: string,
        body: ReplyIntent,
      ) => {
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
      const counts = async (
        actor: typeof author,
        roots: number,
        visibleReplies: number,
      ) => {
        const post: PostView = await actor.community.post(
          named.resourceId,
          cancel,
        );
        assert.equal(
          post.commentCount,
          roots,
          'Existing commentCount continues to mean visible roots',
        );
        assert.equal(post.replyCount, visibleReplies);
        assert.equal(post.discussionCount, roots + visibleReplies);
        noPrivateFields(post);
        const feed: { items: PostView[] } = await actor.community.feed(
          { spaceId },
          cancel,
        );
        const inFeed = feed.items.find((item) => item.id === named.resourceId);
        assert.ok(inFeed);
        assert.equal(inFeed.commentCount, roots);
        assert.equal(inFeed.replyCount, visibleReplies);
        assert.equal(inFeed.discussionCount, roots + visibleReplies);
      };

      await t.test(
        'native root and reply publication preserves flat targets and anonymous identity boundaries',
        async () => {
          for (const body of [namedIntent, anonymousIntent])
            await approve(pool, author.credentials.accountId, body.text);
          named = created(
            await author.community.publishPost(namedIntent, cancel),
          );
          anonymous = created(
            await author.community.publishPost(anonymousIntent, cancel),
          );
          rootA = await publishRoot(
            author,
            named.resourceId,
            'Synthetic anonymous root on named parent',
            'anonymous',
          );
          rootB = await publishRoot(
            other,
            named.resourceId,
            'Synthetic other named root',
            'named',
          );
          rootC = await publishRoot(
            author,
            named.resourceId,
            'Synthetic later named root',
            'named',
          );
          anonymousRoot = await publishRoot(
            author,
            anonymous.resourceId,
            'Synthetic own anonymous parent root',
            'named',
          );
          for (const [index, actor, mode] of [
            [0, other, 'anonymous'],
            [1, author, 'anonymous'],
            [2, other, 'named'],
            [3, author, 'named'],
          ] as const) {
            const body: ReplyIntent = {
              ...rootBody(`Synthetic reply ${index + 1} 🐳`, mode),
              targetReplyId:
                index === 0
                  ? null
                  : replies[index === 3 ? 0 : index - 1]!.resourceId,
            };
            replyBodies.push(body);
            replies.push(
              await publishReply(
                actor,
                named.resourceId,
                rootA.resourceId,
                body,
              ),
            );
          }
          const parent: PostView = await observer.community.post(
            named.resourceId,
            cancel,
          );
          const root: CommentView = await observer.community.comment(
            rootA.resourceId,
            cancel,
          );
          const first: ReplyView = await observer.community.reply(
            replies[0]!.resourceId,
            cancel,
          );
          const second: ReplyView = await observer.community.reply(
            replies[1]!.resourceId,
            cancel,
          );
          assert.equal(parent.author.kind, 'named');
          assert.equal(root.author.kind, 'anonymous');
          assert.equal(first.author.kind, 'anonymous');
          assert.equal(second.author.kind, 'anonymous');
          assert.ok(
            root.author.kind === 'anonymous' &&
              first.author.kind === 'anonymous' &&
              second.author.kind === 'anonymous',
          );
          assert.equal(
            root.author.isPostAuthor,
            false,
            'Named parent must not link an anonymous participant to its named author',
          );
          assert.equal(second.author.isPostAuthor, false);
          assert.deepEqual(
            second.author,
            root.author,
            'The same account reuses its persisted per-post persona',
          );
          assert.notEqual(first.author.personaId, root.author.personaId);
          assert.deepEqual(first.target, {
            kind: 'comment',
            id: rootA.resourceId,
            status: 'available',
            author: root.author,
          });
          assert.deepEqual(second.target, {
            kind: 'reply',
            id: first.id,
            status: 'available',
            author: first.author,
          });
          assert.equal(
            second.rootCommentId,
            rootA.resourceId,
            'Reply-to-reply is flat under the original root',
          );
          assert.equal(second.viewer.isSelf, false);
          assert.equal(
            (await author.community.reply(second.id, cancel)).viewer.isSelf,
            true,
          );
          const anonymousBody: ReplyIntent = {
            ...rootBody('Synthetic own-anonymous reply', 'named'),
            targetReplyId: null,
          };
          await approveReply(
            pool,
            author.credentials.accountId,
            anonymous.resourceId,
            anonymousRoot.resourceId,
            anonymousBody,
            'anonymous',
          );
          const anonymousReply = created(
            await author.community.publishReply(
              anonymousRoot.resourceId,
              anonymousBody,
              cancel,
            ),
          );
          const anonymousPost: PostView = await observer.community.post(
            anonymous.resourceId,
            cancel,
          );
          const ownAnon: ReplyView = await observer.community.reply(
            anonymousReply.resourceId,
            cancel,
          );
          assert.deepEqual(ownAnon.author, anonymousPost.author);
          assert.deepEqual(
            (await observer.community.comment(anonymousRoot.resourceId, cancel))
              .author,
            anonymousPost.author,
            'Own anonymous parent forces one persisted anonymous persona for roots and replies',
          );
          assert.notDeepEqual(
            ownAnon.author,
            root.author,
            'Personas are isolated by post',
          );
          for (const dto of [root, first, second, ownAnon, ...replies]) {
            noPrivateFields(dto);
            assert.ok(
              !JSON.stringify(dto).includes(author.credentials.accountId),
            );
            assert.ok(!JSON.stringify(dto).includes(studentNumber));
          }
          assert.ok(
            Object.isFrozen(second) &&
              Object.isFrozen(second.target) &&
              Object.isFrozen(second.author),
            'Actual native recursive decoder ran',
          );
          await counts(observer, 3, 4);
        },
      );

      await t.test(
        'inline previews, sorted traversal and distant context preserve complete visible counts',
        async () => {
          const root: CommentView = await observer.community.comment(
            rootA.resourceId,
            cancel,
          );
          assert.equal(root.replyCount, 4);
          assert.deepEqual(
            root.replyPreview.items.map((item) => item.id),
            replies.slice(0, 2).map((item) => item.resourceId),
          );
          assert.ok(root.replyPreview.nextCursor);
          const continued: Replies = await observer.community.replies(
            rootA.resourceId,
            root.replyPreview.nextCursor,
            cancel,
          );
          assert.deepEqual(
            continued.items.map((item) => item.id),
            replies.slice(2).map((item) => item.resourceId),
          );
          assert.equal(continued.nextCursor, null);
          const first: Replies = await observer.community.replies(
            rootA.resourceId,
            null,
            cancel,
            2,
          );
          assert.deepEqual(first.items, root.replyPreview.items);
          const pagedContinuation: Replies = await observer.community.replies(
            rootA.resourceId,
            first.nextCursor,
            cancel,
            2,
          );
          assert.deepEqual(pagedContinuation.items, continued.items);
          assert.equal(pagedContinuation.nextCursor, null);
          const all: Replies = await observer.community.replies(
            rootA.resourceId,
            null,
            cancel,
            50,
          );
          assert.deepEqual(
            all.items.map((item) => item.id),
            replies.map((item) => item.resourceId),
          );
          assert.equal(
            new Set([...first.items, ...continued.items].map((item) => item.id))
              .size,
            4,
          );
          assert.equal(all.nextCursor, null);
          const page: Roots = await observer.community.comments(
            named.resourceId,
            null,
            cancel,
            { sort: 'time', order: 'desc', limit: 1 },
          );
          assert.deepEqual(
            page.items.map((item) => item.id),
            [rootC.resourceId],
          );
          assert.ok(page.nextCursor);
          const context: Context = await observer.community.discussionContext(
            named.resourceId,
            { replyId: replies[3]!.resourceId },
            cancel,
          );
          assert.equal(context.comment.id, rootA.resourceId);
          assert.equal(context.reply?.id, replies[3]!.resourceId);
          assert.ok(
            context.replies.items.some(
              (item) => item.id === replies[3]!.resourceId,
            ),
          );
          assert.deepEqual(
            context.comment.replyPreview,
            root.replyPreview,
            'Located target cannot replace the ordinary preview continuation',
          );
          const next: Roots = await observer.community.comments(
            named.resourceId,
            page.nextCursor,
            cancel,
            { sort: 'time', order: 'desc', limit: 1 },
          );
          assert.deepEqual(
            next.items.map((item) => item.id),
            [rootB.resourceId],
          );
          assert.ok(next.nextCursor);
          const last: Roots = await observer.community.comments(
            named.resourceId,
            next.nextCursor,
            cancel,
            { sort: 'time', order: 'desc', limit: 1 },
          );
          assert.deepEqual(
            last.items.map((item) => item.id),
            [rootA.resourceId],
          );
          assert.equal(last.nextCursor, null);
          for (const query of [
            { sort: 'likes', order: 'desc', limit: 1 },
            { sort: 'time', order: 'asc', limit: 1 },
            { sort: 'time', order: 'desc', limit: 2 },
          ])
            await assert.rejects(
              observer.community.comments(
                named.resourceId,
                page.nextCursor,
                cancel,
                query,
              ),
              clientFailure('business', 409, 'DISCUSSION_RESTART_REQUIRED'),
            );
          const rootContext: Context =
            await observer.community.discussionContext(
              named.resourceId,
              { commentId: rootA.resourceId },
              cancel,
            );
          assert.equal(rootContext.reply, null);
          assert.equal(rootContext.comment.id, rootA.resourceId);
          noPrivateFields(context);
          assert.ok(
            Object.isFrozen(context) && Object.isFrozen(context.replies.items),
          );
        },
      );

      await t.test(
        'durable desired-state receipts recover response loss and cannot reapply older opposite intentions',
        async () => {
          const likeId = randomUUID(),
            pinId = randomUUID();
          const likePath = `/v1/community/replies/${replies[0]!.resourceId}/like`;
          transport.dropSuccess = { path: likePath, method: 'PUT' };
          await assert.rejects(
            observer.community.discussionLike(
              'reply',
              replies[0]!.resourceId,
              true,
              likeId,
              cancel,
            ),
            { kind: 'network' },
          );
          const firstLike: MutationReceipt =
            await observer.community.discussionReceipt(likeId, cancel);
          applied(firstLike, 'set_reply_like', replies[0]!.resourceId, true);
          assert.equal(
            (await observer.community.reply(replies[0]!.resourceId, cancel))
              .likeCount,
            1,
          );
          transport.dropSuccess = {
            path: `/v1/community/comments/${rootA.resourceId}/pin`,
            method: 'PUT',
          };
          await assert.rejects(
            author.community.pinComment(
              named.resourceId,
              rootA.resourceId,
              true,
              pinId,
              cancel,
            ),
            { kind: 'network' },
          );
          await app!.close();
          app = undefined;
          app = await startApp(port);
          const restoredAuthor = await makeClient(
            'unused-restored-author',
            author.credentials,
          );
          const restoredObserver = await makeClient(
            'unused-restored-observer',
            observer.credentials,
          );
          const firstPin: MutationReceipt =
            await restoredAuthor.community.discussionReceipt(pinId, cancel);
          applied(firstPin, 'set_comment_pin', rootA.resourceId, true);
          assert.deepEqual(
            await restoredObserver.community.discussionReceipt(likeId, cancel),
            firstLike,
          );
          const pinTime = (
            await pool.query<{ pinned_at: Date }>(
              'SELECT pinned_at FROM whaleu_community.comment_pins WHERE post_id=$1',
              [named.resourceId],
            )
          ).rows[0]!.pinned_at;
          applied(
            await restoredAuthor.community.pinComment(
              named.resourceId,
              rootA.resourceId,
              true,
              randomUUID(),
              cancel,
            ),
            'set_comment_pin',
            rootA.resourceId,
            true,
          );
          assert.deepEqual(
            (
              await pool.query(
                'SELECT pinned_at FROM whaleu_community.comment_pins WHERE post_id=$1',
                [named.resourceId],
              )
            ).rows[0]!.pinned_at,
            pinTime,
          );
          const unlikeId = randomUUID(),
            unpinId = randomUUID();
          applied(
            await restoredObserver.community.discussionLike(
              'reply',
              replies[0]!.resourceId,
              false,
              unlikeId,
              cancel,
            ),
            'set_reply_like',
            replies[0]!.resourceId,
            false,
          );
          applied(
            await restoredAuthor.community.pinComment(
              named.resourceId,
              rootA.resourceId,
              false,
              unpinId,
              cancel,
            ),
            'set_comment_pin',
            rootA.resourceId,
            false,
          );
          assert.deepEqual(
            await restoredObserver.community.discussionLike(
              'reply',
              replies[0]!.resourceId,
              true,
              likeId,
              cancel,
            ),
            firstLike,
          );
          assert.deepEqual(
            await restoredAuthor.community.pinComment(
              named.resourceId,
              rootA.resourceId,
              true,
              pinId,
              cancel,
            ),
            firstPin,
          );
          const currentReply: ReplyView =
            await restoredObserver.community.reply(
              replies[0]!.resourceId,
              cancel,
            );
          assert.equal(currentReply.viewer.isLiked, false);
          assert.equal(
            currentReply.likeCount,
            0,
            'Historical receipt is not a command to restore stale state',
          );
          assert.equal(
            (await restoredObserver.community.comment(rootA.resourceId, cancel))
              .isPinned,
            false,
          );
          for (const operation of [
            () =>
              restoredObserver.community.discussionLike(
                'reply',
                replies[0]!.resourceId,
                false,
                likeId,
                cancel,
              ),
            () =>
              restoredObserver.community.discussionLike(
                'comment',
                rootA.resourceId,
                true,
                likeId,
                cancel,
              ),
            () =>
              restoredAuthor.community.pinComment(
                named.resourceId,
                rootB.resourceId,
                true,
                pinId,
                cancel,
              ),
          ])
            await assert.rejects(
              operation(),
              clientFailure('business', 409, 'REQUEST_CONFLICT'),
            );
          await assert.rejects(
            other.community.discussionReceipt(likeId, cancel),
            clientFailure('http', 404, 'REQUEST_NOT_FOUND'),
          );
          assert.deepEqual(
            await author.community.receipt(replies[1]!.requestId, cancel),
            replies[1],
          );
          assert.deepEqual(
            await author.community.publishReply(
              rootA.resourceId,
              replyBodies[1],
              cancel,
            ),
            replies[1],
          );
          await assert.rejects(
            author.community.publishReply(
              rootA.resourceId,
              { ...replyBodies[1], targetReplyId: null },
              cancel,
            ),
            clientFailure('business', 409, 'REQUEST_CONFLICT'),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT id FROM whaleu_community.replies WHERE root_comment_id=$1',
                [rootA.resourceId],
              )
            ).rowCount,
            4,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.discussion_requests WHERE receipt IS NULL',
              )
            ).rowCount,
            0,
          );
          assert.throws(
            () => decodeDiscussionReceipt({ ...firstLike, likeCount: 0 }),
            { kind: 'protocol' },
          );
        },
      );

      await t.test(
        'root likes and one author pin define sorting and require restarting stale cursors',
        async () => {
          const before: Roots = await observer.community.comments(
            named.resourceId,
            null,
            cancel,
            { sort: 'likes', order: 'desc', limit: 1 },
          );
          assert.ok(before.nextCursor);
          for (const actor of [author, observer])
            applied(
              await actor.community.discussionLike(
                'comment',
                rootB.resourceId,
                true,
                randomUUID(),
                cancel,
              ),
              'set_comment_like',
              rootB.resourceId,
              true,
            );
          applied(
            await observer.community.discussionLike(
              'comment',
              rootC.resourceId,
              true,
              randomUUID(),
              cancel,
            ),
            'set_comment_like',
            rootC.resourceId,
            true,
          );
          await assert.rejects(
            observer.community.comments(
              named.resourceId,
              before.nextCursor,
              cancel,
              { sort: 'likes', order: 'desc', limit: 1 },
            ),
            clientFailure('business', 409, 'DISCUSSION_RESTART_REQUIRED'),
          );
          const sorted: Roots = await observer.community.comments(
            named.resourceId,
            null,
            cancel,
            { sort: 'likes', order: 'desc' },
          );
          assert.deepEqual(
            sorted.items.map((item) => item.id),
            [rootB.resourceId, rootC.resourceId, rootA.resourceId],
          );
          assert.deepEqual(
            sorted.items.map((item) => item.likeCount),
            [2, 1, 0],
          );
          applied(
            await author.community.pinComment(
              named.resourceId,
              rootA.resourceId,
              true,
              randomUUID(),
              cancel,
            ),
            'set_comment_pin',
            rootA.resourceId,
            true,
          );
          for (const [sort, order, expected] of [
            [
              'likes',
              'desc',
              [rootA.resourceId, rootB.resourceId, rootC.resourceId],
            ],
            [
              'likes',
              'asc',
              [rootA.resourceId, rootC.resourceId, rootB.resourceId],
            ],
            [
              'time',
              'desc',
              [rootA.resourceId, rootC.resourceId, rootB.resourceId],
            ],
            [
              'time',
              'asc',
              [rootA.resourceId, rootB.resourceId, rootC.resourceId],
            ],
          ] as const) {
            const result: Roots = await observer.community.comments(
              named.resourceId,
              null,
              cancel,
              { sort, order },
            );
            assert.deepEqual(
              result.items.map((item) => item.id),
              expected,
            );
            assert.equal(result.items[0]!.isPinned, true);
            assert.equal(result.items[0]!.viewer.canPin, false);
          }
          assert.equal(
            (await author.community.comment(rootA.resourceId, cancel)).viewer
              .canPin,
            true,
          );
          const conflict: MutationReceipt = await author.community.pinComment(
            named.resourceId,
            rootB.resourceId,
            true,
            randomUUID(),
            cancel,
          );
          rejected(conflict, 'COMMENT_PIN_CONFLICT');
          for (const actor of [other, developer]) {
            const denied: MutationReceipt = await actor.community.pinComment(
              named.resourceId,
              rootB.resourceId,
              true,
              randomUUID(),
              cancel,
            );
            rejected(denied, 'COMMENT_NOT_FOUND');
          }
          const page: Roots = await observer.community.comments(
            named.resourceId,
            null,
            cancel,
            { sort: 'time', order: 'asc', limit: 1 },
          );
          applied(
            await author.community.pinComment(
              named.resourceId,
              rootA.resourceId,
              false,
              randomUUID(),
              cancel,
            ),
            'set_comment_pin',
            rootA.resourceId,
            false,
          );
          await assert.rejects(
            observer.community.comments(
              named.resourceId,
              page.nextCursor,
              cancel,
              { sort: 'time', order: 'asc', limit: 1 },
            ),
            clientFailure('business', 409, 'DISCUSSION_RESTART_REQUIRED'),
          );
        },
      );

      await t.test(
        'reply identity overlay is developer-only, audited and cleared on native account replacement',
        async () => {
          const target = {
            kind: 'reply',
            id: replies[1]!.resourceId,
            authorMode: 'anonymous',
          };
          const ordinary: ReplyView = await developer.community.reply(
            target.id,
            cancel,
          );
          const views: OverlayView[] = [];
          const overlay = new IdentityOverlayController(
            developer.sessions,
            developer.privacy,
            systemClock,
            (view: OverlayView) => views.push(view),
          );
          try {
            await overlay.show([target]);
            assert.equal(views.at(-1)!.developerEnabled, true);
            assert.deepEqual(views.at(-1)!.items[target.id], {
              accountId: author.credentials.accountId,
              nickname: 'SyntheticAuthor',
              avatar: null,
              studentNumber,
              studentNumberStatus: 'verified',
            });
            assert.deepEqual(
              await developer.community.reply(target.id, cancel),
              ordinary,
            );
            noPrivateFields(ordinary);
            const audits = await pool.query<{
              target_kind: string;
              target_id: string;
              disclosed_fields: string[];
            }>(
              "SELECT target_kind,target_id,disclosed_fields FROM whaleu_authorization.identity_view_audit WHERE actor_account_id=$1 AND outcome='disclosed'",
              [developer.credentials.accountId],
            );
            assert.deepEqual(audits.rows, [
              {
                target_kind: 'reply',
                target_id: target.id,
                disclosed_fields: ['accountId', 'nickname', 'studentNumber'],
              },
            ]);
            developer.sessions.completeLogin(
              developer.sessions.beginLogin(),
              observer.credentials,
            );
            assert.deepEqual(views.at(-1)!.items, {});
            assert.equal(views.at(-1)!.developerEnabled, false);
          } finally {
            overlay.dispose();
            developer.sessions.completeLogin(
              developer.sessions.beginLogin(),
              developer.credentials,
            );
          }
          for (const actor of [author, other]) {
            await assert.rejects(
              actor.privacy.identities(
                [{ kind: 'reply', id: target.id }],
                cancel,
              ),
              clientFailure('forbidden', 403, 'AUTHORIZATION_REQUIRED'),
            );
            const nondeveloperViews: OverlayView[] = [];
            const hidden = new IdentityOverlayController(
              actor.sessions,
              actor.privacy,
              systemClock,
              (view: OverlayView) => nondeveloperViews.push(view),
            );
            try {
              const before = transport.exchanges.filter(
                (exchange) =>
                  exchange.path === '/v1/identity-privacy/content-identities',
              ).length;
              await hidden.show([target]);
              assert.equal(
                transport.exchanges.filter(
                  (exchange) =>
                    exchange.path === '/v1/identity-privacy/content-identities',
                ).length,
                before,
              );
              assert.ok(
                nondeveloperViews.every(
                  (view) =>
                    !view.developerEnabled &&
                    Object.keys(view.items).length === 0,
                ),
              );
            } finally {
              hidden.dispose();
            }
          }
        },
      );

      await t.test(
        'strict native decoders reject private extensions and relation corruption on real HTTP values',
        async () => {
          const reply: ReplyView = await observer.community.reply(
            replies[1]!.resourceId,
            cancel,
          );
          const root: CommentView = await observer.community.comment(
            rootA.resourceId,
            cancel,
          );
          const context: Context = await observer.community.discussionContext(
            named.resourceId,
            { replyId: reply.id },
            cancel,
          );
          const post: PostView = await observer.community.post(
            named.resourceId,
            cancel,
          );
          for (const decode of [
            () =>
              decodeReply({
                ...reply,
                accountId: author.credentials.accountId,
              }),
            () =>
              decodeReply({
                ...reply,
                target: {
                  ...reply.target,
                  accountId: other.credentials.accountId,
                },
              }),
            () =>
              decodeReply({
                ...reply,
                target: {
                  kind: 'reply',
                  id: replies[0]!.resourceId,
                  status: 'unavailable',
                  author: reply.author,
                },
              }),
            () => decodeReply({ ...reply, replies: [] }),
            () => decodeReply({ ...reply, rootCommentId: reply.id }),
            () => decodeReplies({ items: [reply, reply], nextCursor: null }),
            () =>
              decodeComment({
                ...root,
                replyPreview: {
                  items: [{ ...reply, rootCommentId: rootB.resourceId }],
                  nextCursor: null,
                },
              }),
            () =>
              decodeDiscussionContext({
                ...context,
                reply: { ...reply, postId: anonymous.resourceId },
              }),
            () =>
              decodePost({
                ...post,
                discussionCount: post.discussionCount + 1,
              }),
            () => decodeReceipt({ ...replies[1], target: reply.target }),
          ])
            assert.throws(decode, { kind: 'protocol' });
          const before = (
            await pool.query(
              'SELECT 1 FROM whaleu_community.publication_requests',
            )
          ).rowCount;
          await assert.rejects(
            author.api.request(
              {
                path: `/v1/community/comments/${rootA.resourceId}/replies`,
                method: 'POST',
                authentication: 'required',
                authReplay: 'never',
                successStatus: 201,
                decode: decodeReceipt,
              },
              {
                body: {
                  ...rootBody('Synthetic forbidden identity selector', 'named'),
                  targetReplyId: null,
                  accountId: other.credentials.accountId,
                },
                cancellation: cancel,
              },
            ),
            clientFailure('business', 400, 'BAD_REQUEST'),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.publication_requests',
              )
            ).rowCount,
            before,
          );
        },
      );

      await t.test(
        'blocked authors, deleted targets and deleted roots filter all counts without exposing target metadata',
        async () => {
          await pool.query(
            'INSERT INTO whaleu_community_test.blocks(viewer,author) VALUES ($1,$2)',
            [observer.credentials.accountId, other.credentials.accountId],
          );
          await counts(observer, 2, 3);
          const visible: Replies = await observer.community.replies(
            rootA.resourceId,
            null,
            cancel,
          );
          assert.deepEqual(
            visible.items.map((item) => item.id),
            [
              replies[0]!.resourceId,
              replies[1]!.resourceId,
              replies[3]!.resourceId,
            ],
            'Named blocking cannot identify an anonymous reply from that account',
          );
          assert.equal(visible.items[1]!.target.status, 'available');
          await pool.query(
            'DELETE FROM whaleu_community_test.blocks WHERE viewer=$1',
            [observer.credentials.accountId],
          );
          await Promise.all([
            other.community.deleteReply(replies[0]!.resourceId, cancel),
            other.community.deleteReply(replies[0]!.resourceId, cancel),
          ]);
          await other.community.deleteReply(replies[0]!.resourceId, cancel);
          await counts(observer, 3, 3);
          const child: ReplyView = await observer.community.reply(
            replies[1]!.resourceId,
            cancel,
          );
          assert.deepEqual(child.target, { status: 'unavailable' });
          noPrivateFields(child);
          const deniedBody: ReplyIntent = {
            ...rootBody('Synthetic reply to deleted target', 'named'),
            targetReplyId: replies[0]!.resourceId,
          };
          await approveReply(
            pool,
            observer.credentials.accountId,
            named.resourceId,
            rootA.resourceId,
            deniedBody,
          );
          rejected(
            await observer.community.publishReply(
              rootA.resourceId,
              deniedBody,
              cancel,
            ),
            'REPLY_NOT_FOUND',
          );
          const wrongRoot: ReplyIntent = {
            ...rootBody('Synthetic same-post wrong root target', 'named'),
            targetReplyId: replies[1]!.resourceId,
          };
          await approveReply(
            pool,
            observer.credentials.accountId,
            named.resourceId,
            rootB.resourceId,
            wrongRoot,
          );
          rejected(
            await observer.community.publishReply(
              rootB.resourceId,
              wrongRoot,
              cancel,
            ),
            'REPLY_NOT_FOUND',
          );
          await assert.rejects(
            author.community.deleteReply(replies[2]!.resourceId, cancel),
            clientFailure('http', 404, 'REPLY_NOT_FOUND'),
          );
          applied(
            await author.community.pinComment(
              named.resourceId,
              rootA.resourceId,
              true,
              randomUUID(),
              cancel,
            ),
            'set_comment_pin',
            rootA.resourceId,
            true,
          );
          await author.community.deleteComment(rootA.resourceId, cancel);
          await author.community.deleteComment(rootA.resourceId, cancel);
          await counts(observer, 2, 0);
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.comment_pins WHERE post_id=$1',
                [named.resourceId],
              )
            ).rowCount,
            0,
          );
          for (const operation of [
            () => observer.community.comment(rootA.resourceId, cancel),
            () => observer.community.replies(rootA.resourceId, null, cancel),
            () => observer.community.reply(replies[1]!.resourceId, cancel),
            () =>
              observer.community.discussionContext(
                named.resourceId,
                { replyId: replies[1]!.resourceId },
                cancel,
              ),
          ])
            await assert.rejects(operation(), (error: unknown) => {
              assert.ok(error instanceof ClientError);
              assert.equal(
                (error as { details: { httpStatus: number } }).details
                  .httpStatus,
                404,
              );
              return true;
            });
          rejected(
            await observer.community.discussionLike(
              'reply',
              replies[1]!.resourceId,
              true,
              randomUUID(),
              cancel,
            ),
            'COMMENT_NOT_FOUND',
          );
          assert.deepEqual(
            await author.community.receipt(replies[1]!.requestId, cancel),
            replies[1],
          );
          assert.deepEqual(
            await author.community.publishReply(
              rootA.resourceId,
              replyBodies[1],
              cancel,
            ),
            replies[1],
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_community.replies WHERE root_comment_id=$1',
                [rootA.resourceId],
              )
            ).rowCount,
            4,
            'Root deletion suppresses descendants without destroying their durable history',
          );
        },
      );

      await t.test(
        'parent and account denial gate native reads, actions, overlays and receipt recovery',
        async () => {
          await pool.query(
            'INSERT INTO whaleu_community_test.blocks(viewer,author) VALUES ($1,$2)',
            [observer.credentials.accountId, author.credentials.accountId],
          );
          for (const operation of [
            () => observer.community.comment(rootB.resourceId, cancel),
            () =>
              observer.community.discussionContext(
                named.resourceId,
                { commentId: rootB.resourceId },
                cancel,
              ),
            () => observer.community.comments(named.resourceId, null, cancel),
          ])
            await assert.rejects(
              operation(),
              clientFailure('http', 404, 'POST_NOT_FOUND'),
            );
          rejected(
            await observer.community.discussionLike(
              'comment',
              rootB.resourceId,
              false,
              randomUUID(),
              cancel,
            ),
            'POST_NOT_FOUND',
          );
          await pool.query(
            'DELETE FROM whaleu_community_test.blocks WHERE viewer=$1',
            [observer.credentials.accountId],
          );
          await author.community.deletePost(named.resourceId, cancel);
          await assert.rejects(
            observer.community.comment(rootB.resourceId, cancel),
            clientFailure('http', 404, 'POST_NOT_FOUND'),
          );
          const identity = await developer.privacy.identities(
            [{ kind: 'reply', id: replies[1]!.resourceId }],
            cancel,
          );
          assert.deepEqual(identity, [
            {
              target: { kind: 'reply', id: replies[1]!.resourceId },
              status: 'unavailable',
            },
          ]);
          await pool.query(
            "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
            [author.credentials.accountId],
          );
          await assert.rejects(
            author.community.receipt(replies[1]!.requestId, cancel),
            clientFailure('forbidden', 403, 'ACCOUNT_BLOCKED'),
          );
          await assert.rejects(
            author.community.publishReply(
              rootA.resourceId,
              replyBodies[1],
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
            revoked.community.reply(replies[1]!.resourceId, cancel),
            clientFailure('auth-required', 401, 'SESSION_REVOKED'),
          );
          assert.equal(
            transport.exchanges.length,
            before + 1,
            'Revoked sessions cannot refresh and retry',
          );
          assert.ok(
            transport.exchanges
              .filter((exchange) =>
                /comments|replies|discussion/.test(exchange.path),
              )
              .every((exchange) => exchange.authorized),
          );
        },
      );
    } finally {
      try {
        await app?.close();
      } finally {
        try {
          if (ownsSchemas) {
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
