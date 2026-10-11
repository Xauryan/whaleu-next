import { publicationHash } from '../../src/community/publication.repository.js';
import { postIntent } from '../../src/community/publication-intent.js';
import { publishPostSchema } from '../../src/community/contracts.js';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
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
import { TextReviewOperator } from '../../src/community/text-review/operator.js';
import { TextReviewRuntime } from '../../src/community/text-review/runtime.js';
import {
  createRuntimeActor,
  setRuntimeVerification,
} from '../support/community-runtime-fixtures.js';
import {
  seedCommunityScope,
  appendIdentitySelection,
} from '../support/community-scope-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

/** Real runtime HTTP and real local issuer. Only identity/scope/phone facts are
 * synthetic disposable fixtures; this is not a real WeChat-device acceptance. */
test(
  'explicit text review queue, local decisions and same-request publication',
  { timeout: 120000 },
  async () => {
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(database);
    const url = new URL(database);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const base = {
      NODE_ENV: 'test',
      DATABASE_URL: database,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      COMMUNITY_UPDATES_PROCESSING: 'disabled',
      EXPERIENCE_PROCESSING: 'disabled',
      VIEW_REPORTING_RETENTION_PROCESSING: 'disabled',
    };
    const pool = new Pool(poolOptions(loadConfig(base)));
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
      assert.ok(locked);
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
      );
      owns = true;
      await runMigrations(
        pool,
        await readMigrations(
          fileURLToPath(new URL('../../migrations', import.meta.url)),
        ),
        { mode: 'up' },
      );
      const scope = await seedCommunityScope(pool);
      const config = loadConfig({
        ...base,
        COMMUNITY_TEXT_REVIEW: 'local_manual',
        COMMUNITY_TEXT_REVIEW_SPACE_ID: scope.home.spaceId,
        COMMUNITY_TEXT_REVIEW_REGION_ID: scope.home.regionId,
        COMMUNITY_TEXT_REVIEW_POLICY_ID: randomUUID(),
        COMMUNITY_TEXT_REVIEW_OPERATOR: 'local:test:reviewer',
      });
      app = await NestFactory.create(AppModule.register(config), {
        logger: false,
      });
      configureHttp(app);
      await app.init();
      const http = app.getHttpServer(),
        actor = await createRuntimeActor(app),
        other = await createRuntimeActor(app);
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
        scope.home.campusId,
      );
      const auth = `Bearer ${actor.accessToken}`;
      const operator = new TextReviewOperator(
        app.get(TextReviewRuntime),
        config.COMMUNITY_TEXT_REVIEW_OPERATOR!,
      );
      await inTransaction(pool, (tx) =>
        operator.run(
          {
            command: 'init-policy',
            basis: 'Disposable explicit local-review acceptance policy',
          },
          tx,
        ),
      );
      const policyInput = {
        postEnabled: true,
        commentEnabled: true,
        namedOnly: true as const,
        categories: ['discussion' as const],
        validForHours: 24,
        basis: 'Explicit single-region named text experiment',
      };
      const preview = (await inTransaction(pool, (tx) =>
        operator.run({ command: 'preview-region', ...policyInput }, tx),
      )) as { currentRevision: number; previewDigest: string };
      assert.equal(preview.currentRevision, 0);
      assert.equal(
        (
          await pool.query(
            'SELECT * FROM whaleu_community.region_policy_heads WHERE region_id=$1',
            [scope.home.regionId],
          )
        ).rowCount,
        0,
      );
      await assert.rejects(
        inTransaction(pool, (tx) =>
          operator.run(
            {
              command: 'apply-region',
              ...policyInput,
              expectedRevision: preview.currentRevision,
              previewDigest: '0'.repeat(64),
            },
            tx,
          ),
        ),
      );
      await inTransaction(pool, (tx) =>
        operator.run(
          {
            command: 'apply-region',
            ...policyInput,
            expectedRevision: preview.currentRevision,
            previewDigest: preview.previewDigest,
          },
          tx,
        ),
      );
      assert.equal(
        (
          await pool.query(
            'SELECT revision FROM whaleu_community.region_policy_heads WHERE region_id=$1',
            [scope.home.regionId],
          )
        ).rows[0]!.revision,
        1,
      );
      await assert.rejects(
        inTransaction(pool, (tx) =>
          operator.run(
            {
              command: 'apply-region',
              ...policyInput,
              expectedRevision: preview.currentRevision,
              previewDigest: preview.previewDigest,
            },
            tx,
          ),
        ),
      );

      const body = {
        clientRequestId: randomUUID(),
        spaceId: scope.home.spaceId,
        category: 'discussion',
        text: 'A manually reviewed private text',
        imageAssetIds: [],
        authorMode: 'named',
        commentsPolicy: 'open',
      };
      const reference = (input = body) => ({
        operation: 'publish_post',
        intentHash: publicationHash(
          'publish_post',
          postIntent(publishPostSchema.parse(input)),
        ),
      });
      const submit = (input = body) =>
        request(http)
          .post('/v1/community/reviews/posts')
          .set('Authorization', auth)
          .send(input);
      const publish = (input = body) =>
        request(http)
          .post('/v1/community/posts')
          .set('Authorization', auth)
          .send(input);
      const status = () =>
        request(http)
          .get(`/v1/community/reviews/requests/${body.clientRequestId}`)
          .set('Authorization', auth);
      await assert.rejects(
        inTransaction(pool, async (tx) => {
          await tx.query(
            'INSERT INTO whaleu_community.publication_requests(account_id,client_request_id,payload_hash,operation) VALUES($1,$2,$3,$4)',
            [actor.accountId, randomUUID(), 'a'.repeat(64), 'publish_post'],
          );
        }),
      );
      const first = await submit();
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.status, 'pending');
      assert.equal((await submit()).body.status, 'pending');
      const duplicates = await Promise.all([submit(), submit()]);
      for (const duplicate of duplicates)
        assert.equal(duplicate.body.status, 'pending');
      assert.equal(
        (
          await pool.query(
            'SELECT * FROM whaleu_community.text_review_requests WHERE client_request_id=$1',
            [body.clientRequestId],
          )
        ).rowCount,
        1,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT * FROM whaleu_community.posts WHERE account_id=$1',
            [actor.accountId],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT * FROM whaleu_community.content_approval_decisions',
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT receipt FROM whaleu_community.publication_requests WHERE account_id=$1 AND client_request_id=$2',
            [actor.accountId, body.clientRequestId],
          )
        ).rows[0]!.receipt,
        null,
      );
      assert.equal(
        (await submit({ ...body, text: 'changed' })).body.error.code,
        'REQUEST_CONFLICT',
      );
      assert.equal(
        (
          await request(http)
            .get(`/v1/community/reviews/requests/${body.clientRequestId}`)
            .set('Authorization', `Bearer ${other.accessToken}`)
        ).status,
        404,
      );
      assert.equal(
        (await publish()).body.error.code,
        'CONTENT_REVIEW_UNAVAILABLE',
      );
      const row = (
        await pool.query<{ digest: string }>(
          'SELECT digest FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
          [actor.accountId, body.clientRequestId],
        )
      ).rows[0]!;
      const decide = {
        command: 'decide' as const,
        accountId: actor.accountId,
        requestId: body.clientRequestId,
        digest: row.digest,
        decision: 'allow' as const,
        basis: 'Operator read displayed exact canonical content',
      };
      await assert.rejects(
        inTransaction(pool, (tx) =>
          operator.run({ ...decide, digest: '0'.repeat(64) }, tx),
        ),
      );
      await inTransaction(pool, (tx) => operator.run(decide, tx));
      assert.equal((await status()).body.status, 'approved');
      assert.equal(
        (await publish({ ...body, clientRequestId: randomUUID() })).body.error
          .code,
        'CONTENT_REVIEW_UNAVAILABLE',
      );
      const published = await publish();
      assert.equal(published.status, 201, JSON.stringify(published.body));
      assert.equal(published.body.outcome, 'created');
      assert.deepEqual((await publish()).body, published.body);
      for (const replay of await Promise.all([publish(), publish()]))
        assert.deepEqual(replay.body, published.body);
      assert.equal((await status()).body.status, 'settled');
      assert.equal(
        (
          await pool.query(
            'SELECT * FROM whaleu_community.posts WHERE account_id=$1',
            [actor.accountId],
          )
        ).rowCount,
        1,
      );
      await assert.rejects(
        inTransaction(pool, (tx) => operator.run(decide, tx)),
      );
      const postId = published.body.resourceId;
      // Comment and reply use the identical explicit workflow and normal publication path.
      const discussion = async (reviewPath: string, publishPath: string) => {
        const input = {
          clientRequestId: randomUUID(),
          text: 'Reviewed discussion',
          authorMode: 'named',
          imageAssetIds: [],
          ...(publishPath.includes('/replies') ? { targetReplyId: null } : {}),
        };
        const submitted = await request(http)
          .post(reviewPath)
          .set('Authorization', auth)
          .send(input);
        assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
        const exact = (
          await pool.query<{ digest: string }>(
            'SELECT digest FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
            [actor.accountId, input.clientRequestId],
          )
        ).rows[0]!;
        await inTransaction(pool, (tx) =>
          operator.run(
            {
              ...decide,
              requestId: input.clientRequestId,
              digest: exact.digest,
            },
            tx,
          ),
        );
        const result = await request(http)
          .post(publishPath)
          .set('Authorization', auth)
          .send(input);
        assert.equal(result.status, 201, JSON.stringify(result.body));
        assert.equal(result.body.outcome, 'created');
        return result.body.resourceId as string;
      };
      const commentId = await discussion(
        `/v1/community/reviews/posts/${postId}/comments`,
        `/v1/community/posts/${postId}/comments`,
      );
      await discussion(
        `/v1/community/reviews/comments/${commentId}/replies`,
        `/v1/community/comments/${commentId}/replies`,
      );
      // A lost pre-queue response can be cancelled even when no queue ever committed.
      const absent = {
        ...body,
        clientRequestId: randomUUID(),
        text: 'Request not yet received',
      };
      const absentCancel = await request(http)
        .post(`/v1/community/reviews/requests/${absent.clientRequestId}/cancel`)
        .set('Authorization', auth)
        .send(reference(absent));
      assert.equal(absentCancel.body.outcome, 'cancelled');
      assert.equal(
        (await submit(absent)).body.error.code,
        'MEDIA_REQUEST_CANCELLED',
      );
      assert.equal(
        (await publish(absent)).body.error.code,
        'MEDIA_REQUEST_CANCELLED',
      );
      // Exact cancellation closes the original command, including a lost response.
      const cancelled = {
        ...body,
        clientRequestId: randomUUID(),
        text: 'Owner cancels this pending text',
      };
      assert.equal((await submit(cancelled)).status, 200);
      const cancel = () =>
        request(http)
          .post(
            `/v1/community/reviews/requests/${cancelled.clientRequestId}/cancel`,
          )
          .set('Authorization', auth)
          .send(reference(cancelled));
      const cancellation = await cancel();
      assert.equal(cancellation.status, 200);
      assert.equal(cancellation.body.outcome, 'cancelled');
      assert.deepEqual((await cancel()).body, cancellation.body);
      assert.equal(
        (await publish(cancelled)).body.error.code,
        'MEDIA_REQUEST_CANCELLED',
      );
      const cancelledRow = (
        await pool.query<{ digest: string }>(
          'SELECT digest FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
          [actor.accountId, cancelled.clientRequestId],
        )
      ).rows[0]!;
      await assert.rejects(
        inTransaction(pool, (tx) =>
          operator.run(
            {
              ...decide,
              requestId: cancelled.clientRequestId,
              digest: cancelledRow.digest,
            },
            tx,
          ),
        ),
      );
      assert.equal(
        (
          await request(http)
            .get(`/v1/community/reviews/requests/${cancelled.clientRequestId}`)
            .set('Authorization', auth)
        ).body.status,
        'cancelled',
      );
      const cancelPublished = await request(http)
        .post(`/v1/community/reviews/requests/${body.clientRequestId}/cancel`)
        .set('Authorization', auth)
        .send(reference(body));
      assert.deepEqual(cancelPublished.body, published.body);
      // Serializing decision and cancellation never permits a late issuer to resurrect a key.
      const racing = {
        ...body,
        clientRequestId: randomUUID(),
        text: 'Cancellation and decision race',
      };
      assert.equal((await submit(racing)).status, 200);
      const racingRow = (
        await pool.query<{ digest: string }>(
          'SELECT digest FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
          [actor.accountId, racing.clientRequestId],
        )
      ).rows[0]!;
      const [cancelRace] = await Promise.all([
        request(http)
          .post(
            `/v1/community/reviews/requests/${racing.clientRequestId}/cancel`,
          )
          .set('Authorization', auth)
          .send(reference(racing)),
        inTransaction(pool, (tx) =>
          operator.run(
            {
              ...decide,
              requestId: racing.clientRequestId,
              digest: racingRow.digest,
            },
            tx,
          ),
        ).catch(() => null),
      ]);
      assert.equal(cancelRace.body.outcome, 'cancelled');
      assert.equal(
        (await publish(racing)).body.error.code,
        'MEDIA_REQUEST_CANCELLED',
      );
      const rejected = {
        ...body,
        clientRequestId: randomUUID(),
        text: 'Explicitly rejected text',
      };
      assert.equal((await submit(rejected)).status, 200);
      const rejectedRow = (
        await pool.query<{ digest: string }>(
          'SELECT digest FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
          [actor.accountId, rejected.clientRequestId],
        )
      ).rows[0]!;
      await inTransaction(pool, (tx) =>
        operator.run(
          {
            ...decide,
            requestId: rejected.clientRequestId,
            digest: rejectedRow.digest,
            decision: 'reject',
          },
          tx,
        ),
      );
      const rejection = await publish(rejected);
      assert.equal(rejection.body.outcome, 'rejected');
      assert.equal(rejection.body.code, 'CONTENT_REJECTED');
      await inTransaction(pool, (tx) =>
        operator.run(
          {
            command: 'withdraw',
            accountId: actor.accountId,
            requestId: body.clientRequestId,
            digest: row.digest,
            state: 'revoked',
            basis: 'Operator explicitly withdraws prior decision',
          },
          tx,
        ),
      );
      const hidden = await request(http)
        .get(`/v1/community/posts/${postId}`)
        .set('Authorization', auth);
      assert.notEqual(hidden.status, 200);
      // Withdrawal never rewrites an applied receipt or republishes the content.
      assert.deepEqual((await publish()).body, published.body);
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
