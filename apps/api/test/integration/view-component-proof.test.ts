import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { Test } from '@nestjs/testing';
import { Pool, type PoolClient } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { loadConfig } from '../../src/config/config.js';
import { inTransaction, poolOptions } from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { configureHttp } from '../../src/http/http.js';
import { publicationHash } from '../../src/community/publication.repository.js';
import { postIntent } from '../../src/community/publication-intent.js';
import type { PublishPost } from '../../src/community/contracts.js';
import { CommunityViewEnrollment } from '../../src/community/view-component/enrollment.js';
import { CommunityLikeEnrollment } from '../../src/community/like-component/enrollment.js';
import { CommunitySubscriptionEnrollment } from '../../src/community/subscription-component/enrollment.js';
import { createRuntimeActor } from '../support/community-runtime-fixtures.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';
import {
  epochPath,
  reportPath,
  reportIntent,
  assertReceipt,
} from '../support/view-component-fixture.js';

const constraint = (error: unknown) =>
  !!error &&
  typeof error === 'object' &&
  'code' in error &&
  ['23514', '23503', '23505'].includes(String(error.code));

test(
  'view SQL exact creation proof and genuine pre-migration publication replay never backfill history',
  { timeout: 120000 },
  async (t) => {
    const url = process.env['TEST_DATABASE_URL'];
    assert.ok(
      url,
      'Requires disposable real PostgreSQL, never silently skipped',
    );
    const parsed = new URL(url);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname));
    assert.equal(parsed.pathname, '/whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: url,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
    });
    const pool = new Pool(poolOptions(config)),
      suite = await pool.connect();
    const locked = (
      await suite.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock($1,$2) locked',
        [MIGRATION_LOCK[0], 2],
      )
    ).rows[0]!.locked;
    let owns = false;
    let app: import('@nestjs/common').INestApplication | undefined;
    const subscriptions = new CommunitySubscriptionEnrollment(),
      likes = new CommunityLikeEnrollment(),
      views = new CommunityViewEnrollment();
    try {
      assert.ok(locked, 'Serial PostgreSQL fixture required');
      assert.equal(
        (
          await pool.query(
            "SELECT 1 FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
          )
        ).rowCount,
        0,
        'Refuse existing schemas',
      );
      owns = true;
      const migrations = await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      );
      await runMigrations(
        pool,
        migrations.filter((m) => m.name < '0029'),
        { mode: 'up' },
      );
      // Manual application contexts start no retention or other automatic jobs.
      const module = await Test.createTestingModule({
        imports: [AppModule.register(config)],
      }).compile();
      app = module.createNestApplication({ logger: false });
      configureHttp(app);
      await app.init();
      const owner = await createRuntimeActor(app),
        other = await createRuntimeActor(app),
        space = randomUUID();
      await withCommunityScopeWriter(pool, (tx) =>
        tx.query(
          "INSERT INTO whaleu_community.spaces(id,kind,name) VALUES($1,'global','Synthetic view provenance')",
          [space],
        ),
      );
      const native = async (
        tx: PoolClient,
        view: boolean,
        patch: {
          wrongOwner?: boolean;
          wrongRequest?: boolean;
          omitState?: boolean;
          nonzero?: boolean;
          wrongReceipt?: boolean;
        } = {},
      ) => {
        const post = randomUUID(),
          requestId = randomUUID();
        const body: PublishPost = {
          clientRequestId: requestId,
          spaceId: space,
          category: 'discussion',
          text: 'Synthetic exact native view provenance',
          imageAssetIds: [],
          authorMode: 'named',
          commentsPolicy: 'open',
        };
        const receipt = {
          requestId,
          operation: 'publish_post',
          outcome: 'created',
          resourceId: post,
          createdAt: new Date().toISOString(),
        };
        await tx.query(
          "INSERT INTO whaleu_community.publication_requests(account_id,client_request_id,payload_hash,operation,receipt) VALUES($1,$2,$3,'publish_post',$4)",
          [
            owner.accountId,
            requestId,
            publicationHash('publish_post', postIntent(body)),
            patch.wrongReceipt
              ? { ...receipt, resourceId: randomUUID() }
              : receipt,
          ],
        );
        await tx.query(
          "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'discussion',$4,'named','open')",
          [post, space, owner.accountId, body.text],
        );
        await tx.query(
          "INSERT INTO whaleu_community.report_origins(kind,target_id,owner_account_id,source_request_id,provenance) VALUES('post',$1,$2,$3,'native_publication')",
          [post, owner.accountId, requestId],
        );
        const canonical = {
          postId: post,
          ownerId: owner.accountId,
          publicationRequestId: requestId,
        };
        await subscriptions.enrollPublishedPost(canonical, tx);
        await likes.enrollPublishedPost(canonical, tx);
        if (view) {
          await tx.query(
            'INSERT INTO whaleu_post_hotness.view_baselines(post_id,owner_id,source_request_id) VALUES($1,$2,$3)',
            [
              post,
              patch.wrongOwner ? other.accountId : owner.accountId,
              patch.wrongRequest ? randomUUID() : requestId,
            ],
          );
          if (!patch.omitState)
            await tx.query(
              'INSERT INTO whaleu_post_hotness.view_states(post_id,count) VALUES($1,$2)',
              [post, patch.nonzero ? 1 : 0],
            );
        }
        return { post, requestId, body, receipt };
      };
      const historical = await withCommunityScopeWriter(pool, (tx) =>
        native(tx, false),
      );
      await runMigrations(pool, migrations, { mode: 'up' });
      await t.test(
        'migration and original HTTP publication replay do not enroll old like/subscription-known posts',
        async () => {
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_post_hotness.like_baselines WHERE post_id=$1',
                [historical.post],
              )
            ).rowCount,
            1,
          );
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_post_hotness.subscription_baselines WHERE post_id=$1',
                [historical.post],
              )
            ).rowCount,
            1,
          );
          const response = await request(app!.getHttpServer())
            .post('/v1/community/posts')
            .set('Authorization', `Bearer ${owner.accessToken}`)
            .send(historical.body)
            .expect(201);
          assert.deepEqual(response.body, historical.receipt);
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_post_hotness.view_baselines',
              )
            ).rowCount,
            0,
          );
          await assert.rejects(
            withCommunityScopeWriter(pool, (tx) =>
              views.enrollPublishedPost(
                {
                  postId: historical.post,
                  ownerId: owner.accountId,
                  publicationRequestId: historical.requestId,
                },
                tx,
              ),
            ),
            constraint,
          );
          const epoch = (
            await request(app!.getHttpServer())
              .post(epochPath)
              .set('Authorization', `Bearer ${owner.accessToken}`)
              .send({ version: 1 })
              .expect(200)
          ).body;
          const body = reportIntent(epoch.epochId, [historical.post]);
          const result = await request(app!.getHttpServer())
            .post(reportPath)
            .set('Authorization', `Bearer ${owner.accessToken}`)
            .send(body)
            .expect(200);
          assertReceipt(result.body, body, 0);
          assert.equal(
            (
              await pool.query(
                'SELECT 1 FROM whaleu_post_hotness.view_baselines',
              )
            ).rowCount,
            0,
          );
        },
      );
      for (const [label, patch] of Object.entries({
        wrongOwner: { wrongOwner: true },
        wrongRequest: { wrongRequest: true },
        missingState: { omitState: true },
        nonzeroOpening: { nonzero: true },
        wrongReceipt: { wrongReceipt: true },
      })) {
        await t.test(
          `fresh enrollment rejects ${label} without leaking a partial publication`,
          async () => {
            const before = (
              await pool.query(
                'SELECT count(*)::int n FROM whaleu_community.posts',
              )
            ).rows[0]!.n;
            await assert.rejects(
              withCommunityScopeWriter(pool, (tx) => native(tx, true, patch)),
              constraint,
            );
            assert.equal(
              (
                await pool.query(
                  'SELECT count(*)::int n FROM whaleu_community.posts',
                )
              ).rows[0]!.n,
              before,
            );
          },
        );
      }
      await t.test(
        'deferred mandatory view enrollment cannot be omitted while prior component hooks succeed',
        async () => {
          await assert.rejects(
            withCommunityScopeWriter(pool, (tx) => native(tx, false)),
            constraint,
          );
        },
      );
      const fresh = await withCommunityScopeWriter(pool, (tx) =>
        native(tx, true),
      );
      await t.test(
        'baseline and aggregate are immutable/monotone; bigint state remains exact',
        async () => {
          const reject = (sql: string, values: unknown[] = [fresh.post]) =>
            assert.rejects(
              inTransaction(pool, (tx) => tx.query(sql, values)),
              constraint,
            );
          await reject(
            'UPDATE whaleu_post_hotness.view_baselines SET owner_id=$2 WHERE post_id=$1',
            [fresh.post, other.accountId],
          );
          await reject(
            'DELETE FROM whaleu_post_hotness.view_baselines WHERE post_id=$1',
          );
          await reject(
            'DELETE FROM whaleu_post_hotness.view_states WHERE post_id=$1',
          );
          await reject(
            'UPDATE whaleu_post_hotness.view_states SET count=0 WHERE post_id=$1',
          );
          await reject(
            'UPDATE whaleu_post_hotness.view_states SET count=-1 WHERE post_id=$1',
          );
          await withCommunityScopeWriter(pool, (tx) =>
            tx.query(
              'UPDATE whaleu_post_hotness.view_states SET count=9007199254740993 WHERE post_id=$1',
              [fresh.post],
            ),
          );
          assert.equal(
            (
              await pool.query(
                'SELECT count FROM whaleu_post_hotness.view_states WHERE post_id=$1',
                [fresh.post],
              )
            ).rows[0]!.count,
            '9007199254740993',
          );
        },
      );
    } finally {
      try {
        await app?.close();
        if (owns)
          for (const schema of migrationSchemaNames)
            await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        if (locked)
          await suite.query('SELECT pg_advisory_unlock($1,$2)', [
            MIGRATION_LOCK[0],
            2,
          ]);
        suite.release();
        await pool.end();
      }
    }
  },
);
