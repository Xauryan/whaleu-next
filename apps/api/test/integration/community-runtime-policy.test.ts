import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.js';
import {
  DatabaseService,
  inTransaction,
  poolOptions,
  supportedPostgresVersion,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import { requireAction } from '../../src/community/community-policy.js';
import { configureHttp } from '../../src/http/http.js';
import { CommunityAccessService } from '../../src/community/community-access.service.js';
import { CommunityRepository } from '../../src/community/community.repository.js';
import { COMMUNITY_VISIBILITY } from '../../src/community/community-policy.js';
import type { CommunityVisibilityPort } from '../../src/community/community-policy.js';
import type {
  PublishPost,
  PublishComment,
} from '../../src/community/contracts.js';
import {
  createRuntimeActor,
  setRuntimeVerification,
  postApprovalEnvelope,
  discussionApprovalEnvelope,
} from '../support/community-runtime-fixtures.js';
import {
  seedCommunityScope,
  appendIdentitySelection,
  setRegionPolicy,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';
import {
  approveEnvelope,
  setReviewState,
  seedReviewPolicy,
} from '../support/community-approval-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

/** Normal AppModule: no policy, visibility, media, safety, identity or review substitute. */
test(
  'normal runtime canonical text publication, interactions and exact approval visibility',
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
        'Refusing existing WhaleU schemas',
      );
      owns = true;
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
      await app.init();
      const http = app.getHttpServer(),
        runtime = app;
      const author = await createRuntimeActor(app),
        reader = await createRuntimeActor(app),
        phoneOnly = await createRuntimeActor(app),
        unverified = await createRuntimeActor(app),
        unknown = await createRuntimeActor(app);
      const auth = (actor = author) => `Bearer ${actor.accessToken}`;
      await t.test(
        'startup and new native sessions do not create authority or review facts',
        async () => {
          for (const table of [
            'whaleu_verification.assertions',
            'whaleu_authorization.role_grants',
            'whaleu_campus.community_topology_heads',
            'whaleu_campus.community_identity_heads',
            'whaleu_community.region_policy_heads',
            'whaleu_community.content_approval_decisions',
          ])
            assert.equal(
              (
                await pool.query<{ n: number }>(
                  `SELECT count(*)::integer n FROM ${table}`,
                )
              ).rows[0]!.n,
              0,
              table,
            );
          const r = await request(http)
            .post('/v1/auth/wechat/login')
            .send({ code: 'no-provider-bypass' });
          assert.notEqual(r.status, 200);
        },
      );
      const scope = await seedCommunityScope(pool);
      await seedReviewPolicy(pool);
      const certify = async (
        actor = author,
        campusId = scope.home.campusId,
      ) => {
        const facts = await setRuntimeVerification(
          pool,
          actor.accountId,
          scope.institutionId,
          scope.home.regionId,
        );
        await appendIdentitySelection(
          pool,
          actor.accountId,
          facts,
          scope,
          campusId,
        );
        return facts;
      };
      await certify();
      await certify(reader);
      await setRuntimeVerification(
        pool,
        phoneOnly.accountId,
        scope.institutionId,
        scope.home.regionId,
        'unavailable',
      );
      await setRuntimeVerification(
        pool,
        unverified.accountId,
        scope.institutionId,
        scope.home.regionId,
        'unverified',
      );
      const body = (patch: Partial<PublishPost> = {}): PublishPost => ({
        clientRequestId: randomUUID(),
        spaceId: scope.home.spaceId,
        category: 'discussion',
        text: `approved text ${randomUUID()}`,
        imageAssetIds: [],
        authorMode: 'named',
        commentsPolicy: 'open',
        ...patch,
      });
      const publish = async (input: PublishPost, actor = author) =>
        request(http)
          .post('/v1/community/posts')
          .set('Authorization', auth(actor))
          .send(input)
          .then((r) => {
            if (r.body.error) r.body.code = r.body.error.code;
            return r;
          });
      const approve = async (
        input: PublishPost,
        actor = author,
        options = {},
      ) =>
        approveEnvelope(
          pool,
          await postApprovalEnvelope(runtime, pool, actor.accountId, input),
          options,
        );
      const accepted = async (input: PublishPost, actor = author) => {
        const approval = await approve(input, actor);
        const r = await publish(input, actor);
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.equal(r.body.outcome, 'created', JSON.stringify(r.body));
        return { id: r.body.resourceId as string, approval, receipt: r.body };
      };
      const detail = async (id: string, actor = reader) =>
        request(http)
          .get(`/v1/community/posts/${id}`)
          .set('Authorization', auth(actor))
          .then((r) => {
            if (r.body.error) r.body.code = r.body.error.code;
            return r;
          });
      let named: string, anonymous: string, rootId: string, replyId: string;
      await t.test(
        'missing approval is transient, capability distinguishes review availability, and exact retry binds once',
        async () => {
          const input = body();
          assert.equal(
            (await publish(input)).body.code,
            'CONTENT_REVIEW_UNAVAILABLE',
          );
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM whaleu_community.publication_requests WHERE client_request_id=$1',
                [input.clientRequestId],
              )
            ).rowCount,
            0,
          );
          const cap = await request(http)
            .get('/v1/community/capabilities')
            .query({ spaceId: scope.home.spaceId, category: 'discussion' })
            .set('Authorization', auth());
          assert.deepEqual(cap.body.publish, {
            availability: 'unavailable',
            reason: 'CONTENT_REVIEW_UNAVAILABLE',
          });
          assert.deepEqual(cap.body.authorModes, ['named', 'anonymous']);
          const created = await accepted(input);
          named = created.id;
          assert.deepEqual((await publish(input)).body, created.receipt);
          assert.equal(
            (await publish({ ...input, text: 'changed intent' })).body.code,
            'REQUEST_CONFLICT',
          );
          assert.equal(
            (
              await pool.query(
                'SELECT * FROM whaleu_community.content_approval_bindings WHERE content_id=$1',
                [named],
              )
            ).rowCount,
            1,
          );
          const view = await detail(named);
          assert.equal(view.status, 200);
          assert.equal(view.body.text, input.text);
          assert.equal(view.body.viewer.canComment, false);
        },
      );
      await t.test(
        'home and related anonymous succeed; same-institution foreign anonymous fails; named foreign and global succeed',
        async () => {
          anonymous = (await accepted(body({ authorMode: 'anonymous' }))).id;
          await accepted(
            body({ spaceId: scope.related.spaceId, authorMode: 'anonymous' }),
          );
          const denied = await publish(
            body({ spaceId: scope.foreign.spaceId, authorMode: 'anonymous' }),
          );
          assert.equal(denied.body.code, 'AUTHOR_MODE_NOT_ALLOWED');
          await accepted(body({ spaceId: scope.foreign.spaceId }));
          await accepted(body({ spaceId: scope.global.spaceId }));
          assert.equal(
            (
              await publish(
                body({ spaceId: scope.global.spaceId, category: 'pets' }),
              )
            ).body.code,
            'COMMUNITY_SCOPE_UNAVAILABLE',
          );
          const r = await request(http)
            .post('/v1/community/posts')
            .set('Authorization', auth())
            .send({ ...body(), syncRelated: true });
          assert.equal(r.status, 400);
        },
      );
      await t.test(
        'roots and replies bind exact parent and forced effective mode; foreign anonymous comments remain valid',
        async () => {
          const foreign = (
            await accepted(body({ spaceId: scope.foreign.spaceId }))
          ).id;
          const root: PublishComment = {
            clientRequestId: randomUUID(),
            text: 'cross-region anonymous root',
            imageAssetIds: [],
            authorMode: 'anonymous',
          };
          await approveEnvelope(
            pool,
            await discussionApprovalEnvelope(
              runtime,
              pool,
              reader.accountId,
              foreign,
              root,
            ),
          );
          const r = await request(http)
            .post(`/v1/community/posts/${foreign}/comments`)
            .set('Authorization', auth(reader))
            .send(root);
          assert.equal(r.body.outcome, 'created', JSON.stringify(r.body));
          rootId = r.body.resourceId;
          const reply = {
            ...root,
            clientRequestId: randomUUID(),
            text: 'cross-region reply',
            targetReplyId: null,
          };
          await approveEnvelope(
            pool,
            await discussionApprovalEnvelope(
              runtime,
              pool,
              reader.accountId,
              foreign,
              reply,
              rootId,
            ),
          );
          const rr = await request(http)
            .post(`/v1/community/comments/${rootId}/replies`)
            .set('Authorization', auth(reader))
            .send(reply);
          assert.equal(rr.body.outcome, 'created', JSON.stringify(rr.body));
          replyId = rr.body.resourceId;
          const own = {
            ...root,
            clientRequestId: randomUUID(),
            authorMode: 'named' as const,
            text: 'own anonymous forced',
          };
          await approveEnvelope(
            pool,
            await discussionApprovalEnvelope(
              runtime,
              pool,
              author.accountId,
              anonymous,
              own,
            ),
          );
          const forced = await request(http)
            .post(`/v1/community/posts/${anonymous}/comments`)
            .set('Authorization', auth())
            .send(own);
          assert.equal(forced.body.outcome, 'created');
          assert.equal(
            (
              await pool.query(
                'SELECT author_mode FROM whaleu_community.root_comments WHERE id=$1',
                [forced.body.resourceId],
              )
            ).rows[0].author_mode,
            'anonymous',
          );
          const wrongParent = await request(http)
            .post(`/v1/community/posts/${named}/comments`)
            .set('Authorization', auth(reader))
            .send({ ...root, clientRequestId: randomUUID() });
          assert.equal(
            wrongParent.body.error?.code,
            'CONTENT_REVIEW_UNAVAILABLE',
          );
          assert.equal((await detail(foreign)).body.replyCount, 1);
        },
      );
      await t.test(
        'phone-only actor can read, like, save and vote without affiliation, but cannot publish',
        async () => {
          assert.equal((await detail(named, phoneOnly)).status, 200);
          assert.equal(
            (
              await request(http)
                .put(`/v1/community/posts/${named}/like`)
                .set('Authorization', auth(phoneOnly))
            ).status,
            200,
          );
          const saved = await request(http)
            .put(`/v1/community/posts/${named}/save`)
            .set('Authorization', auth(phoneOnly))
            .send({ clientRequestId: randomUUID() });
          assert.equal(
            saved.body.outcome,
            'applied',
            JSON.stringify(saved.body),
          );
          assert.equal(
            (await publish(body(), phoneOnly)).body.code,
            'COMMUNITY_UNAVAILABLE',
          );
          const poll = (
            await accepted(
              body({
                component: {
                  kind: 'poll',
                  question: 'Choose',
                  selectionMode: 'single',
                  options: ['A', 'B'],
                },
              }),
            )
          ).id;
          const view = await detail(poll, phoneOnly);
          const ballot = await request(http)
            .post(`/v1/community/posts/${poll}/poll/ballots`)
            .set('Authorization', auth(phoneOnly))
            .send({
              clientRequestId: randomUUID(),
              optionIds: [view.body.component.poll.options[0].id],
            });
          assert.equal(
            ballot.body.outcome,
            'created',
            JSON.stringify(ballot.body),
          );
          assert.equal(
            (await publish(body(), unknown)).body.code,
            'COMMUNITY_UNAVAILABLE',
          );
        },
      );
      await t.test(
        'explicit unverified switches differ from missing facts; anonymous parent and global exceptions stay denied',
        async () => {
          assert.equal(
            (await publish(body(), unverified)).body.code,
            'COMMUNITY_UNAVAILABLE',
          );
          await setRegionPolicy(pool, scope.home.regionId, {
            unverifiedPostEnabled: false,
            unverifiedCommentEnabled: false,
            unverifiedCategories: ['discussion'],
          });
          assert.equal(
            (await publish(body(), unverified)).body.code,
            'STUDENT_VERIFICATION_REQUIRED',
          );
          await setRegionPolicy(pool, scope.home.regionId, {
            unverifiedPostEnabled: true,
            unverifiedCommentEnabled: true,
            unverifiedCategories: ['discussion'],
          });
          await accepted(body(), unverified);
          assert.equal(
            (await publish(body({ authorMode: 'anonymous' }), unverified)).body
              .code,
            'AUTHOR_MODE_NOT_ALLOWED',
          );
          assert.equal(
            (await publish(body({ category: 'pets' }), unverified)).body.code,
            'STUDENT_VERIFICATION_REQUIRED',
          );
          assert.equal(
            (await publish(body({ spaceId: scope.global.spaceId }), unverified))
              .body.code,
            'STUDENT_VERIFICATION_REQUIRED',
          );
          const comment = {
            clientRequestId: randomUUID(),
            text: 'known unverified root',
            imageAssetIds: [],
            authorMode: 'named' as const,
          };
          await approveEnvelope(
            pool,
            await discussionApprovalEnvelope(
              runtime,
              pool,
              unverified.accountId,
              named,
              comment,
            ),
          );
          assert.equal(
            (
              await request(http)
                .post(`/v1/community/posts/${named}/comments`)
                .set('Authorization', auth(unverified))
                .send(comment)
            ).body.outcome,
            'created',
          );
          assert.equal(
            (
              await request(http)
                .post(`/v1/community/posts/${anonymous}/comments`)
                .set('Authorization', auth(unverified))
                .send({ ...comment, clientRequestId: randomUUID() })
            ).body.code,
            'AUTHOR_MODE_NOT_ALLOWED',
          );
        },
      );
      await t.test(
        'scope, mode, account, text and components cannot share an exact approval',
        async () => {
          const input = body();
          await approve(input);
          for (const patch of [
            { text: 'different' },
            { authorMode: 'anonymous' },
            { spaceId: scope.related.spaceId },
            { category: 'pets' },
            {
              component: {
                kind: 'poll',
                question: 'Q',
                selectionMode: 'single',
                options: ['A', 'B'],
              },
            },
          ])
            assert.equal(
              (
                await publish({
                  ...input,
                  ...patch,
                  clientRequestId: randomUUID(),
                } as PublishPost)
              ).body.code,
              'CONTENT_REVIEW_UNAVAILABLE',
            );
          assert.equal(
            (await publish({ ...input, clientRequestId: randomUUID() }, reader))
              .body.code,
            'CONTENT_REVIEW_UNAVAILABLE',
          );
          assert.equal(
            (
              await publish({
                ...input,
                imageAssetIds: [randomUUID()],
                clientRequestId: randomUUID(),
              })
            ).body.code,
            'MEDIA_UNAVAILABLE',
          );
          const r = await publish(input);
          assert.equal(r.body.outcome, 'created');
        },
      );
      await t.test(
        'historic approved rows remain unavailable and typed UUID identity cannot cross tables',
        async () => {
          const legacy = randomUUID();
          await pool.query(
            `INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,$4,$5,$6,'open')`,
            [
              legacy,
              scope.home.spaceId,
              author.accountId,
              'discussion',
              'no review',
              'named',
            ],
          );
          assert.equal(
            (await detail(legacy)).body.code,
            'COMMUNITY_UNAVAILABLE',
          );
          const wrong = await inTransaction(pool, (tx) =>
            runtime.get<CommunityVisibilityPort>(COMMUNITY_VISIBILITY).check(
              reader.accountId,
              {
                contentId: named,
                contentKind: 'comment',
                contentVersion: 1,
                authorMode: 'named',
                namedAccountId: author.accountId,
              },
              tx,
              'direct_post',
            ),
          );
          assert.notEqual(wrong.kind, 'allow');
          await pool.query(
            'UPDATE whaleu_community.posts SET deleted_at=clock_timestamp() WHERE id=$1',
            [legacy],
          );
        },
      );
      await t.test(
        'consume expiry does not erase visible accepted content; held/revoked binding stops all direct visibility',
        async () => {
          const input = body();
          const approval = await approve(input, author, {
            consumeUntil: new Date(Date.now() + 700),
          });
          const r = await publish(input);
          assert.equal(r.body.outcome, 'created', JSON.stringify(r.body));
          await sleep(800);
          assert.equal((await detail(r.body.resourceId)).status, 200);
          assert.deepEqual((await publish(input)).body, r.body);
          await setReviewState(pool, approval.decisionId, 'held');
          assert.equal((await detail(r.body.resourceId)).status, 404);
          assert.deepEqual((await publish(input)).body, r.body);
          await setReviewState(pool, approval.decisionId, 'revoked');
          assert.equal((await detail(r.body.resourceId)).status, 404);
          await assert.rejects(
            pool.query(
              'UPDATE whaleu_community.posts SET text=$2 WHERE id=$1',
              [named, 'mutated reviewed payload'],
            ),
          );
        },
      );
      await t.test(
        'named directional blocks and anonymous noninterference use real safety wrapper',
        async () => {
          const block = await request(http)
            .put('/v1/me/safety/blocks')
            .set('Authorization', auth(reader))
            .send({
              clientRequestId: randomUUID(),
              source: { kind: 'post', id: named },
              blocked: true,
            });
          assert.equal(
            block.body.receipt.outcome,
            'applied',
            JSON.stringify(block.body),
          );
          assert.equal((await detail(named)).body.code, 'POST_BLOCKED_BY_YOU');
          assert.equal((await detail(anonymous)).status, 200);
          const like = await request(http)
            .put(`/v1/community/posts/${named}/like`)
            .set('Authorization', auth(reader));
          assert.equal(like.status, 404);
          const state = block.body.current;
          const unblock = await request(http)
            .put(`/v1/me/safety/blocks/${state.relationshipId}`)
            .set('Authorization', auth(reader))
            .send({
              clientRequestId: randomUUID(),
              blocked: false,
              expectedRevision: state.revision,
            });
          assert.equal(unblock.body.receipt.outcome, 'applied');
          assert.equal((await detail(named)).status, 200);
        },
      );
      await t.test(
        'real report intake and author removal retain minimal publication receipts',
        async () => {
          const r = await request(http)
            .post('/v1/me/safety/reports')
            .set('Authorization', auth(reader))
            .send({
              clientRequestId: randomUUID(),
              target: { kind: 'post', id: named },
            });
          assert.equal(r.body.outcome, 'accepted', JSON.stringify(r.body));
          assert.equal(
            (
              await request(http)
                .delete(`/v1/community/posts/${named}`)
                .set('Authorization', auth())
            ).status,
            204,
          );
          assert.equal((await detail(named)).status, 404);
          assert.ok(rootId);
          assert.ok(replyId);
        },
      );
      await t.test(
        'selection replacement and explicit selection-required are distinct from unknown',
        async () => {
          const changed = await setRuntimeVerification(
            pool,
            author.accountId,
            scope.institutionId,
            scope.home.regionId,
          );
          assert.equal(
            (await publish(body())).body.code,
            'COMMUNITY_UNAVAILABLE',
          );
          await appendIdentitySelection(
            pool,
            author.accountId,
            changed,
            scope,
            scope.home.campusId,
            'selection_required',
          );
          assert.equal(
            (await publish(body())).body.code,
            'IDENTITY_CAMPUS_REQUIRED',
          );
          await appendIdentitySelection(
            pool,
            author.accountId,
            changed,
            scope,
            scope.foreign.campusId,
          );
          assert.equal(
            (await publish(body())).body.code,
            'COMMUNITY_UNAVAILABLE',
          );
          await appendIdentitySelection(
            pool,
            author.accountId,
            changed,
            scope,
            scope.related.campusId,
          );
          await accepted(body({ authorMode: 'anonymous' }));
        },
      );
      await t.test(
        'role grants do not confer affiliation, fixed-region restricted-post control differs from global origin management',
        async () => {
          const grant = async (
            actor = reader,
            role = 'school_admin',
            region: string | null = scope.home.regionId,
          ) =>
            withCommunityScopeWriter(pool, (tx) =>
              tx.query(
                "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,$3,$4,$2,'synthetic-runtime-only')",
                [randomUUID(), actor.accountId, role, region],
              ),
            );
          await grant();
          const restricted = (
            await accepted(body({ commentsPolicy: 'restricted' }), reader)
          ).id;
          assert.equal(
            (
              await publish(
                body({
                  spaceId: scope.related.spaceId,
                  commentsPolicy: 'restricted',
                }),
                reader,
              )
            ).body.code,
            'COMMUNITY_ACTION_RESTRICTED',
          );
          assert.equal(
            (
              await publish(
                body({
                  spaceId: scope.global.spaceId,
                  commentsPolicy: 'restricted',
                }),
                reader,
              )
            ).body.code,
            'COMMUNITY_ACTION_RESTRICTED',
          );
          await grant(phoneOnly, 'super_admin', null);
          assert.equal(
            (await publish(body(), phoneOnly)).body.code,
            'COMMUNITY_UNAVAILABLE',
          );
          const global = await accepted(
            body({ spaceId: scope.global.spaceId }),
          );
          const relation = await inTransaction(pool, async (tx) =>
            runtime
              .get(CommunityAccessService)
              .authority(
                reader.accountId,
                await runtime
                  .get(CommunityRepository)
                  .space(scope.global.spaceId, tx),
                tx,
                { targetPostId: global.id },
              ),
          );
          assert.equal(relation.canManage, true);
          assert.equal(relation.canDisableComments, false);
          const c = {
            clientRequestId: randomUUID(),
            text: 'restricted ordinary reader',
            imageAssetIds: [],
            authorMode: 'named',
          };
          assert.equal(
            (
              await request(http)
                .post(`/v1/community/posts/${restricted}/comments`)
                .set('Authorization', auth())
                .send(c)
            ).body.code,
            'COMMENTS_DISABLED',
          );
        },
      );
      await t.test(
        'guest first-ten preview and phone-only continuation preserve unavailable facts',
        async () => {
          for (let i = 0; i < 12; i++)
            await accepted(body({ text: `preview fixture ${i}` }));
          const guest = await request(http)
            .get('/v1/community/posts')
            .query({ spaceId: scope.home.spaceId });
          assert.equal(guest.status, 200, JSON.stringify(guest.body));
          assert.equal(guest.body.items.length, 10);
          assert.equal(guest.body.continuation, 'login_required');
          assert.equal(guest.body.nextCursor, null);
          const first = await request(http)
            .get('/v1/community/posts')
            .query({ spaceId: scope.home.spaceId })
            .set('Authorization', auth(phoneOnly));
          assert.equal(first.body.continuation, 'available');
          assert.ok(first.body.nextCursor);
          const next = await request(http)
            .get('/v1/community/posts')
            .query({
              spaceId: scope.home.spaceId,
              cursor: first.body.nextCursor,
            })
            .set('Authorization', auth(phoneOnly));
          assert.equal(next.status, 200);
          const missing = await request(http)
            .get('/v1/community/posts')
            .query({ spaceId: scope.home.spaceId })
            .set('Authorization', auth(unknown));
          assert.equal(missing.body.error.code, 'COMMUNITY_UNAVAILABLE');
          assert.equal(
            (
              await pool.query(
                "SELECT * FROM whaleu_verification.assertions WHERE fact_kind='student_number'",
              )
            ).rowCount,
            0,
            'Neither authority nor fixtures need student numbers',
          );
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              'UPDATE whaleu_safety.account_heads SET actions_allowed=false WHERE account_id=$1',
              [phoneOnly.accountId],
            ),
          );
          const restricted = await request(http)
            .get('/v1/community/posts')
            .query({
              spaceId: scope.home.spaceId,
              cursor: first.body.nextCursor,
            })
            .set('Authorization', auth(phoneOnly));
          assert.equal(
            restricted.status,
            200,
            'Action restriction does not deny ordinary phone-authorized reads',
          );
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              'UPDATE whaleu_safety.account_heads SET actions_allowed=true WHERE account_id=$1',
              [phoneOnly.accountId],
            ),
          );
        },
      );
      await t.test(
        'advisory phone expiry does not abort ordinary read, while required interaction expiry does',
        async () => {
          const ephemeral = await createRuntimeActor(runtime);
          await setRuntimeVerification(
            pool,
            ephemeral.accountId,
            scope.institutionId,
            scope.home.regionId,
            'unavailable',
            'verified',
            new Date(Date.now() + 350),
          );
          const databaseService = runtime.get(DatabaseService),
            access = runtime.get(CommunityAccessService),
            repository = runtime.get(CommunityRepository);
          await databaseService.transaction(async (tx) => {
            await access.actor(ephemeral.accessToken, tx);
            const space = await repository.space(scope.home.spaceId, tx);
            assert.equal(
              (await access.advisory(ephemeral.accountId, space, tx))
                ?.phoneVerified,
              true,
            );
            await tx.query('SELECT pg_sleep(0.45)');
          });
          await setRuntimeVerification(
            pool,
            ephemeral.accountId,
            scope.institutionId,
            scope.home.regionId,
            'unavailable',
            'verified',
            new Date(Date.now() + 350),
          );
          await assert.rejects(
            databaseService.transaction(async (tx) => {
              await access.actor(ephemeral.accessToken, tx);
              const space = await repository.space(scope.home.spaceId, tx);
              requireAction(
                await access.authority(ephemeral.accountId, space, tx),
                'like',
              );
              await tx.query('SELECT pg_sleep(0.45)');
            }),
            (e) =>
              (e as { code?: string }).code === 'PHONE_VERIFICATION_REQUIRED',
          );
        },
      );
      await t.test(
        'deferred-constraint wait past approval consume deadline rolls back content, binding, outbox and receipt',
        async () => {
          await pool.query(`CREATE FUNCTION whaleu_community.runtime_test_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.7); RETURN NEW; END $$;
        CREATE CONSTRAINT TRIGGER runtime_test_wait AFTER INSERT ON whaleu_community.posts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.runtime_test_wait()`);
          const input = body();
          try {
            const approval = await approve(input, author, {
              consumeUntil: new Date(Date.now() + 450),
            });
            const r = await publish(input);
            assert.equal(
              r.body.code,
              'CONTENT_REVIEW_UNAVAILABLE',
              JSON.stringify(r.body),
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT * FROM whaleu_community.content_approval_bindings WHERE decision_id=$1',
                  [approval.decisionId],
                )
              ).rowCount,
              0,
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT * FROM whaleu_community.publication_requests WHERE client_request_id=$1',
                  [input.clientRequestId],
                )
              ).rowCount,
              0,
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT * FROM whaleu_community.posts WHERE text=$1',
                  [input.text],
                )
              ).rowCount,
              0,
            );
          } finally {
            await pool.query(
              'DROP TRIGGER runtime_test_wait ON whaleu_community.posts; DROP FUNCTION whaleu_community.runtime_test_wait()',
            );
          }
        },
      );
      await t.test(
        'concurrent approval hold is observed before a waiting publication can consume it',
        async () => {
          const input = body(),
            approval = await approve(input);
          const writer = await pool.connect();
          await writer.query('BEGIN');
          await lockSafetyPolicy(writer, true);
          try {
            const eventId = randomUUID();
            await writer.query(
              `INSERT INTO whaleu_community.content_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at)
          VALUES($1,$2,'held','complete','accepted','synthetic-test','synthetic-hold',clock_timestamp())`,
              [eventId, approval.decisionId],
            );
            await writer.query(
              'UPDATE whaleu_community.content_approval_heads SET event_id=$2 WHERE decision_id=$1',
              [approval.decisionId, eventId],
            );
            let settled = false;
            const pending = publish(input).then((r) => {
              settled = true;
              return r;
            });
            await sleep(50);
            assert.equal(
              settled,
              false,
              'Publication must wait on shared policy gate',
            );
            await writer.query('COMMIT');
            assert.equal(
              (await pending).body.code,
              'CONTENT_REVIEW_UNAVAILABLE',
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT * FROM whaleu_community.content_approval_bindings WHERE decision_id=$1',
                  [approval.decisionId],
                )
              ).rowCount,
              0,
            );
          } finally {
            await writer.query('ROLLBACK');
            writer.release();
          }
        },
      );
      await t.test(
        'concurrent identity campus deactivation is observed before a waiting publication',
        async () => {
          const input = body();
          await approve(input);
          const writer = await pool.connect();
          await writer.query('BEGIN');
          await lockSafetyPolicy(writer, true);
          try {
            await writer.query(
              'UPDATE whaleu_campus.campuses SET is_active=false WHERE id=$1',
              [scope.related.campusId],
            );
            let settled = false;
            const pending = publish(input).then((r) => {
              settled = true;
              return r;
            });
            await sleep(50);
            assert.equal(settled, false);
            await writer.query('COMMIT');
            assert.equal((await pending).body.code, 'COMMUNITY_UNAVAILABLE');
          } finally {
            await writer.query('ROLLBACK');
            writer.release();
            await withCommunityScopeWriter(pool, (tx) =>
              tx.query(
                'UPDATE whaleu_campus.campuses SET is_active=true WHERE id=$1',
                [scope.related.campusId],
              ),
            );
          }
        },
      );
      await t.test(
        'regional policy replacement invalidates unconsumed approval even when effective switches stay enabled',
        async () => {
          const input = body();
          await approve(input, unverified);
          await setRegionPolicy(pool, scope.home.regionId, {
            unverifiedPostEnabled: true,
            unverifiedCommentEnabled: true,
            unverifiedCategories: ['discussion'],
          });
          assert.equal(
            (await publish(input, unverified)).body.code,
            'CONTENT_REVIEW_UNAVAILABLE',
          );
          await approve(input, unverified);
          assert.equal(
            (await publish(input, unverified)).body.outcome,
            'created',
          );
        },
      );
      await t.test(
        'real reviewed formation retains visibility through phone-only membership, contacts and typed named-member filtering',
        async () => {
          const formed = await accepted(
            body({
              authorMode: 'anonymous',
              component: {
                kind: 'formation',
                capacity: 3,
                theme: 'Text meetup',
                contacts: { wechat: 'creator-contact', qq: '', phone: '' },
                contactSharing: 'members_v1',
              },
            }),
          );
          const join = async (actor: typeof author, contact: string) =>
            request(http)
              .post(`/v1/community/posts/${formed.id}/formation/memberships`)
              .set('Authorization', auth(actor))
              .send({
                clientRequestId: randomUUID(),
                contacts: { wechat: contact, qq: '', phone: '' },
                contactSharing: 'members_v1',
              });
          const joined = await join(phoneOnly, 'phone-only-contact');
          assert.equal(
            joined.body.outcome,
            'created',
            JSON.stringify(joined.body),
          );
          assert.equal(
            (await join(reader, 'reader-contact')).body.outcome,
            'created',
          );
          const view = await detail(formed.id, phoneOnly);
          assert.equal(view.status, 200);
          assert.equal(view.body.component.formation.memberCount, 3);
          const contacts = await request(http)
            .get(`/v1/community/posts/${formed.id}/formation/contacts`)
            .set('Authorization', auth(phoneOnly));
          assert.equal(
            contacts.body.members.length,
            3,
            JSON.stringify(contacts.body),
          );
          const readerPost = (await accepted(body(), reader)).id;
          const block = await request(http)
            .put('/v1/me/safety/blocks')
            .set('Authorization', auth(phoneOnly))
            .send({
              clientRequestId: randomUUID(),
              source: { kind: 'post', id: readerPost },
              blocked: true,
            });
          assert.equal(block.body.receipt.outcome, 'applied');
          const filtered = await detail(formed.id, phoneOnly);
          assert.equal(filtered.status, 200);
          assert.equal(filtered.body.component.formation.memberCount, 3);
          assert.equal(filtered.body.component.formation.members.length, 2);
          assert.equal(
            filtered.body.component.formation.members[0].author.kind,
            'anonymous',
          );
          const filteredContacts = await request(http)
            .get(`/v1/community/posts/${formed.id}/formation/contacts`)
            .set('Authorization', auth(phoneOnly));
          assert.equal(filteredContacts.body.members.length, 2);
          const current = block.body.current;
          await request(http)
            .put(`/v1/me/safety/blocks/${current.relationshipId}`)
            .set('Authorization', auth(phoneOnly))
            .send({
              clientRequestId: randomUUID(),
              blocked: false,
              expectedRevision: current.revision,
            });
          assert.equal(
            (await detail(formed.id, phoneOnly)).body.component.formation
              .memberCount,
            3,
          );
        },
      );
      await t.test(
        'real reviewed trading definitions survive owner resolution and unverified named comments',
        async () => {
          const input = body({
            category: 'trading',
            trading: {
              subtype: 'shuma',
              price: '12.50',
              urgency: 'normal',
              location: 'Synthetic public location',
              contacts: { wechat: 'chosen-public-contact', qq: '', phone: '' },
            },
          });
          const listing = await accepted(input);
          const view = await detail(listing.id);
          assert.equal(view.status, 200, JSON.stringify(view.body));
          assert.equal(view.body.trading.price.amount, '12.5');
          const resolved = await request(http)
            .post(`/v1/community/posts/${listing.id}/trading/resolution`)
            .set('Authorization', auth())
            .send({ clientRequestId: randomUUID(), resolution: 'resolved' });
          assert.equal(
            resolved.body.outcome,
            'applied',
            JSON.stringify(resolved.body),
          );
          assert.equal(
            (await detail(listing.id)).body.trading.resolution,
            'resolved',
          );
          const c = {
            clientRequestId: randomUUID(),
            text: 'unverified named trading comment',
            authorMode: 'named' as const,
            imageAssetIds: [],
          };
          await approveEnvelope(
            pool,
            await discussionApprovalEnvelope(
              runtime,
              pool,
              unverified.accountId,
              listing.id,
              c,
            ),
          );
          assert.equal(
            (
              await request(http)
                .post(`/v1/community/posts/${listing.id}/comments`)
                .set('Authorization', auth(unverified))
                .send(c)
            ).body.outcome,
            'created',
          );
        },
      );
      await t.test(
        'SQL prevents late assets/components and marker rewrite while explicit reject differs from pending review',
        async () => {
          const plain = await accepted(body());
          await assert.rejects(
            pool.query(
              'INSERT INTO whaleu_community.post_images(post_id,asset_id,digest,position) VALUES($1,$2,$3,0)',
              [plain.id, randomUUID(), 'a'.repeat(64)],
            ),
          );
          await assert.rejects(
            pool.query(
              "INSERT INTO whaleu_community.polls(id,post_id,question,selection_mode) VALUES($1,$2,'late','single')",
              [randomUUID(), plain.id],
            ),
          );
          await assert.rejects(
            pool.query(
              'UPDATE whaleu_community.posts SET publication_transaction=pg_current_xact_id() WHERE id=$1',
              [plain.id],
            ),
          );
          await assert.rejects(
            pool.query(
              'UPDATE whaleu_community.root_comments SET approval_publication_transaction=pg_current_xact_id() WHERE id=$1',
              [rootId],
            ),
          );
          assert.equal((await detail(plain.id)).status, 200);
          for (const result of ['pending', 'failed', 'reject'] as const) {
            const input = body();
            await approve(input, author, { result });
            const r = await publish(input);
            assert.equal(
              r.body.code,
              result === 'reject'
                ? 'CONTENT_REJECTED'
                : 'CONTENT_REVIEW_UNAVAILABLE',
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT * FROM whaleu_community.publication_requests WHERE client_request_id=$1',
                  [input.clientRequestId],
                )
              ).rowCount,
              result === 'reject' ? 1 : 0,
            );
          }
        },
      );
      await t.test(
        'only consumed management exceptions register role expiry at final deferred checks',
        async () => {
          const makeAdmin = async () => {
            const actor = await createRuntimeActor(runtime);
            await certify(actor);
            await withCommunityScopeWriter(pool, (tx) =>
              tx.query(
                `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference,expires_at)
            VALUES($1,$2,'school_admin',$3,$2,'synthetic-expiring-role',$4)`,
                [
                  randomUUID(),
                  actor.accountId,
                  scope.home.regionId,
                  new Date(Date.now() + 650),
                ],
              ),
            );
            return actor;
          };
          await pool.query(`CREATE FUNCTION whaleu_community.runtime_test_role_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.8); RETURN NEW; END $$;
          CREATE CONSTRAINT TRIGGER runtime_test_role_wait AFTER INSERT ON whaleu_community.posts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION whaleu_community.runtime_test_role_wait()`);
          try {
            const ordinaryAdmin = await makeAdmin(),
              open = body();
            await approve(open, ordinaryAdmin);
            const allowed = await publish(open, ordinaryAdmin);
            assert.equal(
              allowed.body.outcome,
              'created',
              JSON.stringify(allowed.body),
            );
            assert.equal((await detail(allowed.body.resourceId)).status, 200);
            const managingAdmin = await makeAdmin(),
              restricted = body({ commentsPolicy: 'restricted' });
            await approve(restricted, managingAdmin);
            const denied = await publish(restricted, managingAdmin);
            assert.equal(
              denied.body.code,
              'AUTHORIZATION_REQUIRED',
              JSON.stringify(denied.body),
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT * FROM whaleu_community.publication_requests WHERE client_request_id=$1',
                  [restricted.clientRequestId],
                )
              ).rowCount,
              0,
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT * FROM whaleu_community.posts WHERE text=$1',
                  [restricted.text],
                )
              ).rowCount,
              0,
            );
          } finally {
            await pool.query(
              'DROP TRIGGER runtime_test_role_wait ON whaleu_community.posts; DROP FUNCTION whaleu_community.runtime_test_role_wait()',
            );
          }
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
