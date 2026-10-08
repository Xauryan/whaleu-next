import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import { NestFactory, ModulesContainer } from '@nestjs/core';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.js';
import {
  inTransaction,
  poolOptions,
  supportedPostgresVersion,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { configureHttp } from '../../src/http/http.js';
import type {
  PublishPost,
  PublishComment,
  AuthorView,
} from '../../src/community/contracts.js';
import type { PublishReply } from '../../src/community/discussion/contracts.js';
import type { SessionCredentials } from '../../src/identity/contracts.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { mintToken, hashToken } from '../../src/identity/tokens.js';
import { initializeNativeSafetyAccount } from '../../src/safety/lifecycle.js';
import { ExperiencePublicDisplayFacade } from '../../src/experience/public-display.facade.js';
import type { PublicExperienceDisplay } from '../../src/experience/public-display.contract.js';
import { ExperienceRepository } from '../../src/experience/repository.js';
import { ExperienceWorker } from '../../src/experience/worker.js';
import { ExperienceDispatcher } from '../../src/experience/dispatcher.js';
import {
  ExperienceIngressService,
  lockExperienceOwner,
} from '../../src/experience/ingress.js';
import { UpdatesWorker } from '../../src/notifications/worker.js';
import { titles } from '../../src/experience/catalog.js';
import {
  createRuntimeActor,
  setRuntimeVerification,
  postApprovalEnvelope,
  discussionApprovalEnvelope,
} from '../support/community-runtime-fixtures.js';
import {
  seedCommunityScope,
  appendIdentitySelection,
} from '../support/community-scope-fixtures.js';
import {
  seedReviewPolicy,
  approveEnvelope,
} from '../support/community-approval-fixtures.js';
import {
  establishSyntheticExperienceBaseline,
  grantSyntheticTitle,
} from '../support/experience-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';
import {
  NativeExperienceTransport,
  nativeOrigin,
  platformStorage,
  memoryStorage,
  protocolFailure,
  serverFailure,
} from '../support/experience-native-bridge.js';

// Ordinary application composition and all canonical source/policy providers.
// The only bridge replaces native device transport/storage, never authority.
const require = createRequire(import.meta.url);
const { ApiClient } = require('../../../wechat/src/api/client.ts');
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
  HttpDiscoveryGateway,
} = require('../../../wechat/src/profile/discovery-gateway.ts');
const {
  HttpProfileGateway,
} = require('../../../wechat/src/profile/gateway.ts');
const {
  HttpBlockGateway,
} = require('../../../wechat/src/community/block-gateway.ts');
const {
  HttpExperienceGateway,
} = require('../../../wechat/src/experience/gateway.ts');
const {
  createExperienceRuntime,
} = require('../../../wechat/src/experience/runtime.ts');
const {
  createCommunityRuntime,
} = require('../../../wechat/src/community/runtime.ts');
const {
  PublicProfileController,
  initialPublicProfileView,
} = require('../../../wechat/src/pages/public-profile/controller.ts');
const { decodeAuthor } = require('../../../wechat/src/community/contract.ts');
const {
  authorProfilePath,
} = require('../../../wechat/src/profile/author-navigation.ts');

