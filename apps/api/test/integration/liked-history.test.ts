import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
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
import { IdentityService } from '../../src/identity/identity.service.js';
import { IdentityRepository } from '../../src/identity/identity.repository.js';
import { hashToken, mintToken } from '../../src/identity/tokens.js';
import { initializeNativeSafetyAccount } from '../../src/safety/lifecycle.js';
import { DatabaseService } from '../../src/database/database.js';
import { AuthorDisplayService } from '../../src/profile/author-display.service.js';
import {
  canonicalEnvelope,
  approvalDigest,
} from '../../src/community/content-review/contracts.js';
import type {
  AcceptedApproval,
  ContentKind,
} from '../../src/community/content-review/contracts.js';
import type {
  PublishPost,
  PublishComment,
} from '../../src/community/contracts.js';
import type { PublishReply } from '../../src/community/discussion/contracts.js';
import type {
  LikedItem,
  LikedKind,
  LikedPage,
} from '../../src/community/liked/contracts.js';
import { CommunitySerializer } from '../../src/community/community-serialization.js';
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
  approveEnvelope,
  seedReviewPolicy,
  setReviewState,
} from '../support/community-approval-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

async function waitForLock(pool: Pool, blocker: number, query: string) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    const rows = await pool.query(
      'SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE $2',
      [blocker, query],
    );
    if (rows.rowCount) return;
    await sleep(10);
  }
  assert.fail('Expected deterministic history row-lock waiter');
}
function exactItem(item: LikedItem) {
  assert.deepEqual(
    Object.keys(item).sort(),
    [
      'kind',
      'targetId',
      'postId',
      'rootCommentId',
      'likedAt',
      'likeId',
      'preview',
    ].sort(),
  );
  assert.deepEqual(
    Object.keys(item.preview).sort(),
    ['text', 'images', 'author', 'createdAt', 'isSelf'].sort(),
  );
  if (item.kind === 'post') {
    assert.equal(item.targetId, item.postId);
    assert.equal(item.rootCommentId, null);
  } else if (item.kind === 'comment')
    assert.equal(item.rootCommentId, item.targetId);
  else assert.ok(item.rootCommentId && item.rootCommentId !== item.targetId);
  assert.deepEqual(
    Object.keys(item.preview.author).sort(),
    item.preview.author.kind === 'named'
      ? [
          'kind',
          'profileId',
          'displayName',
          'avatar',
          'experienceDisplay',
        ].sort()
      : ['kind', 'personaId', 'displayName', 'avatar', 'isPostAuthor'].sort(),
  );
}

