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
  FormationComponent,
  FormationContacts,
  FormationContactsView,
  FormationReceipt,
  FormationView,
  JoinFormation,
  OwnFormationMembership,
} from '../../src/community/formation/contracts.js';
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
} = require('../../../wechat/src/community/contract.ts');
const {
  PendingFormationJoinStore,
} = require('../../../wechat/src/community/formation-pending.ts');
const {
  decodeFormation,
  decodeFormationComponent,
  decodeFormationJoinIntent,
  decodeFormationContactView,
  decodeFormationReceipt,
  decodeOwnFormationMembership,
} = require('../../../wechat/src/community/formation-contract.ts');
const {
  emptyFormationDraft,
  formationDraftComponent,
} = require('../../../wechat/src/community/formation-draft.ts');
const {
  FormationContactsController,
  FormationController,
} = require('../../../wechat/src/community/formation-controller.ts');

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

/** Local identity evidence is synthetic and never selectable outside this test. */
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
interface OverlayView {
  readonly developerEnabled: boolean;
  readonly items: Readonly<Record<string, PrivateIdentity>>;
}
function created<T extends PublicationReceipt | FormationReceipt>(
  receipt: T,
): Extract<T, { outcome: 'created' }> {
  assert.equal(receipt.outcome, 'created');
  assert.ok(receipt.outcome === 'created');
  assert.ok(Object.isFrozen(receipt), 'Actual native receipt decoder ran');
  return receipt as Extract<T, { outcome: 'created' }>;
}
function rejected(
  receipt: PublicationReceipt | FormationReceipt,
  code: string,
): void {
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
        'wechat',
        'qq',
        'contacts',
        'sessionId',
        'identities',
        'legacy_raw',
        'creation_transaction',
        'publication_transaction',
      ].includes(key),
      `Ordinary DTO contains private field ${key}`,
    );
    noPrivateFields(child);
  }
}
/** Approval binds the normalized complete component, including chosen contacts and consent. */
async function approveFormation(
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
  'real native formation gateway, Nest HTTP and PostgreSQL contract',
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
      WECHAT_APP_SECRET: 'synthetic-local-formation-contract-only',
      AUTH_RATE_LIMIT_KEY: 'fa'.repeat(32),
    });
    const pool = new Pool(poolOptions(config));
    let suite: PoolClient | undefined;
    let locked = false,
      ownsSchemas = false;
    let app: INestApplication | undefined;
    const authorization = new FixtureAuthorization();
    const visibility = new FixtureVisibility();
    const startApp = async (port = 0): Promise<INestApplication> => {
      const module = await Test.createTestingModule({
        imports: [AppModule.register(config)],
      })
        .overrideProvider(IDENTITY_PROVIDER)
        .useValue({
          exchange: async (code: string) => ({
            provider: 'wechat',
            appId: 'synthetic-native-formation',
            subject: code,
          }),
        })
        .overrideProvider(COMMUNITY_AUTHORIZATION)
        .useValue(authorization)
        .overrideProvider(COMMUNITY_VISIBILITY)
        .useValue(visibility)
        .overrideProvider(CONTENT_PUBLICATION_GATE)
        .useValue(new FixtureContent())
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
          credentials,
          sessions,
          auth,
          api,
          community: new HttpCommunityGateway(api),
          privacy: new HttpIdentityPrivacyGateway(api),
        };
      };
      // Independent synthetic accounts; no real identity/provider calls or grants.
      const author = await makeClient('synthetic-formation-author');
      const member = await makeClient('synthetic-formation-member');
      const other = await makeClient('synthetic-formation-other');
      const observer = await makeClient('synthetic-formation-observer');
      const developer = await makeClient('synthetic-formation-developer');
      const region = randomUUID(),
        spaceId = randomUUID();
      await pool.query(
        "INSERT INTO whaleu_campus.operating_regions(id,name,is_active) VALUES($1,'Synthetic Formation Region',true)",
        [region],
      );
      await pool.query(
        "INSERT INTO whaleu_community.spaces(id,kind,name,is_active,operating_region_id) VALUES($1,'regional','Synthetic Formation Space',true,$2)",
        [spaceId, region],
      );
      for (const actor of [author, member, other, observer, developer])
        await grant(
          pool,
          actor.credentials.accountId,
          spaceId,
          verified(region),
        );
      const profileMarker = 'NeverPrefillFromProfile';
      const studentNumber = 'SYNTHETIC-FORM-2026';
      await pool.query(
        'INSERT INTO whaleu_community_test.students(account_id,student_number) VALUES($1,$2)',
        [author.credentials.accountId, studentNumber],
      );
      await pool.query(
        "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,approved_by_account_id,approval_reference) VALUES($1,$2,'developer',$2,'synthetic-fixture-only')",
        [randomUUID(), developer.credentials.accountId],
      );
      await pool.query(
        "INSERT INTO whaleu_profile.profiles(account_id,nickname,bio) VALUES($1,'SyntheticCreator',$2)",
        [author.credentials.accountId, profileMarker],
      );
      const authorContacts: FormationContacts = {
        wechat: 'ChosenCreator🐳',
        qq: '',
        phone: 'PhoneChosenCreator',
      };
      const memberContacts: FormationContacts = {
        wechat: 'ChosenMember🐳',
        qq: 'MemberQQ',
        phone: '',
      };
      const otherContacts: FormationContacts = {
        wechat: 'OtherChosen',
        qq: '',
        phone: 'SyntheticOther',
      };
      const privacyValues = [
        profileMarker,
        studentNumber,
        ...Object.values(authorContacts),
        ...Object.values(memberContacts),
        ...Object.values(otherContacts),
      ].filter(Boolean);
      const assertPrivateValuesAbsent = (value: unknown) => {
        const serialized = JSON.stringify(value);
        for (const privateValue of privacyValues)
          assert.ok(
            !serialized.includes(privateValue),
            'Public boundary must not expose chosen contacts or private profile content',
          );
      };
      transport.checkResponse = (path, _status, body) => {
        if (!path.includes('/community/')) return;
        assert.ok(
          !JSON.stringify(body).includes(author.credentials.accountId),
          'Community responses and errors must never expose the anonymous creator account ID',
        );
        if (_status >= 400 || !path.endsWith('/formation/contacts')) {
          noPrivateFields(body);
          assertPrivateValuesAbsent(body);
        }
      };
      const makeIntent = (
        overrides: Partial<FormationComponent> = {},
        authorMode: 'named' | 'anonymous' = 'named',
      ): PublishPost => ({
        clientRequestId: randomUUID(),
        spaceId,
        category: 'companions',
        authorMode,
        text: '合成组队正文🐳',
        imageAssetIds: [],
        commentsPolicy: 'open',
        component: {
          kind: 'formation',
          capacity: 4,
          theme: '合成组队🐳',
          contacts: authorContacts,
          contactSharing: 'members_v1',
          ...overrides,
        },
      });
      const makeJoin = (
        contacts: FormationContacts = memberContacts,
      ): JoinFormation => ({
        clientRequestId: randomUUID(),
        contacts,
        contactSharing: 'members_v1',
      });
      const publish = async (body: PublishPost) => {
        await approveFormation(pool, author.credentials.accountId, body);
        return created<PublicationReceipt>(
          await author.community.publishPost(body, cancel),
        );
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
      const rawJoin = (postId: string, body: unknown) =>
        member.api.request(
          {
            path: `/v1/community/posts/${postId}/formation/memberships`,
            method: 'POST',
            authentication: 'required',
            authReplay: 'never',
            successStatus: 201,
            decode: decodeFormationReceipt,
          },
          { body, cancellation: cancel },
        );
      const memberRows = async (postId: string) =>
        (
          await pool.query<{
            id: string;
            account_id: string;
            is_creator: boolean;
            wechat: string;
            qq: string;
            phone: string;
            contact_sharing: string;
          }>(
            'SELECT m.id,m.account_id,m.is_creator,m.wechat,m.qq,m.phone,m.contact_sharing FROM whaleu_community.formation_members m JOIN whaleu_community.formations f ON f.id=m.formation_id WHERE f.post_id=$1 ORDER BY m.seat',
            [postId],
          )
        ).rows;
      let normal!: Extract<PublicationReceipt, { outcome: 'created' }>;
      let anonymous!: Extract<PublicationReceipt, { outcome: 'created' }>;
      let single!: Extract<PublicationReceipt, { outcome: 'created' }>;
      let joined!: Extract<FormationReceipt, { outcome: 'created' }>;
      let joinIntent!: JoinFormation;
      let recovered!: Extract<FormationReceipt, { outcome: 'created' }>;
      let recoveryPost!: Extract<PublicationReceipt, { outcome: 'created' }>;
      let recoveryIntent!: JoinFormation;

      await t.test(
        'publication requires explicit consent, complete approval and creator seat; capacity one is immediately full',
        async () => {
          const body = makeIntent();
          assert.ok(body.component?.kind === 'formation');
          const component = body.component;
          const before = (
            await pool.query('SELECT 1 FROM whaleu_community.posts')
          ).rowCount;
          for (const bad of [
            { ...component, contactSharing: undefined },
            { ...component, contactSharing: false },
            { ...component, contacts: { wechat: '', qq: '', phone: '' } },
            { ...component, capacity: 0 },
            { ...component, capacity: 21 },
            { ...component, capacity: '2' },
            {
              ...component,
              contacts: { ...authorContacts, phone: '🐳'.repeat(6) },
            },
            { ...component, accountId: author.credentials.accountId },
          ]) {
            assert.throws(() => decodeFormationComponent(bad), {
              kind: 'protocol',
            });
            await assert.rejects(
              rawPublish({
                ...body,
                clientRequestId: randomUUID(),
                component: bad,
              }),
              clientFailure('business', 400, 'BAD_REQUEST'),
            );
          }
          assert.equal(
            (await pool.query('SELECT 1 FROM whaleu_community.posts')).rowCount,
            before,
          );
          await approve(pool, author.credentials.accountId, body.text);
          rejected(
            await author.community.publishPost(body, cancel),
            'CONTENT_REJECTED',
          );
          await approveFormation(pool, author.credentials.accountId, body);
          rejected(
            await author.community.publishPost(body, cancel),
            'CONTENT_REJECTED',
          );
          const approved = makeIntent();
          await approveFormation(pool, author.credentials.accountId, approved);
          assert.ok(approved.component?.kind === 'formation');
          rejected(
            await author.community.publishPost(
              {
                ...approved,
                clientRequestId: randomUUID(),
                component: { ...approved.component, contacts: otherContacts },
              },
              cancel,
            ),
            'CONTENT_REJECTED',
          );
          normal = await publish(makeIntent());
          single = await publish(makeIntent({ capacity: 1 }));
          anonymous = await publish(makeIntent({ capacity: 3 }, 'anonymous'));
          const view: FormationView = await author.community.formation(
            single.resourceId,
            cancel,
          );
          assert.ok(Object.isFrozen(view));
          assert.equal(view.status, 'full');
          assert.equal(view.capacity, 1);
          assert.equal(view.memberCount, 1);
          assert.equal(view.members.length, 1);
          assert.equal(view.members[0]!.isCreator, true);
          assert.equal(view.members[0]!.viewer.isSelf, true);
          assert.equal(view.viewer.isCreator, true);
          assert.equal(view.viewer.canReadContacts, true);
          assert.equal(view.viewer.canJoin, false);
          const outsider: FormationView = await observer.community.formation(
            single.resourceId,
            cancel,
          );
          assert.equal(outsider.viewer.reason, 'FORMATION_FULL');
          rejected(
            await observer.community.joinFormation(
              single.resourceId,
              makeJoin(otherContacts),
              cancel,
            ),
            'FORMATION_FULL',
          );
          const rows = await memberRows(single.resourceId);
          assert.equal(rows.length, 1);
          assert.equal(rows[0]!.account_id, author.credentials.accountId);
          assert.equal(rows[0]!.is_creator, true);
          assert.equal(rows[0]!.contact_sharing, 'members_v1');
          const own: OwnFormationMembership =
            await author.community.ownFormationMembership(
              single.resourceId,
              cancel,
            );
          assert.deepEqual(own, {
            postId: single.resourceId,
            membershipId: rows[0]!.id,
            joinedAt: view.members[0]!.joinedAt,
            isCreator: true,
          });
          noPrivateFields(own);
        },
      );

      await t.test(
        'anonymous creator stays anonymous in detail, feed, roster and visibility checks; contacts are never profile-prefilled',
        async () => {
          const post: PostView = await observer.community.post(
            anonymous.resourceId,
            cancel,
          );
          assert.equal(post.author.kind, 'anonymous');
          assert.ok(post.component.kind === 'formation');
          const group = post.component.formation;
          assert.deepEqual(group.members[0]!.author, post.author);
          const anonymousPublic = [
            post,
            await observer.community.formation(anonymous.resourceId, cancel),
            await observer.community.feed(
              { spaceId, category: 'companions' },
              cancel,
            ),
          ];
          noPrivateFields(anonymousPublic);
          assertPrivateValuesAbsent(anonymousPublic);
          assert.ok(
            !JSON.stringify(anonymousPublic).includes(
              author.credentials.accountId,
            ),
          );
          for (const subject of visibility.seen.filter(
            (item) => item.authorMode === 'anonymous',
          )) {
            assert.equal(subject.namedAccountId, undefined);
            assert.ok(
              !JSON.stringify(subject).includes(author.credentials.accountId),
            );
          }
          const before = transport.exchanges.length;
          const draft = emptyFormationDraft();
          assert.deepEqual(
            [draft.wechat, draft.qq, draft.phone, draft.contactConsent],
            ['', '', '', false],
          );
          assert.throws(
            () =>
              formationDraftComponent({
                ...draft,
                enabled: true,
                theme: '合成',
                capacity: '2',
              }),
            { kind: 'protocol' },
          );
          const chosen = formationDraftComponent({
            ...draft,
            enabled: true,
            theme: '合成',
            capacity: '2',
            wechat: memberContacts.wechat,
            contactConsent: true,
          });
          assert.deepEqual(chosen.contacts, {
            wechat: memberContacts.wechat,
            qq: '',
            phone: '',
          });
          assert.equal(
            transport.exchanges.length,
            before,
            'Draft creation must not fetch profile contacts',
          );
          const contactView: FormationContactsView =
            await author.community.formationContacts(
              anonymous.resourceId,
              cancel,
            );
          assert.deepEqual(contactView.members[0]!.contacts, authorContacts);
          assert.ok(
            !JSON.stringify(contactView).includes(author.credentials.accountId),
          );
          assert.ok(!JSON.stringify(contactView).includes(profileMarker));
        },
      );

      await t.test(
        'named one-member joins are immutable and need phone/action authority but no invented student or campus gate',
        async () => {
          await grant(pool, member.credentials.accountId, spaceId, {
            ...verified(region),
            studentVerified: false,
            identityRegionId: null,
          });
          joinIntent = makeJoin();
          joined = created<FormationReceipt>(
            await member.community.joinFormation(
              normal.resourceId,
              joinIntent,
              cancel,
            ),
          );
          assert.equal(transport.exchanges.at(-1)!.status, 201);
          assert.equal(joined.operation, 'join_formation');
          const group: FormationView = await member.community.formation(
            normal.resourceId,
            cancel,
          );
          assert.equal(group.memberCount, 2);
          assert.equal(group.members[1]!.author.kind, 'named');
          assert.equal(group.members[1]!.viewer.isSelf, true);
          assert.equal(group.viewer.isMember, true);
          assert.equal(group.viewer.canJoin, false);
          assert.equal(group.viewer.canReadContacts, true);
          assert.equal(group.viewer.reason, 'FORMATION_ALREADY_JOINED');
          const replays: FormationReceipt[] = await Promise.all([
            member.community.joinFormation(
              normal.resourceId,
              joinIntent,
              cancel,
            ),
            member.community.joinFormation(
              normal.resourceId,
              joinIntent,
              cancel,
            ),
          ]);
          assert.deepEqual(replays, [joined, joined]);
          rejected(
            await member.community.joinFormation(
              normal.resourceId,
              makeJoin(otherContacts),
              cancel,
            ),
            'FORMATION_ALREADY_JOINED',
          );
          for (const changed of [{ ...joinIntent, contacts: otherContacts }])
            await assert.rejects(
              member.community.joinFormation(
                normal.resourceId,
                changed,
                cancel,
              ),
              clientFailure('business', 409, 'REQUEST_CONFLICT'),
            );
          await assert.rejects(
            member.community.joinFormation(
              anonymous.resourceId,
              joinIntent,
              cancel,
            ),
            clientFailure('business', 409, 'REQUEST_CONFLICT'),
          );
          const rows = await memberRows(normal.resourceId);
          assert.equal(rows.length, 2);
          assert.equal(rows[1]!.id, joined.resourceId);
          assert.deepEqual(
            { wechat: rows[1]!.wechat, qq: rows[1]!.qq, phone: rows[1]!.phone },
            memberContacts,
          );
          for (const sql of [
            'UPDATE whaleu_community.formation_members SET wechat=$2 WHERE id=$1',
            'DELETE FROM whaleu_community.formation_members WHERE id=$1',
          ])
            await assert.rejects(
              pool.query(
                sql,
                sql.startsWith('UPDATE')
                  ? [joined.resourceId, 'Changed']
                  : [joined.resourceId],
              ),
              { code: '23514' },
            );
          for (const bad of [
            {
              ...joinIntent,
              clientRequestId: randomUUID(),
              contactSharing: undefined,
            },
            {
              ...joinIntent,
              clientRequestId: randomUUID(),
              accountId: other.credentials.accountId,
            },
            {
              ...joinIntent,
              clientRequestId: randomUUID(),
              contacts: { wechat: '', qq: '', phone: '' },
            },
          ]) {
            assert.throws(() => decodeFormationJoinIntent(bad), {
              kind: 'protocol',
            });
            await assert.rejects(
              rawJoin(normal.resourceId, bad),
              clientFailure('business', 400, 'BAD_REQUEST'),
            );
          }
          await assert.rejects(
            other.community.formationReceipt(joined.requestId, cancel),
            clientFailure('http', 404, 'REQUEST_NOT_FOUND'),
          );
          const otherJoin = created<FormationReceipt>(
            await other.community.joinFormation(
              anonymous.resourceId,
              { ...joinIntent, contacts: otherContacts },
              cancel,
            ),
          );
          assert.notEqual(
            otherJoin.resourceId,
            joined.resourceId,
            'Same request UUID is scoped to its owning account',
          );
          assert.deepEqual(
            await member.community.formationReceipt(joined.requestId, cancel),
            joined,
          );
          noPrivateFields([joined, otherJoin]);
        },
      );

      await t.test(
        'concurrent last-seat attempts settle exactly one member and one immutable full receipt',
        async () => {
          const lastSeat = await publish(makeIntent({ capacity: 2 }));
          const intents = [makeJoin(memberContacts), makeJoin(otherContacts)];
          const results: FormationReceipt[] = await Promise.all([
            member.community.joinFormation(
              lastSeat.resourceId,
              intents[0],
              cancel,
            ),
            other.community.joinFormation(
              lastSeat.resourceId,
              intents[1],
              cancel,
            ),
          ]);
          assert.equal(
            results.filter((receipt) => receipt.outcome === 'created').length,
            1,
          );
          assert.equal(
            results.filter((receipt) => receipt.outcome === 'rejected').length,
            1,
          );
          const rejectedIndex = results.findIndex(
            (receipt) => receipt.outcome === 'rejected',
          );
          rejected(results[rejectedIndex]!, 'FORMATION_FULL');
          const loser = [member, other][rejectedIndex]!;
          assert.deepEqual(
            await loser.community.joinFormation(
              lastSeat.resourceId,
              intents[rejectedIndex],
              cancel,
            ),
            results[rejectedIndex],
          );
          assert.deepEqual(
            await loser.community.formationReceipt(
              intents[rejectedIndex]!.clientRequestId,
              cancel,
            ),
            results[rejectedIndex],
          );
          assert.equal((await memberRows(lastSeat.resourceId)).length, 2);
          const full: FormationView = await observer.community.formation(
            lastSeat.resourceId,
            cancel,
          );
          assert.equal(full.status, 'full');
          assert.equal(full.memberCount, 2);
          assert.equal(
            full.members.filter((entry) => entry.isCreator).length,
            1,
          );
        },
      );

      await t.test(
        'lost committed join survives native journal reload plus real server restart without a new key or duplicate member',
        async () => {
          recoveryPost = await publish(makeIntent({ capacity: 2 }));
          recoveryIntent = makeJoin();
          const values = new Map<string, unknown>();
          const storage = {
            get: (key: string) => values.get(key),
            set: (key: string, value: unknown) => {
              values.set(key, structuredClone(value));
            },
            remove: (key: string) => {
              values.delete(key);
            },
          };
          const journal = new PendingFormationJoinStore(storage, nativeOrigin);
          const attempt = journal.freeze({
            version: 1,
            accountId: member.credentials.accountId,
            postId: recoveryPost.resourceId,
            payload: recoveryIntent,
          });
          assert.equal(journal.load(other.credentials.accountId), null);
          assert.throws(
            () =>
              journal.freeze({ ...attempt, payload: makeJoin(otherContacts) }),
            { kind: 'storage' },
          );
          transport.dropSuccess = {
            path: `/v1/community/posts/${recoveryPost.resourceId}/formation/memberships`,
            method: 'POST',
          };
          await assert.rejects(
            member.community.joinFormation(
              recoveryPost.resourceId,
              recoveryIntent,
              cancel,
            ),
            { kind: 'network' },
          );
          assert.equal(transport.exchanges.at(-1)!.status, 201);
          assert.equal(
            (await memberRows(recoveryPost.resourceId)).length,
            2,
            'Response loss happens only after the real transaction commits',
          );
          assert.deepEqual(journal.load(member.credentials.accountId), attempt);
          await app!.close();
          app = undefined;
          app = await startApp(port);
          const restored = await makeClient(
            'unused-restored-formation-member',
            member.credentials,
          );
          const reloaded = new PendingFormationJoinStore(storage, nativeOrigin);
          assert.deepEqual(
            reloaded.load(member.credentials.accountId),
            attempt,
          );
          const before = transport.exchanges.length;
          recovered = created<FormationReceipt>(
            await restored.community.formationReceipt(
              recoveryIntent.clientRequestId,
              cancel,
            ),
          );
          const own: OwnFormationMembership =
            await restored.community.ownFormationMembership(
              recoveryPost.resourceId,
              cancel,
            );
          assert.equal(own.membershipId, recovered.resourceId);
          assert.equal(own.isCreator, false);
          assert.deepEqual(
            transport.exchanges
              .slice(before)
              .map((exchange) => exchange.method),
            ['GET', 'GET'],
            'Restart recovery reads durable acknowledgments without mutating',
          );
          assert.deepEqual(reloaded.settle(attempt, recovered), recovered);
          assert.equal(reloaded.load(member.credentials.accountId), null);
          assert.deepEqual(
            await restored.community.joinFormation(
              recoveryPost.resourceId,
              recoveryIntent,
              cancel,
            ),
            recovered,
          );
          assert.equal((await memberRows(recoveryPost.resourceId)).length, 2);
          noPrivateFields([recovered, own]);
        },
      );

      await t.test(
        'contacts require membership and fresh phone, parent and named-member visibility on every reveal and copy',
        async () => {
          await assert.rejects(
            observer.community.formationContacts(normal.resourceId, cancel),
            clientFailure('forbidden', 403, 'FORMATION_MEMBERSHIP_REQUIRED'),
          );
          await assert.rejects(
            observer.community.ownFormationMembership(
              normal.resourceId,
              cancel,
            ),
            clientFailure('http', 404, 'FORMATION_MEMBERSHIP_NOT_FOUND'),
          );
          await assert.rejects(
            observer.api.request(
              {
                path: `/v1/community/posts/${normal.resourceId}/formation/contacts`,
                method: 'GET',
                authentication: 'none',
                authReplay: 'never',
                successStatus: 200,
                decode: decodeFormationContactView,
              },
              { cancellation: cancel },
            ),
            clientFailure('auth-required', 401, 'AUTHENTICATION_REQUIRED'),
          );
          const otherMember = created<FormationReceipt>(
            await other.community.joinFormation(
              normal.resourceId,
              makeJoin(otherContacts),
              cancel,
            ),
          );
          const rows: {
            rows: { membershipId: string; contacts: FormationContacts }[];
            open: boolean;
          }[] = [];
          const copied: string[] = [];
          const contactController = new FormationContactsController(
            { sessions: member.sessions, gateway: member.community },
            (view: {
              rows: { membershipId: string; contacts: FormationContacts }[];
              open: boolean;
            }) => rows.push(view),
            async (text: string) => {
              copied.push(text);
            },
          );
          t.after(() => contactController.dispose());
          contactController.load(
            await member.community.post(normal.resourceId, cancel),
          );
          await contactController.reveal();
          assert.equal(rows.at(-1)!.rows.length, 3);
          const creatorId = (await memberRows(normal.resourceId))[0]!.id;
          assert.deepEqual(
            rows.at(-1)!.rows.find((row) => row.membershipId === creatorId)!
              .contacts,
            authorContacts,
          );
          await contactController.copy(otherMember.resourceId, 'wechat');
          assert.deepEqual(copied, [otherContacts.wechat]);
          await pool.query(
            'INSERT INTO whaleu_community_test.blocks(viewer,author) VALUES($1,$2)',
            [member.credentials.accountId, other.credentials.accountId],
          );
          const filtered: FormationView = await member.community.formation(
            normal.resourceId,
            cancel,
          );
          assert.equal(
            filtered.memberCount,
            3,
            'Filtered members still occupy their immutable seats',
          );
          assert.equal(filtered.members.length, 2);
          assert.ok(
            !filtered.members.some(
              (entry) => entry.id === otherMember.resourceId,
            ),
          );
          const filteredContacts: FormationContactsView =
            await member.community.formationContacts(normal.resourceId, cancel);
          assert.equal(filteredContacts.members.length, 2);
          assert.ok(
            !filteredContacts.members.some(
              (entry) => entry.membershipId === otherMember.resourceId,
            ),
          );
          await contactController.copy(otherMember.resourceId, 'wechat');
          assert.deepEqual(
            copied,
            [otherContacts.wechat],
            'Copy must not reuse a contact after its named member becomes blocked',
          );
          assert.deepEqual(rows.at(-1)!.rows, []);
          await pool.query(
            'DELETE FROM whaleu_community_test.blocks WHERE viewer=$1 AND author=$2',
            [member.credentials.accountId, other.credentials.accountId],
          );
          await contactController.reveal();
          assert.equal(rows.at(-1)!.rows.length, 3);
          await grant(pool, member.credentials.accountId, spaceId, {
            ...verified(region),
            phoneVerified: false,
          });
          await assert.rejects(
            member.community.formationContacts(normal.resourceId, cancel),
            clientFailure(
              'phone-verification-required',
              403,
              'PHONE_VERIFICATION_REQUIRED',
            ),
          );
          await contactController.copy(creatorId, 'wechat');
          assert.deepEqual(
            copied,
            [otherContacts.wechat],
            'Cached contacts cannot substitute for a fresh phone proof',
          );
          assert.deepEqual(rows.at(-1)!.rows, []);
          await grant(pool, member.credentials.accountId, spaceId, {
            ...verified(region),
            studentVerified: false,
            identityRegionId: null,
          });
          await contactController.reveal();
          assert.equal(
            rows.at(-1)!.rows.length,
            3,
            'No new student gate for already-authorized member contacts',
          );
          await grant(pool, member.credentials.accountId, spaceId, {
            ...verified(region),
            restrictedActions: ['read_formation_contacts'],
          });
          await assert.rejects(
            member.community.formationContacts(normal.resourceId, cancel),
            clientFailure('forbidden', 403, 'COMMUNITY_ACTION_RESTRICTED'),
          );
          await contactController.copy(creatorId, 'wechat');
          assert.deepEqual(copied, [otherContacts.wechat]);
          assert.deepEqual(rows.at(-1)!.rows, []);
          await grant(
            pool,
            member.credentials.accountId,
            spaceId,
            verified(region),
          );
          await pool.query(
            'INSERT INTO whaleu_community_test.blocks(viewer,author) VALUES($1,$2)',
            [member.credentials.accountId, author.credentials.accountId],
          );
          await assert.rejects(
            member.community.formationContacts(normal.resourceId, cancel),
            clientFailure('http', 404, 'POST_NOT_FOUND'),
          );
          await contactController.copy(creatorId, 'wechat');
          assert.deepEqual(copied, [otherContacts.wechat]);
          assert.deepEqual(rows.at(-1)!.rows, []);
          assert.equal(rows.at(-1)!.open, false);
          await pool.query(
            'DELETE FROM whaleu_community_test.blocks WHERE viewer=$1 AND author=$2',
            [member.credentials.accountId, author.credentials.accountId],
          );
          // Anonymous parent visibility receives only the persona subject, never an underlying actor.
          await pool.query(
            'INSERT INTO whaleu_community_test.blocks(viewer,author) VALUES($1,$2)',
            [other.credentials.accountId, author.credentials.accountId],
          );
          const anonymousContacts: FormationContactsView =
            await other.community.formationContacts(
              anonymous.resourceId,
              cancel,
            );
          assert.equal(anonymousContacts.members.length, 2);
          assert.deepEqual(
            anonymousContacts.members[0]!.contacts,
            authorContacts,
          );
          assert.ok(
            !JSON.stringify(anonymousContacts).includes(
              author.credentials.accountId,
            ),
          );
          await pool.query(
            'DELETE FROM whaleu_community_test.blocks WHERE viewer=$1 AND author=$2',
            [other.credentials.accountId, author.credentials.accountId],
          );
          await grant(pool, observer.credentials.accountId, spaceId, {
            ...verified(region),
            phoneVerified: false,
          });
          const deniedIntent = makeJoin(otherContacts);
          const denied: FormationReceipt =
            await observer.community.joinFormation(
              normal.resourceId,
              deniedIntent,
              cancel,
            );
          rejected(denied, 'PHONE_VERIFICATION_REQUIRED');
          await grant(
            pool,
            observer.credentials.accountId,
            spaceId,
            verified(region),
          );
          assert.deepEqual(
            await observer.community.joinFormation(
              normal.resourceId,
              deniedIntent,
              cancel,
            ),
            denied,
            'Later phone proof cannot change a terminal receipt',
          );
          assert.equal((await memberRows(normal.resourceId)).length, 3);
          assert.ok(
            !transport.exchanges.some(
              (exchange) => exchange.path === '/v1/me/profile',
            ),
            'Formation draft/contact flow never consults profile fields',
          );
          contactController.dispose();
        },
      );

      await t.test(
        'hidden or deleted parents deny new reads and joins while minimal native receipt and membership recovery stays durable',
        async () => {
          await pool.query(
            "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
            [recoveryPost.resourceId],
          );
          for (const actor of [author, member, observer]) {
            for (const read of [
              () => actor.community.post(recoveryPost.resourceId, cancel),
              () => actor.community.formation(recoveryPost.resourceId, cancel),
              () =>
                actor.community.formationContacts(
                  recoveryPost.resourceId,
                  cancel,
                ),
            ])
              await assert.rejects(
                read(),
                clientFailure('http', 404, 'POST_NOT_FOUND'),
              );
          }
          const hidden: FormationReceipt =
            await observer.community.joinFormation(
              recoveryPost.resourceId,
              makeJoin(otherContacts),
              cancel,
            );
          rejected(hidden, 'POST_NOT_FOUND');
          assert.deepEqual(
            await member.community.joinFormation(
              recoveryPost.resourceId,
              recoveryIntent,
              cancel,
            ),
            recovered,
          );
          const values = new Map<string, unknown>();
          const storage = {
            get: (key: string) => values.get(key),
            set: (key: string, value: unknown) => {
              values.set(key, structuredClone(value));
            },
            remove: (key: string) => {
              values.delete(key);
            },
          };
          const journal = new PendingFormationJoinStore(storage, nativeOrigin);
          journal.freeze({
            version: 1,
            accountId: member.credentials.accountId,
            postId: recoveryPost.resourceId,
            payload: recoveryIntent,
          });
          const views: {
            contacts: FormationContacts;
            formation: unknown;
            frozen: boolean;
            canJoin: boolean;
            ownStatus: string;
          }[] = [];
          const recoveryController = new FormationController(
            {
              sessions: member.sessions,
              gateway: member.community,
              pendingFormations: journal,
              newRequestId: () => {
                throw new Error('Recovery must never create a replacement key');
              },
            },
            recoveryPost.resourceId,
            (view: {
              contacts: FormationContacts;
              formation: unknown;
              frozen: boolean;
              canJoin: boolean;
              ownStatus: string;
            }) => views.push(view),
          );
          t.after(() => recoveryController.dispose());
          const before = transport.exchanges.length;
          await recoveryController.load(null);
          assert.equal(views.at(-1)!.frozen, true);
          assert.deepEqual(views.at(-1)!.contacts, {
            wechat: '',
            qq: '',
            phone: '',
          });
          await recoveryController.inspectOwnMembership();
          assert.ok(views.at(-1)!.ownStatus);
          assert.equal(
            views.at(-1)!.frozen,
            true,
            'Membership lookup cannot replace the original request receipt',
          );
          await recoveryController.recover();
          assert.equal(views.at(-1)!.frozen, false);
          assert.equal(views.at(-1)!.formation, null);
          assert.equal(views.at(-1)!.canJoin, false);
          assert.deepEqual(views.at(-1)!.contacts, {
            wechat: '',
            qq: '',
            phone: '',
          });
          assert.equal(journal.load(member.credentials.accountId), null);
          assert.deepEqual(
            transport.exchanges
              .slice(before)
              .map((exchange) => [exchange.method, exchange.path]),
            [
              [
                'GET',
                `/v1/me/community/formation-memberships/${recoveryPost.resourceId}`,
              ],
              [
                'GET',
                `/v1/me/community/formation-requests/${recoveryIntent.clientRequestId}`,
              ],
            ],
            'Recovery after visibility loss fetches no parent, roster, contact or mutation',
          );
          recoveryController.dispose();
          const hiddenFeed: { items: PostView[] } =
            await observer.community.feed(
              { spaceId, category: 'companions' },
              cancel,
            );
          assert.ok(
            !hiddenFeed.items.some(
              (post) => post.id === recoveryPost.resourceId,
            ),
          );
          await pool.query(
            "UPDATE whaleu_community.posts SET visibility='approved' WHERE id=$1",
            [recoveryPost.resourceId],
          );
          await author.community.deletePost(recoveryPost.resourceId, cancel);
          for (const actor of [author, member])
            await assert.rejects(
              actor.community.formationContacts(
                recoveryPost.resourceId,
                cancel,
              ),
              clientFailure('http', 404, 'POST_NOT_FOUND'),
            );
          rejected(
            await observer.community.joinFormation(
              recoveryPost.resourceId,
              makeJoin(otherContacts),
              cancel,
            ),
            'POST_NOT_FOUND',
          );
          assert.deepEqual(
            await member.community.formationReceipt(
              recovered.requestId,
              cancel,
            ),
            recovered,
          );
          assert.deepEqual(
            await member.community.joinFormation(
              recoveryPost.resourceId,
              recoveryIntent,
              cancel,
            ),
            recovered,
          );
          const own: OwnFormationMembership =
            await member.community.ownFormationMembership(
              recoveryPost.resourceId,
              cancel,
            );
          assert.deepEqual(own, {
            postId: recoveryPost.resourceId,
            membershipId: recovered.resourceId,
            joinedAt: recovered.createdAt,
            isCreator: false,
          });
          assert.deepEqual(
            await author.community.receipt(recoveryPost.requestId, cancel),
            recoveryPost,
          );
          assert.equal((await memberRows(recoveryPost.resourceId)).length, 2);
          await assert.rejects(
            observer.community.ownFormationMembership(
              recoveryPost.resourceId,
              cancel,
            ),
            clientFailure('http', 404, 'FORMATION_MEMBERSHIP_NOT_FOUND'),
          );
          noPrivateFields([own, recovered, hidden]);
        },
      );

      await t.test(
        'formation member developer overlay is separately authorized, audited and never grants group contacts',
        async () => {
          const ordinary: PostView = await developer.community.post(
            anonymous.resourceId,
            cancel,
          );
          assert.ok(ordinary.component.kind === 'formation');
          const roster = ordinary.component.formation;
          const creator = roster.members.find((entry) => entry.isCreator)!;
          const namedMember = roster.members.find((entry) => !entry.isCreator)!;
          assert.equal(creator.author.kind, 'anonymous');
          assert.deepEqual(creator.author, ordinary.author);
          assert.equal(namedMember.author.kind, 'named');
          assert.equal(roster.viewer.isMember, false);
          assert.equal(roster.viewer.canReadContacts, false);
          noPrivateFields(ordinary);
          assertPrivateValuesAbsent(ordinary);
          assert.ok(
            !JSON.stringify(ordinary).includes(author.credentials.accountId),
          );
          const targets = [
            {
              kind: 'formation_member',
              id: creator.id,
              authorMode: 'anonymous',
            },
            {
              kind: 'formation_member',
              id: namedMember.id,
              authorMode: 'named',
            },
          ];
          const views: OverlayView[] = [];
          const overlay = new IdentityOverlayController(
            developer.sessions,
            developer.privacy,
            systemClock,
            (view: OverlayView) => views.push(view),
          );
          try {
            await overlay.show(targets);
            assert.equal(views.at(-1)!.developerEnabled, true);
            assert.deepEqual(views.at(-1)!.items[creator.id], {
              accountId: author.credentials.accountId,
              nickname: 'SyntheticCreator',
              avatar: null,
              studentNumber,
              studentNumberStatus: 'verified',
            });
            assert.deepEqual(views.at(-1)!.items[namedMember.id], {
              accountId: other.credentials.accountId,
              nickname: null,
              avatar: null,
              studentNumber: null,
              studentNumberStatus: 'unverified',
            });
            for (const contact of [
              ...Object.values(authorContacts),
              ...Object.values(otherContacts),
            ].filter(Boolean))
              assert.ok(
                !JSON.stringify(views.at(-1)!.items).includes(contact),
                'Privileged identity view does not disclose membership contacts',
              );
            assert.deepEqual(
              await developer.community.post(anonymous.resourceId, cancel),
              ordinary,
              'Privileged overlay never extends ordinary roster DTOs',
            );
            const audits = await pool.query<{
              target_kind: string;
              target_id: string;
              disclosed_fields: string[];
            }>(
              "SELECT target_kind,target_id,disclosed_fields FROM whaleu_authorization.identity_view_audit WHERE actor_account_id=$1 AND outcome='disclosed' ORDER BY target_id",
              [developer.credentials.accountId],
            );
            assert.deepEqual(
              audits.rows,
              [
                {
                  target_kind: 'formation_member',
                  target_id: creator.id,
                  disclosed_fields: ['accountId', 'nickname', 'studentNumber'],
                },
                {
                  target_kind: 'formation_member',
                  target_id: namedMember.id,
                  disclosed_fields: ['accountId'],
                },
              ].sort((a, b) => a.target_id.localeCompare(b.target_id)),
            );
            await assert.rejects(
              developer.community.formationContacts(
                anonymous.resourceId,
                cancel,
              ),
              clientFailure('forbidden', 403, 'FORMATION_MEMBERSHIP_REQUIRED'),
            );
            await assert.rejects(
              observer.privacy.identities(
                [{ kind: 'formation_member', id: creator.id }],
                cancel,
              ),
              clientFailure('forbidden', 403, 'AUTHORIZATION_REQUIRED'),
            );
            developer.sessions.completeLogin(
              developer.sessions.beginLogin(),
              observer.credentials,
            );
            assert.deepEqual(views.at(-1)!.items, {});
            assert.equal(views.at(-1)!.developerEnabled, false);
            developer.sessions.completeLogin(
              developer.sessions.beginLogin(),
              developer.credentials,
            );
            await pool.query(
              'INSERT INTO whaleu_community_test.blocks(viewer,author) VALUES($1,$2)',
              [developer.credentials.accountId, other.credentials.accountId],
            );
            assert.deepEqual(
              await developer.privacy.identities(
                [{ kind: 'formation_member', id: namedMember.id }],
                cancel,
              ),
              [
                {
                  target: { kind: 'formation_member', id: namedMember.id },
                  status: 'unavailable',
                },
              ],
            );
            await pool.query(
              'DELETE FROM whaleu_community_test.blocks WHERE viewer=$1 AND author=$2',
              [developer.credentials.accountId, other.credentials.accountId],
            );
            await pool.query(
              "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
              [anonymous.resourceId],
            );
            assert.deepEqual(
              await developer.privacy.identities(
                [{ kind: 'formation_member', id: creator.id }],
                cancel,
              ),
              [
                {
                  target: { kind: 'formation_member', id: creator.id },
                  status: 'unavailable',
                },
              ],
            );
            await pool.query(
              "UPDATE whaleu_community.posts SET visibility='approved' WHERE id=$1",
              [anonymous.resourceId],
            );
          } finally {
            overlay.dispose();
            developer.sessions.completeLogin(
              developer.sessions.beginLogin(),
              developer.credentials,
            );
          }
        },
      );

      await t.test(
        'strict native decoders reject contact/identity leakage and malformed relations; receipts and outbox stay minimal',
        async () => {
          const post: PostView = await observer.community.post(
            anonymous.resourceId,
            cancel,
          );
          assert.ok(post.component.kind === 'formation');
          const group = post.component.formation;
          const own: OwnFormationMembership =
            await author.community.ownFormationMembership(
              anonymous.resourceId,
              cancel,
            );
          const contactView: FormationContactsView =
            await author.community.formationContacts(
              anonymous.resourceId,
              cancel,
            );
          const anonymousCreator = group.members[0]!;
          assert.ok(anonymousCreator.author.kind === 'anonymous');
          const namedPost: PostView = await observer.community.post(
            normal.resourceId,
            cancel,
          );
          assert.ok(namedPost.author.kind === 'named');
          const trueProfileId = namedPost.author.profileId;
          for (const value of [post, group, contactView]) {
            assert.ok(
              !JSON.stringify(value).includes(author.credentials.accountId),
            );
            assert.ok(
              !JSON.stringify(value).includes(trueProfileId),
              'Anonymous creator must not expose their true public profile ID',
            );
          }
          for (const decode of [
            () => decodePost({ ...post, contacts: authorContacts }),
            () =>
              decodePost({
                ...post,
                component: {
                  kind: 'formation',
                  formation: { ...group, contacts: authorContacts },
                },
              }),
            () =>
              decodeFormation({
                ...group,
                accountId: author.credentials.accountId,
              }),
            () =>
              decodeFormation({ ...group, capacity: String(group.capacity) }),
            () =>
              decodeFormation({ ...group, memberCount: group.capacity + 1 }),
            () =>
              decodeFormation({
                ...group,
                members: [
                  {
                    ...anonymousCreator,
                    author: {
                      ...anonymousCreator.author,
                      profileId: trueProfileId,
                    },
                  },
                ],
              }),
            () =>
              decodeFormation({
                ...group,
                members: [{ ...anonymousCreator, isCreator: false }],
              }),
            () =>
              decodeFormation({
                ...group,
                members: [anonymousCreator, anonymousCreator],
              }),
            () =>
              decodeFormation({
                ...group,
                viewer: {
                  ...group.viewer,
                  isMember: false,
                  canReadContacts: true,
                },
              }),
            () =>
              decodeFormationReceipt({ ...joined, contacts: memberContacts }),
            () =>
              decodeFormationReceipt({
                ...joined,
                accountId: member.credentials.accountId,
              }),
            () =>
              decodeOwnFormationMembership({
                ...own,
                contacts: authorContacts,
              }),
            () =>
              decodeFormationContactView({
                ...contactView,
                members: [
                  {
                    ...contactView.members[0],
                    accountId: author.credentials.accountId,
                  },
                ],
              }),
            () =>
              decodePostIntent({
                ...makeIntent(),
                component: {
                  kind: 'formation',
                  capacity: 2,
                  theme: '合成',
                  contacts: authorContacts,
                  contactSharing: 'implicit',
                },
              }),
          ])
            assert.throws(decode, { kind: 'protocol' });
          const receipts = await pool.query<{ receipt: unknown }>(
            'SELECT receipt FROM whaleu_community.formation_requests',
          );
          const events = await pool.query<{
            event_type: string;
            resource_id: string;
            context: unknown;
          }>(
            'SELECT event_type,resource_id,context FROM whaleu_community.outbox',
          );
          noPrivateFields([receipts.rows, events.rows]);
          assertPrivateValuesAbsent([receipts.rows, events.rows]);
          assert.ok(
            !JSON.stringify([receipts.rows, events.rows]).includes(
              author.credentials.accountId,
            ),
          );
          assert.ok(!JSON.stringify(events.rows).includes(trueProfileId));
          const membershipIds = (
            await pool.query<{ id: string }>(
              'SELECT id FROM whaleu_community.formation_members WHERE NOT is_creator',
            )
          ).rows
            .map((row) => row.id)
            .sort();
          assert.deepEqual(
            events.rows
              .filter((event) => event.event_type === 'formation_member_joined')
              .map((event) => event.resource_id)
              .sort(),
            membershipIds,
            'Exactly one contact-free event per noncreator membership, including lost-response/replayed joins',
          );
        },
      );

      await t.test(
        'minimal recovery still rejects blocked accounts and revoked sessions without automatic replay',
        async () => {
          await pool.query(
            "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
            [member.credentials.accountId],
          );
          for (const read of [
            () => member.community.formationReceipt(joined.requestId, cancel),
            () =>
              member.community.ownFormationMembership(
                normal.resourceId,
                cancel,
              ),
            () => member.community.formationContacts(normal.resourceId, cancel),
          ])
            await assert.rejects(
              read(),
              clientFailure('forbidden', 403, 'ACCOUNT_BLOCKED'),
            );
          await observer.auth.logout();
          const revoked = await makeClient(
            'unused-revoked-formation-observer',
            observer.credentials,
          );
          const before = transport.exchanges.length;
          await assert.rejects(
            revoked.community.formation(normal.resourceId, cancel),
            clientFailure('auth-required', 401, 'SESSION_REVOKED'),
          );
          assert.equal(
            transport.exchanges.length,
            before + 1,
            'Revoked sessions do not refresh or replay',
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
