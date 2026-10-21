import type { PublishReply } from '../../src/community/discussion/contracts.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
} from '../support/community-scope-fixtures.js';
import {
  approveEnvelope,
  seedReviewPolicy,
} from '../support/community-approval-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

// Real AppModule and canonical owner records only, with deterministic database
// waits. No provider, application policy or visibility replacements are installed.
test(
  'Owner publications real HTTP identity partitions, replies, cursor scope and visibility',
  { timeout: 120000 },
  async () => {
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
      const http = app.getHttpServer();
      const author = await createRuntimeActor(app),
        reader = await createRuntimeActor(app);
      const auth = (actor = reader) => `Bearer ${actor.accessToken}`;
      const scope = await seedCommunityScope(pool);
      await seedReviewPolicy(pool);
      const facts = await setRuntimeVerification(
        pool,
        author.accountId,
        scope.institutionId,
        scope.home.regionId,
      );
      await appendIdentitySelection(
        pool,
        author.accountId,
        facts,
        scope,
        scope.home.campusId,
      );
      const publish = async (
        text = 'Synthetic current profile post',
        actor = author,
        visibilityUntil: Date | null = null,
        authorMode: 'named' | 'anonymous' = 'named',
      ) => {
        const input: PublishPost = {
          clientRequestId: randomUUID(),
          spaceId: scope.home.spaceId,
          category: 'discussion',
          text,
          imageAssetIds: [],
          authorMode,
          commentsPolicy: 'open',
        };
        const approval = await approveEnvelope(
          pool,
          await postApprovalEnvelope(app!, pool, actor.accountId, input),
          { visibilityUntil },
        );
        const response = await request(http)
          .post('/v1/community/posts')
          .set('Authorization', auth(actor))
          .send(input);
        assert.equal(response.status, 201, JSON.stringify(response.body));
        assert.equal(
          response.body.outcome,
          'created',
          JSON.stringify(response.body),
        );
        return { id: response.body.resourceId as string, approval };
      };
      const readerFacts = await setRuntimeVerification(
        pool,
        reader.accountId,
        scope.institutionId,
        scope.home.regionId,
      );
      await appendIdentitySelection(
        pool,
        reader.accountId,
        readerFacts,
        scope,
        scope.home.campusId,
      );
      const named = await publish('owner named'),
        anonymous = await publish('owner anonymous', author, null, 'anonymous');
      const peerPost = await publish('other account', reader);
      const base = '/v1/me/community/publications';
      const page = (
        kind = 'topic',
        identity = 'named',
        extra: Record<string, string> = {},
        actor = author,
      ) =>
        request(http)
          .get(base)
          .query({ kind, identity, ...extra })
          .set('Authorization', auth(actor));
      assert.equal(
        (
          await request(http)
            .get(base)
            .query({ kind: 'topic', identity: 'named' })
        ).status,
        401,
      );
      const publicTopics = await page();
      assert.equal(publicTopics.status, 200, JSON.stringify(publicTopics.body));
      assert.deepEqual(
        publicTopics.body.items.map(
          (item: { targetId: string }) => item.targetId,
        ),
        [named.id],
      );
      const privateTopics = await page('topic', 'anonymous');
      assert.equal(
        privateTopics.status,
        200,
        JSON.stringify(privateTopics.body),
      );
      assert.deepEqual(
        privateTopics.body.items.map(
          (item: { targetId: string }) => item.targetId,
        ),
        [anonymous.id],
      );
      assert.equal(
        privateTopics.body.items[0].preview.author.kind,
        'anonymous',
      );
      assert.ok(!JSON.stringify(privateTopics.body).includes(author.accountId));
      assert.equal(
        (await page('topic', 'anonymous', { accountId: reader.accountId }))
          .status,
        400,
      );
      assert.deepEqual(
        (await page('topic', 'anonymous', {}, reader)).body.items,
        [],
      );
      const commentBody: PublishComment = {
        clientRequestId: randomUUID(),
        text: 'owner anonymous reply',
        imageAssetIds: [],
        authorMode: 'anonymous',
      };
      await approveEnvelope(
        pool,
        await discussionApprovalEnvelope(
          app!,
          pool,
          author.accountId,
          named.id,
          commentBody,
        ),
      );
      const comment = await request(http)
        .post(`/v1/community/posts/${named.id}/comments`)
        .set('Authorization', auth(author))
        .send(commentBody);
      assert.equal(comment.status, 201, JSON.stringify(comment.body));
      const replies = await page('reply', 'anonymous');
      assert.equal(replies.status, 200, JSON.stringify(replies.body));
      assert.deepEqual(
        replies.body.items.map((item: { targetId: string }) => item.targetId),
        [comment.body.resourceId],
      );
      assert.equal(
        replies.body.items[0].rootCommentId,
        comment.body.resourceId,
      );
      assert.equal(replies.body.items[0].postId, named.id);
      const nestedBody: PublishReply = {
        clientRequestId: randomUUID(),
        text: 'owner nested anonymous reply',
        imageAssetIds: [],
        authorMode: 'anonymous',
        targetReplyId: null,
      };
      await approveEnvelope(
        pool,
        await discussionApprovalEnvelope(
          app!,
          pool,
          author.accountId,
          named.id,
          nestedBody,
          comment.body.resourceId,
        ),
      );
      const nested = await request(http)
        .post(`/v1/community/comments/${comment.body.resourceId}/replies`)
        .set('Authorization', auth(author))
        .send(nestedBody);
      assert.equal(nested.status, 201, JSON.stringify(nested.body));
      const combined = await page('reply', 'anonymous');
      assert.deepEqual(
        new Set(
          combined.body.items.map(
            (item: { targetId: string }) => item.targetId,
          ),
        ),
        new Set([comment.body.resourceId, nested.body.resourceId]),
      );
      assert.equal(
        combined.body.items.find(
          (item: { kind: string }) => item.kind === 'reply',
        ).rootCommentId,
        comment.body.resourceId,
      );
      assert.deepEqual((await page('reply', 'named')).body.items, []);
      const peerCommentBody: PublishComment = {
        ...commentBody,
        clientRequestId: randomUUID(),
        authorMode: 'named',
      };
      await approveEnvelope(
        pool,
        await discussionApprovalEnvelope(
          app!,
          pool,
          author.accountId,
          peerPost.id,
          peerCommentBody,
        ),
      );
      const peerComment = await request(http)
        .post(`/v1/community/posts/${peerPost.id}/comments`)
        .set('Authorization', auth(author))
        .send(peerCommentBody);
      assert.equal(peerComment.status, 201, JSON.stringify(peerComment.body));
      assert.equal((await page('reply', 'named')).body.items.length, 1);
      const ownProfile = (
        await request(http)
          .get('/v1/me/public-profile-ref')
          .set('Authorization', auth(author))
      ).body.profileId;
      await request(http)
        .put('/v1/me/safety/blocks')
        .set('Authorization', auth(reader))
        .send({
          clientRequestId: randomUUID(),
          source: { kind: 'profile', id: ownProfile },
          blocked: true,
        })
        .expect(200);
      assert.deepEqual(
        (await page('reply', 'named')).body.items,
        [],
        'incoming block on parent author hides owner reply history',
      );
      await publish('second named');
      const first = await page('topic', 'named', { limit: '1' });
      assert.ok(first.body.nextCursor);
      assert.notEqual(
        (
          await page('topic', 'anonymous', {
            limit: '1',
            cursor: first.body.nextCursor,
          })
        ).status,
        200,
      );
      assert.notEqual(
        (
          await page('reply', 'named', {
            limit: '1',
            cursor: first.body.nextCursor,
          })
        ).status,
        200,
      );
      assert.notEqual(
        (
          await page(
            'topic',
            'named',
            { limit: '1', cursor: first.body.nextCursor },
            reader,
          )
        ).status,
        200,
      );
      await pool.query(
        'UPDATE whaleu_community.posts SET deleted_at=clock_timestamp() WHERE id=$1',
        [named.id],
      );
      assert.deepEqual(
        (await page('reply', 'anonymous')).body.items,
        [],
        'deleted parent suppresses owned replies too',
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