test(
  'canonical liked history and forward-only undated membership migration',
  { timeout: 120000 },
  async (t) => {
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(database, 'Use disposable loopback whaleu_test');
    const url = new URL(database);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: database,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '20',
      COMMUNITY_UPDATES_PROCESSING: 'disabled',
    });
    const pool = new Pool(poolOptions(config));
    let suite: PoolClient | undefined,
      app: INestApplication | undefined,
      owns = false,
      locked = false;
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) AS locked',
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
        'Refuse existing WhaleU schemas',
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
      // Only synthetic SQL fixtures run against the historical schema. The current
      // application starts after all migrations; runtime never falls back around
      // missing experience tables or relabels an old account as newly created.
      const scope = await seedCommunityScope(pool);
      const historicPolicy = await seedReviewPolicy(pool);
      const historicalApprovals = new Map<string, AcceptedApproval>();
      const historicAuthor = randomUUID(),
        historicPeer = randomUUID(),
        historicReader = randomUUID();
      const historicalIds = {
        named: randomUUID(),
        anonymous: randomUUID(),
        anonRoot: randomUUID(),
        namedRoot: randomUUID(),
        anonReply: randomUUID(),
        namedReply: randomUUID(),
      };
      const setup = await pool.connect();
      try {
        await setup.query('BEGIN');
        for (const owner of [historicAuthor, historicPeer, historicReader]) {
          await setup.query(
            'INSERT INTO whaleu_identity.accounts(id) VALUES($1)',
            [owner],
          );
          await initializeNativeSafetyAccount(owner, setup);
          await setup.query(
            "INSERT INTO whaleu_identity.provider_identities(provider,app_id,subject,account_id) VALUES('wechat','synthetic-liked-migration',$1::text,$2::uuid)",
            [owner, owner],
          );
        }
        for (const [id, mode] of [
          [historicalIds.named, 'named'],
          [historicalIds.anonymous, 'anonymous'],
        ])
          await setup.query(
            "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'discussion','Synthetic history post',$4,'open')",
            [id, scope.home.spaceId, historicAuthor, mode],
          );
        for (const [id, post, mode] of [
          [historicalIds.anonRoot, historicalIds.named, 'anonymous'],
          [historicalIds.namedRoot, historicalIds.anonymous, 'named'],
        ])
          await setup.query(
            "INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode) VALUES($1,$2,$3,'Synthetic history root',$4)",
            [id, post, historicPeer, mode],
          );
        await setup.query(
          "INSERT INTO whaleu_community.replies(id,post_id,root_comment_id,account_id,text,author_mode) VALUES($1,$2,$3,$4,'Synthetic history reply','anonymous')",
          [
            historicalIds.anonReply,
            historicalIds.anonymous,
            historicalIds.namedRoot,
            historicPeer,
          ],
        );
        await setup.query(
          "INSERT INTO whaleu_community.replies(id,post_id,root_comment_id,target_reply_id,account_id,text,author_mode) VALUES($1,$2,$3,$4,$5,'Synthetic history reply','named')",
          [
            historicalIds.namedReply,
            historicalIds.anonymous,
            historicalIds.namedRoot,
            historicalIds.anonReply,
            historicPeer,
          ],
        );
        for (const [post, owner] of [
          [historicalIds.anonymous, historicAuthor],
          [historicalIds.named, historicPeer],
          [historicalIds.anonymous, historicPeer],
        ])
          await setup.query(
            "INSERT INTO whaleu_community.thread_personas(id,post_id,account_id,display_name) VALUES($1,$2,$3,'匿名鲸鱼')",
            [randomUUID(), post, owner],
          );
        for (const [kind, id] of [
          ['post', historicalIds.named],
          ['comment', historicalIds.anonRoot],
          ['reply', historicalIds.namedReply],
        ])
          await setup.query(
            `INSERT INTO whaleu_community.${kind}_likes(${kind}_id,account_id) VALUES($1,$2)`,
            [id, historicReader],
          );
        // Review binding is part of the same original synthetic creation
        // transaction. A later migration never repairs or restamps old evidence.
        for (const [kind, id, mode, parent, root, target] of [
          ['post', historicalIds.named, 'named', null, null, null],
          ['post', historicalIds.anonymous, 'anonymous', null, null, null],
          [
            'comment',
            historicalIds.anonRoot,
            'anonymous',
            historicalIds.named,
            null,
            null,
          ],
          [
            'comment',
            historicalIds.namedRoot,
            'named',
            historicalIds.anonymous,
            null,
            null,
          ],
          [
            'reply',
            historicalIds.anonReply,
            'anonymous',
            historicalIds.anonymous,
            historicalIds.namedRoot,
            null,
          ],
          [
            'reply',
            historicalIds.namedReply,
            'named',
            historicalIds.anonymous,
            historicalIds.namedRoot,
            historicalIds.anonReply,
          ],
        ] as const) {
          const envelope = canonicalEnvelope({
            version: 1,
            accountId: kind === 'post' ? historicAuthor : historicPeer,
            purpose:
              kind === 'post'
                ? 'publish_post'
                : kind === 'comment'
                  ? 'publish_comment'
                  : 'publish_reply',
            spaceId: scope.home.spaceId,
            category: 'discussion',
            authorMode: mode,
            commentsPolicy: 'open',
            postId: parent,
            rootCommentId: root,
            targetReplyId: target,
            text:
              kind === 'post'
                ? 'Synthetic history post'
                : kind === 'comment'
                  ? 'Synthetic history root'
                  : 'Synthetic history reply',
            images: [],
            component: { kind: 'none' },
            trading: null,
            scope: {
              originalSpaceId: scope.home.spaceId,
              originalRegionId: scope.home.regionId,
              authorOriginRegionId: scope.home.regionId,
              identityRegionId: scope.home.regionId,
              topologySnapshotId: scope.topologySnapshotId,
              sync: 'none',
            },
          });
          const decisionId = randomUUID(),
            eventId = randomUUID(),
            digest = approvalDigest(envelope);
          await setup.query(
            "INSERT INTO whaleu_community.content_approval_decisions(id,account_id,operation,envelope_version,digest,envelope,policy_revision_id,result,coverage,provenance,issuer,provenance_ref,evaluated_at,consume_until,visibility_model,visibility_until) VALUES($1,$2,$3,1,$4,$5::jsonb,$6,'allow','complete','accepted','synthetic-review-owner','synthetic-historical-liked-review',clock_timestamp()-interval '1 second',clock_timestamp()+interval '1 hour','durable',NULL)",
            [
              decisionId,
              envelope.accountId,
              envelope.purpose,
              digest,
              JSON.stringify(envelope),
              historicPolicy,
            ],
          );
          await setup.query(
            "INSERT INTO whaleu_community.content_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at) VALUES($1,$2,'allow','complete','accepted','synthetic-review-owner','synthetic-historical-liked-state',clock_timestamp())",
            [eventId, decisionId],
          );
          await setup.query(
            'INSERT INTO whaleu_community.content_approval_heads(decision_id,event_id) VALUES($1,$2)',
            [decisionId, eventId],
          );
          await setup.query(
            'INSERT INTO whaleu_community.content_approval_bindings(content_kind,content_id,content_version,decision_id,account_id,operation,envelope_version,digest,envelope,scope) VALUES($1,$2,1,$3,$4,$5,1,$6,$7::jsonb,$8::jsonb)',
            [
              kind satisfies ContentKind,
              id,
              decisionId,
              envelope.accountId,
              envelope.purpose,
              digest,
              JSON.stringify(envelope),
              JSON.stringify(envelope.scope),
            ],
          );
          historicalApprovals.set(id, {
            decisionId,
            digest,
            version: 1,
            envelope,
          });
        }
        await setup.query('COMMIT');
      } finally {
        await setup.query('ROLLBACK');
        setup.release();
      }
      await runMigrations(pool, migrations, { mode: 'up' });
      app = await NestFactory.create(AppModule.register(config), {
        logger: false,
      });
      configureHttp(app);
      await app.init();
      const http = app.getHttpServer();
      const existingActor = async (owner: string) => {
        const accessToken = mintToken('access'),
          refreshToken = mintToken('refresh');
        const session = await app!.get(IdentityRepository).createSession(
          {
            provider: 'wechat',
            appId: 'synthetic-liked-migration',
            subject: owner,
          },
          {
            access: hashToken(accessToken),
            refresh: hashToken(refreshToken),
          },
        );
        return { ...session, accessToken, refreshToken };
      };
      const author = await existingActor(historicAuthor),
        peer = await existingActor(historicPeer),
        reader = await existingActor(historicReader);
      type Actor = typeof author;
      await app.get(DatabaseService).transaction(async (tx) => {
        await app!.get(AuthorDisplayService).prepare(author.accountId, tx);
        await app!.get(AuthorDisplayService).prepare(peer.accountId, tx);
      });
      await seedReviewPolicy(pool);
      const verify = async (actor: Actor, publisher = true) => {
        const facts = await setRuntimeVerification(
          pool,
          actor.accountId,
          scope.institutionId,
          scope.home.regionId,
          publisher ? 'verified' : 'unavailable',
        );
        if (publisher)
          await appendIdentitySelection(
            pool,
            actor.accountId,
            facts,
            scope,
            scope.home.campusId,
          );
      };
      await verify(author);
      await verify(peer);
      const auth = (actor = reader) => `Bearer ${actor.accessToken}`;
      const publish = async (
        mode: 'named' | 'anonymous' = 'named',
        actor = author,
        visibilityUntil: Date | null = null,
        historicalId: string | null = null,
      ) => {
        if (historicalId)
          return {
            id: historicalId,
            approval: historicalApprovals.get(historicalId)!,
          };
        const body: PublishPost = {
          clientRequestId: randomUUID(),
          spaceId: scope.home.spaceId,
          category: 'discussion',
          text: 'Synthetic history post',
          imageAssetIds: [],
          authorMode: mode,
          commentsPolicy: 'open',
        };
        const approval = await approveEnvelope(
          pool,
          await postApprovalEnvelope(app!, pool, actor.accountId, body),
          { visibilityUntil },
        );
        const response = await request(http)
          .post('/v1/community/posts')
          .set('Authorization', auth(actor))
          .send(body);
        assert.equal(response.status, 201, JSON.stringify(response.body));
        assert.equal(
          response.body.outcome,
          'created',
          JSON.stringify(response.body),
        );
        return { id: response.body.resourceId as string, approval };
      };
      const comment = async (
        postId: string,
        mode: 'named' | 'anonymous',
        actor = peer,
        historicalId: string | null = null,
      ) => {
        if (historicalId)
          return {
            id: historicalId,
            approval: historicalApprovals.get(historicalId)!,
          };
        const body: PublishComment = {
          clientRequestId: randomUUID(),
          text: 'Synthetic history root',
          imageAssetIds: [],
          authorMode: mode,
        };
        const approval = await approveEnvelope(
          pool,
          await discussionApprovalEnvelope(
            app!,
            pool,
            actor.accountId,
            postId,
            body,
          ),
        );
        const response = await request(http)
          .post(`/v1/community/posts/${postId}/comments`)
          .set('Authorization', auth(actor))
          .send(body);
        assert.equal(response.status, 201, JSON.stringify(response.body));
        assert.equal(
          response.body.outcome,
          'created',
          JSON.stringify(response.body),
        );
        return { id: response.body.resourceId as string, approval };
      };
      const reply = async (
        postId: string,
        rootId: string,
        mode: 'named' | 'anonymous',
        actor = peer,
        targetReplyId: string | null = null,
        historicalId: string | null = null,
      ) => {
        if (historicalId)
          return {
            id: historicalId,
            approval: historicalApprovals.get(historicalId)!,
          };
        const body: PublishReply = {
          clientRequestId: randomUUID(),
          text: 'Synthetic history reply',
          imageAssetIds: [],
          authorMode: mode,
          targetReplyId,
        };
        const approval = await approveEnvelope(
          pool,
          await discussionApprovalEnvelope(
            app!,
            pool,
            actor.accountId,
            postId,
            body,
            rootId,
          ),
        );
        const response = await request(http)
          .post(`/v1/community/comments/${rootId}/replies`)
          .set('Authorization', auth(actor))
          .send(body);
        assert.equal(response.status, 201, JSON.stringify(response.body));
        assert.equal(
          response.body.outcome,
          'created',
          JSON.stringify(response.body),
        );
        return { id: response.body.resourceId as string, approval };
      };
      const named = await publish('named', author, null, historicalIds.named),
        anonymous = await publish(
          'anonymous',
          author,
          null,
          historicalIds.anonymous,
        );
      const anonRoot = await comment(
          named.id,
          'anonymous',
          peer,
          historicalIds.anonRoot,
        ),
        namedRoot = await comment(
          anonymous.id,
          'named',
          peer,
          historicalIds.namedRoot,
        );
      const anonReply = await reply(
        anonymous.id,
        namedRoot.id,
        'anonymous',
        peer,
        null,
        historicalIds.anonReply,
      );
      const namedReply = await reply(
        anonymous.id,
        namedRoot.id,
        'named',
        peer,
        anonReply.id,
        historicalIds.namedReply,
      );
      const historical = [
        { kind: 'post', id: named.id },
        { kind: 'comment', id: anonRoot.id },
        { kind: 'reply', id: namedReply.id },
      ] as const;
      const list = (limit = 20, cursor?: string, actor = reader) =>
        request(http)
          .get('/v1/me/community/liked')
          .set('Authorization', auth(actor))
          .query({ limit, ...(cursor ? { cursor } : {}) });
      const page = async (
        limit = 20,
        cursor?: string,
        actor = reader,
      ): Promise<LikedPage> => {
        const response = await list(limit, cursor, actor);
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.equal(response.headers['vary'], 'Authorization');
        assert.deepEqual(
          Object.keys(response.body).sort(),
          [
            'items',
            'visibleLikedCount',
            'visibleLikedCountStatus',
            'continuation',
            'nextCursor',
          ].sort(),
        );
        const result = response.body as LikedPage;
        for (const item of result.items) exactItem(item);
        for (const secret of [
          author.accountId,
          peer.accountId,
          reader.accountId,
          reader.sessionId,
          reader.accessToken,
          scope.institutionId,
          scope.home.campusId,
        ])
          assert.ok(!JSON.stringify(result).includes(secret));
        return result;
      };
      const like = async (kind: LikedKind, id: string, desired = true) => {
        const client = request(http);
        const operation = client[kind === 'post' || desired ? 'put' : 'delete'](
          `/v1/community/${kind === 'post' ? 'posts' : kind === 'comment' ? 'comments' : 'replies'}/${id}/like`,
        ).set('Authorization', auth());
        const response = await (kind === 'post'
          ? operation.send({ requestId: randomUUID(), liked: desired })
          : operation.send({ clientRequestId: randomUUID() }));
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(
          response.body.outcome,
          'applied',
          JSON.stringify(response.body),
        );
      };
      await t.test(
        'forward migration retains every old undated membership and reads need only an active session',
        async () => {
          const current = await page();
          assert.equal(current.visibleLikedCount, 3);
          assert.deepEqual(
            current.items.map((item) => item.targetId).sort(),
            historical.map((item) => item.id).sort(),
          );
          assert.ok(current.items.every((item) => item.likedAt === null));
          assert.equal(
            new Set(current.items.map((item) => item.likeId)).size,
            3,
          );
          assert.deepEqual(
            current.items.map((item) => item.likeId),
            current.items
              .map((item) => item.likeId)
              .sort()
              .reverse(),
          );
          for (const old of current.items) {
            const duplicate = await pool.query(
              `INSERT INTO whaleu_community.${old.kind}_likes(${old.kind}_id,account_id) VALUES($1,$2) ON CONFLICT(${old.kind}_id,account_id) DO NOTHING`,
              [old.targetId, reader.accountId],
            );
            assert.equal(duplicate.rowCount, 0);
            assert.equal(
              (await page()).items.find(
                (item) => item.targetId === old.targetId,
              )!.likeId,
              old.likeId,
            );
            for (const mutation of [
              'SET liked_at=clock_timestamp()',
              'SET like_id=gen_random_uuid()',
              'SET account_id=$3',
            ]) {
              await assert.rejects(
                pool.query(
                  `UPDATE whaleu_community.${old.kind}_likes ${mutation} WHERE ${old.kind}_id=$1 AND account_id=$2`,
                  mutation.includes('$3')
                    ? [old.targetId, reader.accountId, peer.accountId]
                    : [old.targetId, reader.accountId],
                ),
                { code: '23514' },
              );
            }
          }
          for (const old of current.items) {
            for (const timestamp of [
              null,
              'infinity',
              '2026-01-01T00:00:00.000001Z',
            ])
              await assert.rejects(
                pool.query(
                  `INSERT INTO whaleu_community.${old.kind}_likes(${old.kind}_id,account_id,liked_at) VALUES($1,$2,$3)`,
                  [old.targetId, peer.accountId, timestamp],
                ),
                { code: '23514' },
              );
            await assert.rejects(
              pool.query(
                `INSERT INTO whaleu_community.${old.kind}_likes(${old.kind}_id,account_id) VALUES($1,$2)`,
                [old.targetId, reader.accountId],
              ),
              { code: '23505' },
            );
          }
          const empty = await page(
            20,
            undefined,
            await createRuntimeActor(app!),
          );
          assert.deepEqual(empty, {
            items: [],
            visibleLikedCount: 0,
            visibleLikedCountStatus: 'known',
            continuation: 'end',
            nextCursor: null,
          });
          assert.equal(
            (await request(http).get('/v1/me/community/liked')).status,
            401,
          );
          assert.equal(
            (
              await request(http)
                .get('/v1/me/community/liked')
                .set('Authorization', 'Bearer invalid')
            ).status,
            401,
          );
          for (const body of [
            { accountId: peer.accountId },
            { profileId: randomUUID() },
          ]) {
            assert.equal(
              (
                await request(http)
                  .get('/v1/me/community/liked')
                  .set('Authorization', auth())
                  .send(body)
              ).status,
              400,
            );
            assert.equal(
              (
                await request(http)
                  .get('/v1/me/community/liked')
                  .set('Authorization', auth())
                  .query(body)
              ).status,
              400,
            );
          }
          for (const limit of ['0', '51', '01', '1e1', '0x10', ' 20 ', '1.0'])
            assert.equal(
              (
                await request(http)
                  .get('/v1/me/community/liked')
                  .set('Authorization', auth())
                  .query({ limit })
              ).status,
              400,
            );
        },
      );
      await t.test(
        'dated ties page before all undated history with opaque coordinates and exact target author modes',
        async () => {
          const dated = [
            { kind: 'post', id: anonymous.id },
            { kind: 'comment', id: namedRoot.id },
            { kind: 'reply', id: anonReply.id },
          ] as const;
          for (const item of dated)
            await pool.query(
              `INSERT INTO whaleu_community.${item.kind}_likes(${item.kind}_id,account_id,liked_at) VALUES($1,$2,$3)`,
              [item.id, reader.accountId, '1900-01-01T00:00:00.000Z'],
            );
          const all = await page();
          assert.equal(all.visibleLikedCount, 6);
          assert.ok(
            all.items
              .slice(0, 3)
              .every((item) => item.likedAt === '1900-01-01T00:00:00.000Z'),
          );
          assert.ok(all.items.slice(3).every((item) => item.likedAt === null));
          const byId = new Map(all.items.map((item) => [item.targetId, item]));
          for (const id of [named.id, namedRoot.id, namedReply.id])
            assert.equal(byId.get(id)!.preview.author.kind, 'named');
          for (const id of [anonymous.id, anonRoot.id, anonReply.id])
            assert.equal(byId.get(id)!.preview.author.kind, 'anonymous');
          const seen: string[] = [];
          let cursor: string | undefined;
          do {
            const current = await page(1, cursor);
            assert.equal(current.visibleLikedCount, 6);
            seen.push(...current.items.map((item) => item.likeId));
            if (current.nextCursor) {
              assert.match(current.nextCursor, /^[A-Za-z0-9_-]{43}$/);
              const bytes = Buffer.from(current.nextCursor, 'base64url');
              assert.equal(bytes.length, 32);
              assert.ok(!bytes.toString().includes(reader.accountId));
              assert.equal((await list(2, current.nextCursor)).status, 400);
              assert.equal(
                (await list(1, current.nextCursor, peer)).status,
                400,
              );
            }
            cursor = current.nextCursor ?? undefined;
          } while (cursor);
          assert.deepEqual(
            seen,
            all.items.map((item) => item.likeId),
          );
          assert.equal(new Set(seen).size, 6);
          assert.equal((await page(6)).nextCursor, null);
          const oldSessionCursor = (await page(1)).nextCursor!;
          const refreshed = await app!
            .get(IdentityService)
            .refresh(reader.refreshToken);
          // Refresh rotates tokens within the same session; continuation remains valid.
          const refreshedReader = { ...reader, ...refreshed };
          assert.equal(
            (await list(1, oldSessionCursor, refreshedReader)).status,
            200,
          );
          Object.assign(reader, refreshedReader);
        },
      );
      await verify(reader);
      await t.test(
        'unchanged like retains identity; unlike/re-like changes identity and invalidates its old cursor',
        async () => {
          const before = (await page()).items.find(
            (item) => item.targetId === named.id,
          )!;
          await like('post', named.id);
          assert.deepEqual(
            (await page()).items.find((item) => item.targetId === named.id),
            before,
          );
          await like('post', named.id, false);
          await like('post', named.id);
          const changed = (await page()).items.find(
            (item) => item.targetId === named.id,
          )!;
          assert.notEqual(changed.likeId, before.likeId);
          assert.ok(changed.likedAt);
          const first = await page(1);
          assert.equal(first.items[0]!.targetId, named.id);
          await like('post', named.id, false);
          const stale = await list(1, first.nextCursor!);
          assert.equal(stale.status, 409);
          assert.equal(stale.body.error.code, 'DISCOVERY_RESTART_REQUIRED');
          await like('post', named.id);
          assert.equal((await list(1, first.nextCursor!)).status, 409);
          for (const kind of ['comment', 'reply'] as const) {
            const id = kind === 'comment' ? anonRoot.id : namedReply.id;
            const old = (await page()).items.find(
              (item) => item.targetId === id,
            )!;
            await like(kind, id, false);
            await like(kind, id);
            const fresh = (await page()).items.find(
              (item) => item.targetId === id,
            )!;
            assert.notEqual(fresh.likeId, old.likeId);
            assert.ok(fresh.likedAt);
          }
        },
      );
      await t.test(
        'hidden/deleted parent or root and denied review suppress descendants; missing coverage fails unavailable',
        async () => {
          const baseline = await page();
          const anchorBeforeHide = await page(1);
          assert.equal(anchorBeforeHide.items[0]!.postId, anonymous.id);
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
              [anonymous.id],
            ),
          );
          const hidden = await page();
          assert.equal(hidden.visibleLikedCount, 2);
          const hiddenAnchor = await list(1, anchorBeforeHide.nextCursor!);
          assert.equal(hiddenAnchor.status, 409);
          assert.equal(
            hiddenAnchor.body.error.code,
            'DISCOVERY_RESTART_REQUIRED',
          );
          assert.ok(hidden.items.every((item) => item.postId !== anonymous.id));
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              "UPDATE whaleu_community.posts SET visibility='approved' WHERE id=$1",
              [anonymous.id],
            ),
          );
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              'UPDATE whaleu_community.root_comments SET deleted_at=clock_timestamp() WHERE id=$1',
              [namedRoot.id],
            ),
          );
          assert.equal((await page()).visibleLikedCount, 3);
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              'UPDATE whaleu_community.root_comments SET deleted_at=NULL WHERE id=$1',
              [namedRoot.id],
            ),
          );
          await setReviewState(pool, namedReply.approval.decisionId, 'held');
          assert.equal((await page()).visibleLikedCount, 5);
          await setReviewState(pool, namedReply.approval.decisionId, 'allow');
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              "UPDATE whaleu_safety.account_heads SET block_coverage='missing' WHERE account_id=$1",
              [peer.accountId],
            ),
          );
          const anonymousReader = await createRuntimeActor(app!);
          await pool.query(
            'INSERT INTO whaleu_community.comment_likes(comment_id,account_id) VALUES($1,$2)',
            [anonRoot.id, anonymousReader.accountId],
          );
          const anonymousOnly = await page(20, undefined, anonymousReader);
          assert.equal(anonymousOnly.visibleLikedCount, 1);
          assert.equal(
            anonymousOnly.items[0]!.preview.author.kind,
            'anonymous',
          );
          const unavailable = await list(1);
          assert.equal(unavailable.status, 503);
          assert.equal(unavailable.body.error.code, 'COMMUNITY_UNAVAILABLE');
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              "UPDATE whaleu_safety.account_heads SET block_coverage='complete' WHERE account_id=$1",
              [peer.accountId],
            ),
          );
          assert.equal(
            (await page()).visibleLikedCount,
            baseline.visibleLikedCount,
          );
        },
      );
      await t.test(
        'unknown review outside a bounded page cannot block it or invent a total, but fails when reached',
        async () => {
          const target = randomUUID();
          await pool.query(
            "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'discussion','Synthetic unresolved review','named','open')",
            [target, scope.home.spaceId, author.accountId],
          );
          await pool.query(
            "INSERT INTO whaleu_community.post_likes(post_id,account_id,liked_at) VALUES($1,$2,'1888-01-01T00:00:00.000Z')",
            [target, reader.accountId],
          );
          try {
            let response = await list(1);
            assert.equal(response.status, 200);
            assert.equal(response.body.visibleLikedCount, null);
            let hops = 0;
            while (response.status === 200 && response.body.nextCursor) {
              assert.ok(++hops < 20);
              response = await list(1, response.body.nextCursor);
            }
            assert.equal(response.status, 503);
            assert.equal(response.body.error.code, 'COMMUNITY_UNAVAILABLE');
          } finally {
            await pool.query(
              'DELETE FROM whaleu_community.post_likes WHERE post_id=$1 AND account_id=$2',
              [target, reader.accountId],
            );
          }
        },
      );
      await t.test(
        'incoming-only named root/reply block is bilateral while anonymous target ownership remains unlinked',
        async () => {
          const exactOnly = await reply(named.id, anonRoot.id, 'named');
          await like('reply', exactOnly.id);
          const reverseAnonymous = await reply(
            anonymous.id,
            namedRoot.id,
            'anonymous',
            peer,
            namedReply.id,
          );
          await like('reply', reverseAnonymous.id);
          assert.equal(
            (await page()).items.find(
              (item) => item.targetId === reverseAnonymous.id,
            )!.preview.author.kind,
            'anonymous',
          );
          const viewerPost = await publish('named', reader);
          const blocked = await request(http)
            .put('/v1/me/safety/blocks')
            .set('Authorization', auth(peer))
            .send({
              clientRequestId: randomUUID(),
              source: { kind: 'post', id: viewerPost.id },
              blocked: true,
            });
          assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
          assert.equal(
            blocked.body.receipt.outcome,
            'applied',
            JSON.stringify(blocked.body),
          );
          const current = await page();
          assert.equal(current.visibleLikedCount, 3);
          assert.ok(
            current.items.some((item) => item.targetId === anonRoot.id),
          );
          assert.ok(
            !current.items.some(
              (item) =>
                item.targetId === namedRoot.id ||
                item.targetId === namedReply.id ||
                item.targetId === anonReply.id ||
                item.targetId === exactOnly.id ||
                item.targetId === reverseAnonymous.id,
            ),
          );
          const unblock = await request(http)
            .put(`/v1/me/safety/blocks/${blocked.body.current.relationshipId}`)
            .set('Authorization', auth(peer))
            .send({
              clientRequestId: randomUUID(),
              expectedRevision: blocked.body.current.revision,
              blocked: false,
            });
          assert.equal(unblock.status, 200, JSON.stringify(unblock.body));
          assert.equal((await page()).visibleLikedCount, 8);
          await like('reply', exactOnly.id, false);
          await like('reply', reverseAnonymous.id, false);
          assert.equal((await page()).visibleLikedCount, 6);
        },
      );
      await t.test(
        'outgoing named parent blocks suppress their full chain without affecting an anonymous parent by the same account',
        async () => {
          const blocked = await request(http)
            .put('/v1/me/safety/blocks')
            .set('Authorization', auth())
            .send({
              clientRequestId: randomUUID(),
              source: { kind: 'post', id: named.id },
              blocked: true,
            });
          assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
          assert.equal(
            blocked.body.receipt.outcome,
            'applied',
            JSON.stringify(blocked.body),
          );
          try {
            const current = await page();
            assert.equal(current.visibleLikedCount, 4);
            assert.ok(
              current.items.every((item) => item.postId === anonymous.id),
            );
          } finally {
            const response = await request(http)
              .put(
                `/v1/me/safety/blocks/${blocked.body.current.relationshipId}`,
              )
              .set('Authorization', auth())
              .send({
                clientRequestId: randomUUID(),
                expectedRevision: blocked.body.current.revision,
                blocked: false,
              });
            assert.equal(response.status, 200, JSON.stringify(response.body));
          }
        },
      );
      await t.test(
        'candidate discovery does not lock likes before the parent; membership is re-read after unlike/re-like commits',
        async () => {
          const before = (await page()).items.find(
            (item) => item.targetId === named.id,
          )!;
          const writer = await pool.connect();
          let committed = false;
          try {
            await writer.query('BEGIN');
            const pid = (
              await writer.query<{ pid: number }>('SELECT pg_backend_pid() pid')
            ).rows[0]!.pid;
            await writer.query(
              'SELECT id FROM whaleu_community.posts WHERE id=$1 FOR UPDATE',
              [named.id],
            );
            const pending = list().then((value) => value);
            await waitForLock(
              pool,
              pid,
              'SELECT * FROM whaleu_community.posts%',
            );
            await writer.query(
              'DELETE FROM whaleu_community.post_likes WHERE post_id=$1 AND account_id=$2',
              [named.id, reader.accountId],
            );
            const fresh = (
              await writer.query<{ like_id: string }>(
                'INSERT INTO whaleu_community.post_likes(post_id,account_id) VALUES($1,$2) RETURNING like_id',
                [named.id, reader.accountId],
              )
            ).rows[0]!.like_id;
            await writer.query('COMMIT');
            committed = true;
            const response = await pending;
            assert.equal(response.status, 200, JSON.stringify(response.body));
            const returned = (response.body as LikedPage).items.find(
              (item) => item.targetId === named.id,
            )!;
            assert.equal(returned.likeId, fresh);
            assert.notEqual(returned.likeId, before.likeId);
          } finally {
            if (!committed) await writer.query('ROLLBACK');
            writer.release();
          }
        },
      );
      await t.test(
        'expiry while serializing the page fails closed instead of returning an expired policy projection',
        async () => {
          const expiring = await publish(
            'named',
            author,
            new Date(Date.now() + 2000),
          );
          await like('post', expiring.id);
          const serializer = app!.get(CommunitySerializer),
            original = serializer.images;
          serializer.images = async function (kind, id, tx, viewer) {
            if (id === expiring.id) await sleep(2100);
            return original.call(this, kind, id, tx, viewer);
          };
          try {
            const response = await list();
            assert.equal(response.status, 503, JSON.stringify(response.body));
            assert.equal(response.body.error.code, 'COMMUNITY_UNAVAILABLE');
          } finally {
            serializer.images = original;
          }
          await pool.query(
            'DELETE FROM whaleu_community.post_likes WHERE account_id=$1 AND post_id=$2',
            [reader.accountId, expiring.id],
          );
        },
      );
      await t.test(
        'revoked, expired and inactive-account sessions do not return even empty history',
        async () => {
          const revoked = await createRuntimeActor(app!),
            expired = await createRuntimeActor(app!),
            inactive = await createRuntimeActor(app!);
          await app!.get(IdentityService).logout(revoked.accessToken);
          await pool.query(
            "UPDATE whaleu_identity.access_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE session_id=$1",
            [expired.sessionId],
          );
          await pool.query(
            "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
            [inactive.accountId],
          );
          for (const [actor, code, status] of [
            [revoked, 'SESSION_REVOKED', 401],
            [expired, 'ACCESS_TOKEN_EXPIRED', 401],
            [inactive, 'ACCOUNT_BLOCKED', 403],
          ] as const) {
            const result = await list(20, undefined, actor);
            assert.equal(result.status, status);
            assert.equal(result.body.error.code, code);
          }
        },
      );
      await t.test(
        'required unknown-review candidate fails closed without fabricated totals even in large history',
        async () => {
          const overflow = await createRuntimeActor(app!);
          await pool.query(
            `WITH content AS (INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) SELECT gen_random_uuid(),$1,$2,'discussion','Synthetic bounded-candidate fixture','named','open' FROM generate_series(1,1025) RETURNING id) INSERT INTO whaleu_community.post_likes(post_id,account_id) SELECT id,$3 FROM content`,
            [scope.home.spaceId, author.accountId, overflow.accountId],
          );
          const response = await list(20, undefined, overflow);
          assert.equal(response.status, 503);
          assert.equal(response.body.error.code, 'COMMUNITY_UNAVAILABLE');
          assert.ok(
            !JSON.stringify(response.body).includes('visibleLikedCount'),
          );
        },
      );
    } finally {
      await app?.close();
      if (owns)
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