const unavailable = { status: 'unavailable', value: null } as const;
const known = <T>(value: T) => ({ status: 'known' as const, value });
const display = (
  titleKey: string | null,
  color: number | null,
  level: number | null,
): PublicExperienceDisplay => ({
  title: known(
    titleKey === null
      ? null
      : { key: titleKey, name: titles.find((t) => t.key === titleKey)!.name },
  ),
  color: known(color),
  level: level === null ? unavailable : known(level),
});
const absent: PublicExperienceDisplay = {
  title: unavailable,
  color: unavailable,
  level: unavailable,
};
function exact(value: object, keys: string[]) {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
}
function exactAuthor(author: AuthorView, expected?: PublicExperienceDisplay) {
  if (author.kind === 'anonymous') {
    exact(author, [
      'kind',
      'personaId',
      'displayName',
      'avatar',
      'isPostAuthor',
    ]);
    assert.equal(authorProfilePath(author), null);
  } else {
    exact(author, [
      'kind',
      'profileId',
      'displayName',
      'avatar',
      'experienceDisplay',
    ]);
    exact(author.experienceDisplay, ['title', 'color', 'level']);
    for (const item of Object.values(author.experienceDisplay))
      exact(item, ['status', 'value']);
    if (author.experienceDisplay.title.value)
      exact(author.experienceDisplay.title.value, ['key', 'name']);
    if (expected) assert.deepEqual(author.experienceDisplay, expected);
    assert.ok(authorProfilePath(author));
  }
  assert.deepEqual(decodeAuthor(author), author);
}
function noPrivate(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(
      ![
        'accountId',
        'account_id',
        'ownerId',
        'owner_id',
        'beneficiaryId',
        'sourceId',
        'source_id',
        'providerSubject',
        'accessToken',
        'refreshToken',
        'openid',
        'unionid',
        'earnedAt',
        'earned_at',
        'recordedAt',
        'recorded_at',
        'balance',
        'balanceAfter',
        'baseline',
        'entitlements',
        'stateRevision',
        'coverage',
        'signIn',
        'pending',
        'appearanceRevision',
      ].includes(key),
      `Public response leaked ${key}`,
    );
    if (key === 'author') exactAuthor(child as AuthorView);
    noPrivate(child);
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Bounded public read failed: ${label}`)),
          2000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test(
  'public experience: real AppModule/native wire, privacy, independent evidence and nonlocking snapshots',
  { timeout: 180000 },
  async (t) => {
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(
      database,
      'Use disposable loopback whaleu_test; never silently skip',
    );
    const url = new URL(database);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: database,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '20',
      EXPERIENCE_PROCESSING: 'manual_only',
      COMMUNITY_UPDATES_PROCESSING: 'manual_only',
    });
    const pool = new Pool(poolOptions(config));
    let suite: PoolClient | undefined,
      app: INestApplication | undefined,
      locked = false,
      owns = false;
    const oldOwners = [randomUUID(), randomUUID()];
    const oldSubjects = [randomUUID(), randomUUID()];
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert.equal(locked, true, 'Run disposable suites serially');
      assert.ok(
        supportedPostgresVersion(
          (
            await pool.query<{ v: number }>(
              "SELECT current_setting('server_version_num')::integer v",
            )
          ).rows[0]!.v,
        ),
      );
      assert.equal(
        (
          await pool.query<{ n: number }>(
            "SELECT count(*)::integer n FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
          )
        ).rows[0]!.n,
        0,
        'Refuse existing application schemas',
      );
      owns = true;
      const migrations = await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      );
      await runMigrations(
        pool,
        migrations.filter((m) => m.name < '0022_'),
        { mode: 'up' },
      );
      for (let i = 0; i < oldOwners.length; i++)
        await inTransaction(pool, async (tx) => {
          await tx.query(
            'INSERT INTO whaleu_identity.accounts(id) VALUES($1)',
            [oldOwners[i]],
          );
          await initializeNativeSafetyAccount(oldOwners[i]!, tx);
          await tx.query(
            "INSERT INTO whaleu_identity.provider_identities(provider,app_id,subject,account_id) VALUES('wechat','synthetic-public-display-only',$1,$2)",
            [oldSubjects[i], oldOwners[i]],
          );
        });
      await runMigrations(pool, migrations, { mode: 'up' });
      app = await NestFactory.create(AppModule.register(config), {
        logger: false,
      });
      configureHttp(app);
      await app.listen(0, '127.0.0.1');
      const transport = new NativeExperienceTransport(
        Number(new URL(await app.getUrl()).port),
      );
      const cancel = new Cancellation();
      const privateValues = new Set<string>([...oldOwners, ...oldSubjects]);
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
          {
            login: async () => {
              throw new Error('No provider configured');
            },
          },
          systemClock,
        );
        const api = new ApiClient(nativeOrigin, transport, sessions, auth);
        const actor = {
          credentials,
          sessions,
          auth,
          api,
          community: new HttpCommunityGateway(api),
          discovery: new HttpDiscoveryGateway(api),
          profiles: new HttpProfileGateway(api),
          blocks: new HttpBlockGateway(api),
          experience: new HttpExperienceGateway(api),
        };
        return {
          ...actor,
          runtime: createExperienceRuntime(
            actor,
            memoryStorage(),
            nativeOrigin,
            async () => randomUUID(),
          ),
        };
      };
      const existingSession = async (subject: string) => {
        const accessToken = mintToken('access'),
          refreshToken = mintToken('refresh');
        const session = await app!.get(IdentityRepository).createSession(
          {
            provider: 'wechat',
            appId: 'synthetic-public-display-only',
            subject,
          },
          {
            access: hashToken(accessToken),
            refresh: hashToken(refreshToken),
          },
        );
        return { ...session, accessToken, refreshToken };
      };
      const author = await makeClient(),
        reader = await makeClient(),
        peer = await makeClient();
      const unknown = await makeClient(await existingSession(oldSubjects[0]!));
      const threshold = await makeClient(
        await existingSession(oldSubjects[1]!),
      );
      const actors = [author, reader, peer, unknown, threshold];
      type Actor = (typeof actors)[number];
      const profileIds = new Map<string, string>();
      for (const [i, actor] of actors.entries()) {
        await actor.profiles.updateProfile(
          { expectedRevision: 0, nickname: `Display${i}`, bio: '' },
          cancel,
        );
        profileIds.set(
          actor.credentials.accountId,
          (await actor.discovery.ownProfileRef(cancel)).profileId,
        );
      }
      const profileId = (actor: Actor) =>
        profileIds.get(actor.credentials.accountId)!;
      const profile = (actor = author, viewer = reader) =>
        viewer.discovery.profile(profileId(actor), cancel);
      const facade = app.get(ExperiencePublicDisplayFacade);
      const originalRead = facade.read.bind(facade);
      const projectionCalls: string[] = [];
      facade.read = async (owner, tx) => {
        projectionCalls.push(owner);
        return originalRead(owner, tx);
      };
      const snapshot = async () => {
        const tables = (
          await pool.query<{ table_schema: string; table_name: string }>(
            "SELECT table_schema,table_name FROM information_schema.tables WHERE table_schema IN ('whaleu_experience','whaleu_community','whaleu_notifications') AND table_type='BASE TABLE' ORDER BY table_schema,table_name",
          )
        ).rows;
        const result: Record<string, unknown> = {};
        for (const { table_schema, table_name } of tables) {
          assert.match(table_schema, /^[a-z_]+$/);
          assert.match(table_name, /^[a-z_]+$/);
          result[`${table_schema}.${table_name}`] = (
            await pool.query(
              `SELECT coalesce(jsonb_agg(row ORDER BY row::text),'[]'::jsonb) rows FROM (SELECT to_jsonb(t) row FROM ${table_schema}.${table_name} t) s`,
            )
          ).rows[0]!.rows;
        }
        result['sequences'] = (
          await pool.query(
            "SELECT schemaname,sequencename,last_value FROM pg_sequences WHERE schemaname IN ('whaleu_experience','whaleu_community','whaleu_notifications') ORDER BY schemaname,sequencename",
          )
        ).rows;
        return result;
      };
      transport.checkResponse = (path, status, body) => {
        if (
          status !== 200 ||
          (!path.startsWith('/v1/profiles/') &&
            !path.startsWith('/v1/community/') &&
            ![
              '/v1/me/community/liked',
              '/v1/me/community/saved',
              '/v1/me/community/updates',
            ].includes(path))
        )
          return;
        noPrivate(body);
        for (const secret of privateValues)
          assert.ok(
            !JSON.stringify(body).includes(secret),
            'Public response leaked a private identifier/value',
          );
      };
      const select = async (
        actor: Actor,
        titleKey: string | null,
        colorId: number | null,
      ) => {
        const current = await actor.experience.appearance(cancel);
        const receipt = await actor.runtime.selectAppearance({
          expectedRevision: current.revision,
          titleKey,
          colorId,
        });
        assert.equal(receipt.outcome, 'applied');
        return receipt;
      };
      await t.test(
        'ordinary composition has one dispatcher/worker, genuine defaults are known-null and all GETs stay read-only',
        async () => {
          for (const token of [
            ExperienceDispatcher,
            ExperienceWorker,
            ExperiencePublicDisplayFacade,
          ]) {
            const providers = [...app!.get(ModulesContainer).values()].filter(
              (module) => module.providers.has(token),
            );
            assert.equal(
              providers.length,
              1,
              `${token.name} must not be duplicated by the leaf module`,
            );
          }
          const before = await snapshot();
          for (let i = 0; i < 3; i++) {
            const result = await profile();
            assert.equal(result.status, 'available');
            assert.deepEqual(result.experienceDisplay, display(null, null, 1));
            assert.equal(result.totalInteractions, null);
            assert.equal(result.totalInteractionsStatus, 'unavailable');
            for (const key of ['title', 'level', 'displayAvailability'])
              assert.equal(key in result, false);
          }
          assert.deepEqual(
            (await author.experience.appearance(cancel)).titles
              .map((v: { key: string }) => v.key)
              .sort(),
            ['default_jingxiaoyu', 'level_1'],
          );
          assert.deepEqual(
            (await author.experience.records(null, cancel)).items,
            [],
          );
          assert.deepEqual(
            await snapshot(),
            before,
            'Public reads never grant, initialize, settle, acknowledge or enqueue',
          );
        },
      );
      await t.test(
        'missing appearance and unknown balance remain independent; undated owned title is selectable through the real command',
        async () => {
          assert.deepEqual((await profile(unknown)).experienceDisplay, absent);
          await inTransaction(pool, async (tx) => {
            await grantSyntheticTitle(
              tx,
              unknown.credentials.accountId,
              'level_3',
              null,
            );
            await grantSyntheticTitle(
              tx,
              unknown.credentials.accountId,
              'level_9',
              null,
            );
            await establishSyntheticExperienceBaseline(
              tx,
              threshold.credentials.accountId,
              { balance: 15n },
            );
          });
          assert.deepEqual(
            (await profile(unknown)).experienceDisplay,
            absent,
            'Ownership alone never auto-equips',
          );
          assert.deepEqual((await profile(threshold)).experienceDisplay, {
            ...absent,
            level: known(2),
          });
          await select(unknown, 'level_3', 0);
          assert.deepEqual(
            (await profile(unknown)).experienceDisplay,
            display('level_3', 0, null),
          );
          await select(unknown, null, 0);
          assert.deepEqual(
            (await profile(unknown)).experienceDisplay,
            display(null, 0, null),
          );
          await select(unknown, 'level_3', null);
          assert.deepEqual(
            (await profile(unknown)).experienceDisplay,
            display('level_3', null, null),
          );
          await select(unknown, 'level_3', 0);
          await select(author, 'default_jingxiaoyu', 0);
          await select(peer, 'level_1', 3);
        },
      );

      const scope = await seedCommunityScope(pool);
      await seedReviewPolicy(pool);
      for (const actor of actors) {
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
      }
      const publish = async (
        actor: Actor,
        authorMode: 'named' | 'anonymous' = 'named',
        formation = false,
        trading = false,
      ) => {
        const body: PublishPost = {
          clientRequestId: randomUUID(),
          spaceId: scope.home.spaceId,
          category: trading ? 'trading' : 'discussion',
          text: 'Synthetic public experience',
          imageAssetIds: [],
          authorMode,
          commentsPolicy: 'open',
          ...(formation
            ? {
                component: {
                  kind: 'formation' as const,
                  capacity: 3,
                  theme: '同行',
                  contacts: { wechat: 'fixture-contact', qq: '', phone: '' },
                  contactSharing: 'members_v1' as const,
                },
              }
            : {}),
          ...(trading
            ? {
                trading: {
                  subtype: 'shuma' as const,
                  urgency: 'normal' as const,
                  price: '12',
                  location: 'Synthetic pickup',
                  contacts: { wechat: 'fixture-contact', qq: '', phone: '' },
                },
              }
            : {}),
        };
        await approveEnvelope(
          pool,
          await postApprovalEnvelope(
            app!,
            pool,
            actor.credentials.accountId,
            body,
          ),
        );
        const receipt = await actor.community.publishPost(body, cancel);
        assert.equal(receipt.outcome, 'created');
        return receipt.resourceId as string;
      };
      const discussion = async (
        actor: Actor,
        postId: string,
        authorMode: 'named' | 'anonymous',
        rootId: string | null = null,
        targetReplyId: string | null = null,
      ) => {
        const body: PublishComment | PublishReply = {
          clientRequestId: randomUUID(),
          text: 'Synthetic public discussion',
          imageAssetIds: [],
          authorMode,
          ...(rootId ? { targetReplyId } : {}),
        };
        await approveEnvelope(
          pool,
          await discussionApprovalEnvelope(
            app!,
            pool,
            actor.credentials.accountId,
            postId,
            body,
            rootId,
          ),
        );
        const receipt = rootId
          ? await actor.community.publishReply(rootId, body, cancel)
          : await actor.community.publishComment(postId, body, cancel);
        assert.equal(receipt.outcome, 'created');
        return receipt.resourceId as string;
      };
      const settle = async () => {
        const ids = (
          await pool.query<{ unit_id: string }>(
            "SELECT unit_id FROM whaleu_experience.work WHERE state <> 'completed' ORDER BY enrollment_order,unit_id LIMIT 50",
          )
        ).rows.map((v) => v.unit_id);
        if (ids.length)
          await app!.get(ExperienceWorker).run({ mode: 'apply', unitIds: ids });
      };
      const named = await publish(author),
        other = await publish(peer),
        undated = await publish(unknown);
      const trade = await publish(author, 'named', false, true);
      const formation = await publish(author, 'named', true),
        anonFormation = await publish(author, 'anonymous', true);
      const anonymous = await publish(author, 'anonymous');
      const root = await discussion(peer, named, 'named');
      const reply = await discussion(unknown, named, 'named', root);
      const targetReply = await discussion(author, named, 'named', root, reply);
      const anonymousRoot = await discussion(author, anonymous, 'named');
      const anonymousReply = await discussion(
        author,
        anonymous,
        'named',
        anonymousRoot,
      );
      const anonymousTarget = await discussion(
        author,
        anonymous,
        'named',
        anonymousRoot,
        anonymousReply,
      );
      await reader.community.joinFormation(
        formation,
        {
          clientRequestId: randomUUID(),
          contacts: { wechat: 'fixture-reader', qq: '', phone: '' },
          contactSharing: 'members_v1',
        },
        cancel,
      );
      await reader.community.joinFormation(
        anonFormation,
        {
          clientRequestId: randomUUID(),
          contacts: { wechat: 'fixture-reader', qq: '', phone: '' },
          contactSharing: 'members_v1',
        },
        cancel,
      );
      await reader.community.applySaved(
        {
          clientRequestId: randomUUID(),
          operation: 'set_post_saved',
          postId: named,
          desired: true,
          channel: null,
        },
        cancel,
      );
      for (const postId of [named, anonymous])
        await reader.community.like(
          {
            requestId: randomUUID(),
            operation: 'set_post_like',
            postId,
            liked: true,
          },
          cancel,
        );
      for (const [kind, id] of [
        ['comment', root],
        ['reply', reply],
      ] as const)
        await reader.community.discussionLike(
          kind,
          id,
          true,
          randomUUID(),
          cancel,
        );
      const updateIds = (
        await pool.query<{ id: string }>(
          "SELECT id FROM whaleu_community.outbox WHERE event_type IN ('comment_created','reply_created') ORDER BY id",
        )
      ).rows.map((v) => v.id);
      await app.get(UpdatesWorker).run({ mode: 'apply', eventIds: updateIds });

      await t.test(
        'every named nested surface and native gateway carries the exact safe display; GETs do not settle blocked work',
        async () => {
          const before = await snapshot();
          const expected = display('default_jingxiaoyu', 0, 1);
          exactAuthor(
            (await reader.community.post(named, cancel)).author,
            expected,
          );
          exactAuthor(
            (await reader.community.post(undated, cancel)).author,
            display('level_3', 0, null),
          );
          const feed = await reader.community.feed(
            { spaceId: scope.home.spaceId },
            cancel,
          );
          exactAuthor(
            feed.items.find((v: { id: string }) => v.id === named).author,
            expected,
          );
          const comments = await reader.community.comments(named, null, cancel);
          exactAuthor(
            comments.items.find((v: { id: string }) => v.id === root).author,
            display('level_1', 3, 1),
          );
          const replies = await reader.community.replies(root, null, cancel);
          exactAuthor(
            replies.items.find((v: { id: string }) => v.id === reply).author,
            display('level_3', 0, null),
          );
          const target = (await reader.community.reply(targetReply, cancel))
            .target;
          assert.equal(target.status, 'available');
          exactAuthor(target.author, display('level_3', 0, null));
          for (const member of (
            await reader.community.formation(formation, cancel)
          ).members)
            exactAuthor(member.author);
          const saved = await reader.community.saved(null, cancel);
          assert.equal(saved.items.length, 1);
          exactAuthor(saved.items[0].post.author, expected);
          const liked = await reader.discovery.liked(null, cancel);
          assert.equal(liked.visibleLikedCount, 4);
          for (const item of liked.items) exactAuthor(item.preview.author);
          const updates = await author.community.updates(null, cancel);
          assert.ok(
            updates.items.some(
              (v: { status: string }) => v.status === 'available',
            ),
          );
          for (const item of updates.items)
            if (item.status === 'available') exactAuthor(item.preview.author);
          const ownTrading = await author.community.ownTrading(null, cancel);
          exactAuthor(
            ownTrading.items.find((v: { id: string }) => v.id === trade).author,
            expected,
          );
          for (const item of (
            await reader.discovery.list(
              profileId(author),
              'posts',
              null,
              cancel,
            )
          ).items)
            exactAuthor(item.author, expected);
          assert.deepEqual(
            await snapshot(),
            before,
            'Every nested public read is free of experience/source writes',
          );
        },
      );
      await t.test(
        'anonymous self, root, reply, target and creator never look up underlying cosmetics',
        async () => {
          projectionCalls.length = 0;
          exactAuthor((await author.community.post(anonymous, cancel)).author);
          exactAuthor(
            (await reader.community.comment(anonymousRoot, cancel)).author,
          );
          exactAuthor(
            (await reader.community.reply(anonymousReply, cancel)).author,
          );
          const target = (await reader.community.reply(anonymousTarget, cancel))
            .target;
          assert.equal(target.status, 'available');
          exactAuthor(target.author);
          assert.deepEqual(
            projectionCalls.length,
            0,
            'Anonymous early returns must make no experience call, including self',
          );
          projectionCalls.length = 0;
          const roster = await reader.community.formation(
            anonFormation,
            cancel,
          );
          exactAuthor(
            roster.members.find((v: { isCreator: boolean }) => v.isCreator)
              .author,
          );
          assert.ok(
            !projectionCalls.includes(author.credentials.accountId),
            'Anonymous creator owner never reaches the display leaf',
          );
          assert.ok(
            projectionCalls.includes(reader.credentials.accountId),
            'A named participant keeps their own display',
          );
          await reader.community.applySaved(
            {
              clientRequestId: randomUUID(),
              operation: 'set_post_saved',
              postId: anonymous,
              desired: true,
              channel: null,
            },
            cancel,
          );
          await reader.community.applySaved(
            {
              clientRequestId: randomUUID(),
              operation: 'set_post_update_preference',
              postId: anonymous,
              desired: true,
              channel: 'saved',
            },
            cancel,
          );
          const notifiedRoot = await discussion(author, anonymous, 'anonymous');
          const event = (
            await pool.query<{ id: string }>(
              "SELECT id FROM whaleu_community.outbox WHERE resource_id=$1 AND event_type='comment_created'",
              [notifiedRoot],
            )
          ).rows[0]!;
          await app!
            .get(UpdatesWorker)
            .run({ mode: 'apply', eventIds: [event.id] });
          projectionCalls.length = 0;
          const anonymousUpdates = await reader.community.updates(null, cancel);
          const notice = anonymousUpdates.items.find(
            (item: { status: string; target?: { commentId: string } }) =>
              item.status === 'available' &&
              item.target?.commentId === notifiedRoot,
          );
          assert.ok(
            notice,
            'Anonymous source produces a real saved Updates preview',
          );
          exactAuthor(notice.preview.author);
          assert.equal(
            projectionCalls.length,
            0,
            'Anonymous Updates never resolves the underlying owner',
          );
          const mixedRoot = await discussion(peer, anonymous, 'named');
          exactAuthor(
            (await reader.community.comment(mixedRoot, cancel)).author,
            display('level_1', 3, 1),
          );
        },
      );
      await t.test(
        'retained high color survives genuine deletion settlement and a downgrade without fabricating balance',
        async () => {
          await select(threshold, null, 11);
          assert.deepEqual(
            (await profile(threshold)).experienceDisplay,
            display(null, 11, 2),
          );
          const first = await publish(threshold),
            second = await publish(threshold);
          await settle();
          assert.equal(
            (await threshold.experience.summary(cancel)).balance,
            '25',
          );
          await threshold.community.deletePost(first, cancel);
          await threshold.community.deletePost(second, cancel);
          await settle();
          assert.equal(
            (await threshold.experience.summary(cancel)).balance,
            '5',
          );
          assert.deepEqual(
            (await profile(threshold)).experienceDisplay,
            display(null, 11, 1),
          );
        },
      );
      await t.test(
        'lost selection response recovers an immutable receipt while a public reload shows the newer committed choice',
        async () => {
          const before = await unknown.experience.appearance(cancel);
          transport.dropSuccess = {
            path: '/v1/me/experience/appearance',
            method: 'PUT',
          };
          await assert.rejects(
            unknown.runtime.selectAppearance({
              expectedRevision: before.revision,
              titleKey: 'level_3',
              colorId: 4,
            }),
          );
          const pending = unknown.runtime.pending.load(
            unknown.credentials.accountId,
            'appearance',
          );
          assert.ok(pending);
          const current = await unknown.experience.appearance(cancel);
          const response = await request(app!.getHttpServer())
            .put('/v1/me/experience/appearance')
            .set('Authorization', `Bearer ${unknown.credentials.accessToken}`)
            .send({
              requestId: randomUUID(),
              expectedRevision: current.revision,
              titleKey: 'level_9',
              colorId: 5,
            });
          assert.equal(response.status, 200, JSON.stringify(response.body));
          const recovered = await unknown.runtime.recover('appearance', true);
          assert.equal(recovered.requestId, pending.intent.requestId);
          assert.equal(recovered.colorId, 4);
          assert.deepEqual(
            (await profile(unknown)).experienceDisplay,
            display('level_9', 5, null),
          );
        },
      );

      await t.test(
        'a real owner mutation held before commit never blocks public reads and each pair uses one appearance snapshot',
        async () => {
          await select(author, 'default_jingxiaoyu', 0);
          const old = (await profile()).experienceDisplay;
          const repository = app!.get(ExperienceRepository),
            originalSave = repository.saveReceipt.bind(repository);
          const arrived = deferred(),
            release = deferred();
          repository.saveReceipt = async (
            ...args: Parameters<ExperienceRepository['saveReceipt']>
          ) => {
            await originalSave(...args);
            if (
              args[0] === author.credentials.accountId &&
              args[2].operation === 'appearance'
            ) {
              arrived.resolve();
              await release.promise;
            }
          };
          let changing: Promise<unknown> | undefined;
          try {
            changing = select(author, 'level_1', 3);
            await bounded(
              arrived.promise,
              'real mutation reaches pre-commit gate',
            );
            for (let i = 0; i < 8; i++) {
              assert.deepEqual(
                (
                  await bounded<{ experienceDisplay: PublicExperienceDisplay }>(
                    profile(),
                    'profile while owner lock held',
                  )
                ).experienceDisplay,
                old,
              );
              exactAuthor(
                (
                  (await bounded(
                    reader.community.post(named, cancel),
                    'named post while owner lock held',
                  )) as { author: AuthorView }
                ).author,
                old,
              );
            }
          } finally {
            release.resolve();
            await changing;
            repository.saveReceipt = originalSave;
          }
          const fresh = await profile();
          assert.equal(fresh.experienceDisplay.title.value.key, 'level_1');
          assert.equal(fresh.experienceDisplay.color.value, 3);
          const tx = await pool.connect();
          try {
            await tx.query('BEGIN');
            assert.deepEqual(
              await facade.read(author.credentials.accountId, tx),
              fresh.experienceDisplay,
            );
            await select(author, 'default_jingxiaoyu', 0);
            const next = await facade.read(author.credentials.accountId, tx);
            assert.equal(next.title.value?.key, 'default_jingxiaoyu');
            assert.equal(next.color.value, 0);
            await tx.query('COMMIT');
          } finally {
            await tx.query('ROLLBACK');
            tx.release();
          }
        },
      );

      await t.test(
        'opposite content traversals, canonical source enrollment and a single-owner worker add no cosmetic owner wait edge',
        async () => {
          const ownerGuard = await pool.connect(),
            traversal = await pool.connect(),
            reverseTraversal = await pool.connect();
          let writing: Promise<unknown> | undefined;
          try {
            await ownerGuard.query('BEGIN');
            await lockExperienceOwner(ownerGuard, author.credentials.accountId);
            const pid = (
              await ownerGuard.query<{ pid: number }>(
                'SELECT pg_backend_pid() pid',
              )
            ).rows[0]!.pid;
            writing = peer.community.like(
              {
                requestId: randomUUID(),
                operation: 'set_post_like',
                postId: named,
                liked: true,
              },
              cancel,
            );
            const until = Date.now() + 5000;
            let waiting = false;
            while (Date.now() < until) {
              const row = (
                await pool.query<{ waiting: boolean }>(
                  "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%whaleu_experience.owners%') waiting",
                  [pid],
                )
              ).rows[0]!;
              if (row.waiting) {
                waiting = true;
                break;
              }
              await delay(5);
            }
            assert.equal(
              waiting,
              true,
              'Real source writer reached its sorted experience-owner gate while holding content',
            );
            await traversal.query('BEGIN');
            await traversal.query("SET LOCAL statement_timeout='1500ms'");
            await traversal.query(
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR SHARE',
              [other],
            );
            await bounded(
              facade.read(author.credentials.accountId, traversal),
              'A display under B content lock',
            );
            await bounded(
              facade.read(peer.credentials.accountId, traversal),
              'B display under B content lock',
            );
            await reverseTraversal.query('BEGIN');
            await reverseTraversal.query(
              "SET LOCAL statement_timeout='1500ms'",
            );
            await reverseTraversal.query(
              'SELECT id FROM whaleu_community.root_comments WHERE id=$1 FOR SHARE',
              [root],
            );
            await bounded(
              facade.read(peer.credentials.accountId, reverseTraversal),
              'second reader B under A child lock',
            );
            await bounded(
              facade.read(author.credentials.accountId, reverseTraversal),
              'second reader A in opposite owner order',
            );
            const reads = (
              await pool.query<{ blocking: number[] }>(
                'SELECT pg_blocking_pids($1) blocking',
                [pid],
              )
            ).rows[0]!.blocking;
            assert.deepEqual(reads, []);
            await ownerGuard.query('COMMIT');
            await bounded(
              writing!,
              'source enrollment completes while reader retains its cosmetic snapshot',
            );
            await traversal.query(
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR SHARE',
              [named],
            );
            await bounded(
              facade.read(peer.credentials.accountId, traversal),
              'opposite traversal B then A',
            );
            await bounded(
              facade.read(author.credentials.accountId, traversal),
              'opposite traversal A then B',
            );
            const unit = (
              await pool.query<{ unit_id: string }>(
                "SELECT unit_id FROM whaleu_experience.work WHERE beneficiary_id=$1 AND state <> 'completed' ORDER BY enrollment_order,unit_id LIMIT 1",
                [author.credentials.accountId],
              )
            ).rows[0];
            assert.ok(unit);
            await bounded(
              app!
                .get(ExperienceWorker)
                .run({ mode: 'apply', unitIds: [unit.unit_id] }),
              'single-owner worker while reader holds content shares',
            );
            await traversal.query('COMMIT');
            await reverseTraversal.query('COMMIT');
          } finally {
            await ownerGuard.query('ROLLBACK');
            await traversal.query('ROLLBACK');
            await reverseTraversal.query('ROLLBACK');
            ownerGuard.release();
            traversal.release();
            reverseTraversal.release();
            await writing;
          }
          // The application-owned ingress still has exactly its original sorted lock discipline.
          assert.ok(app!.get(ExperienceIngressService));
        },
      );

      await t.test(
        'block snapshots remain plain and one-way feeds, bilateral profiles and hidden-post policies keep their owners',
        async () => {
          projectionCalls.length = 0;
          const block = await author.blocks.apply(
            {
              clientRequestId: randomUUID(),
              operation: 'block_named',
              source: { kind: 'profile', id: profileId(reader) },
              blocked: true,
            },
            cancel,
          );
          assert.equal(block.receipt.outcome, 'applied');
          const list = await author.blocks.list(null, cancel);
          assert.ok(list.items.length);
          assert.deepEqual(
            projectionCalls,
            [],
            'Safety snapshots/list labels continue using the plain profile method',
          );
          assert.equal(
            JSON.stringify(list).includes('experienceDisplay'),
            false,
          );
          assert.deepEqual(await profile(), {
            status: 'unavailable',
            profileId: profileId(author),
          });
          const outgoing = await author.discovery.profile(
            profileId(reader),
            cancel,
          );
          assert.equal(outgoing.status, 'blocked_by_you');
          assert.equal('experienceDisplay' in outgoing, false);
          const feed = await reader.community.feed(
            { spaceId: scope.home.spaceId },
            cancel,
          );
          assert.ok(
            feed.items.some((v: { id: string }) => v.id === named),
            'Incoming-only block preserves list_projection policy',
          );
          await assert.rejects(
            reader.community.post(named, cancel),
            serverFailure('POST_NOT_FOUND'),
          );
          await author.blocks.apply(
            {
              clientRequestId: randomUUID(),
              operation: 'unblock_named',
              relationshipId: block.current.relationshipId,
              expectedRevision: block.current.revision,
              blocked: false,
            },
            cancel,
          );
          const current = await author.profiles.profile(cancel);
          await author.profiles.updatePreferences(
            {
              expectedRevision: current.revision,
              preferences: { hideProfilePosts: true },
            },
            cancel,
          );
          const hidden = await profile();
          assert.equal(hidden.postsHidden, true);
          assert.equal(hidden.postCount, 0);
          assert.equal(hidden.tradeCount, 0);
          assert.equal(
            hidden.experienceDisplay.title.value.key,
            'default_jingxiaoyu',
          );
          const latest = await author.profiles.profile(cancel);
          await author.profiles.updatePreferences(
            {
              expectedRevision: latest.revision,
              preferences: { hideProfilePosts: false },
            },
            cancel,
          );
        },
      );

      await t.test(
        'guest/current-account policy hides inactive profiles before cosmetic lookup and leaves named card lifecycle unchanged',
        async () => {
          const guest = await makeClient(reader.credentials);
          guest.sessions.logout();
          const selected = (await profile()).experienceDisplay;
          assert.deepEqual(
            (await profile(author, guest)).experienceDisplay,
            selected,
          );
          await pool.query(
            "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
            [author.credentials.accountId],
          );
          try {
            projectionCalls.length = 0;
            assert.deepEqual(await profile(), {
              status: 'unavailable',
              profileId: profileId(author),
            });
            assert.deepEqual(await profile(author, guest), {
              status: 'unavailable',
              profileId: profileId(author),
            });
            assert.equal(
              projectionCalls.length,
              0,
              'Inactive targets stop before the cosmetic leaf',
            );
            exactAuthor(
              (await reader.community.post(named, cancel)).author,
              selected,
            );
          } finally {
            await pool.query(
              "UPDATE whaleu_identity.accounts SET status='active' WHERE id=$1",
              [author.credentials.accountId],
            );
            guest.runtime.dispose();
          }
        },
      );
      await t.test(
        'strict native wire rejects absent/extra/contradictory cosmetics, while retained color and unknown level remain valid',
        async () => {
          const good = (await profile(unknown)).experienceDisplay;
          for (const bad of [
            { ...good, ownerId: unknown.credentials.accountId },
            { ...good, color: known(-1) },
            { ...good, color: known(26) },
            { ...good, color: known(0.5) },
            { ...good, color: known('red') },
            { ...good, color: { status: 'unavailable', value: 0 } },
            {
              ...good,
              title: known({
                key: 'level_3',
                name: '初来乍到',
                earnedAt: null,
              }),
            },
            { ...good, level: known(null) },
            { ...good, level: known(0) },
            { ...good, level: known(31) },
          ]) {
            transport.corruptNext = {
              path: `/v1/profiles/${profileId(unknown)}`,
              transform: (value) => ({
                ...(value as object),
                experienceDisplay: bad,
              }),
            };
            await assert.rejects(profile(unknown), protocolFailure);
          }
          transport.corruptNext = {
            path: `/v1/profiles/${profileId(unknown)}`,
            transform: (value) => ({
              ...(value as object),
              experienceDisplay: { ...good, color: known(25) },
            }),
          };
          assert.deepEqual(
            (await profile(unknown)).experienceDisplay,
            { ...good, color: known(25) },
            'Synthetic protocol fixture: a retained high color never infers a baseline',
          );
          const real = await reader.community.post(anonymous, cancel);
          assert.throws(
            () => decodeAuthor({ ...real.author, experienceDisplay: absent }),
            protocolFailure,
          );
          const namedAuthor = (await reader.community.post(named, cancel))
            .author;
          const legacy = { ...namedAuthor };
          delete legacy.experienceDisplay;
          assert.throws(() => decodeAuthor(legacy), protocolFailure);
        },
      );
      await t.test(
        'native page reload paints current evidence and clear/drop-late lifecycle keeps badges with their rows',
        async () => {
          for (const transition of [
            'cancel',
            'hide',
            'logout',
            'switch',
          ] as const) {
            const actor = await makeClient(reader.credentials),
              wx = platformStorage(),
              runtime = createCommunityRuntime(actor, wx, nativeOrigin);
            let view = initialPublicProfileView();
            const controller = new PublicProfileController(
              runtime,
              profileId(unknown),
              (next: typeof view) => {
                view = next;
              },
            );
            await controller.load();
            assert.deepEqual(
              view.profile.experienceDisplay,
              display('level_9', 5, null),
            );
            assert.ok(view.items.length);
            noPrivate(view.profile);
            noPrivate(view.items);
            const gate = transport.holdNext(
              `/v1/profiles/${profileId(unknown)}/posts`,
            );
            const loading = controller.load();
            await gate.arrived;
            if (transition === 'cancel') controller.cancel();
            else if (transition === 'hide') runtime.privateViews.clear();
            else if (transition === 'logout') actor.sessions.logout();
            else
              actor.sessions.completeLogin(
                actor.sessions.beginLogin(),
                peer.credentials,
              );
            assert.equal(view.profile, null);
            assert.deepEqual(view.items, []);
            gate.release();
            await loading;
            assert.equal(view.profile, null);
            assert.deepEqual(view.items, []);
            assert.equal(
              wx.storage.values.size,
              0,
              'Public badges never gain a separate persistent cache',
            );
            controller.dispose();
            actor.runtime.dispose();
          }
        },
      );
      for (const actor of actors) actor.runtime.dispose();
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
