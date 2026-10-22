import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hostname, userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
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
import { configureHttp } from '../../src/http/http.js';
import { CommunityRepository } from '../../src/community/community.repository.js';
import { CommunityAccessService } from '../../src/community/community-access.service.js';
import { CommunitySerializer } from '../../src/community/community-serialization.js';
import { FeedService } from '../../src/community/feed.service.js';
import { HotFeedService } from '../../src/community/hot/service.js';
import { HotScoreMaterializer } from '../../src/community/hot-score/materializer.js';
import { HotScoreRepository } from '../../src/community/hot-score/repository.js';
import { HotScoreStorage } from '../../src/community/hot-score/storage.js';
import { PostPinsService } from '../../src/community/post-pins/service.js';
import { CommunityDistributionService } from '../../src/community/related-sync/service.js';
import {
  homeDistributionAllowed,
  prepareHomeDistribution,
} from '../../src/community/home-distribution/read-proof.js';
import {
  canonicalEnvelope,
  approvalDigest,
} from '../../src/community/content-review/contracts.js';
import { configureHomeAdmission } from '../../src/community/home-feed-policy/admission.js';
import { configureHomePublication } from '../../src/community/home-feed-policy/activation.js';
import { HOME_POLICY_SOURCE } from '../../src/community/home-feed-policy/admission-contract.js';
import type { HomeAdmissionDefinition } from '../../src/community/home-feed-policy/admission-contract.js';
import { TextReviewOperator } from '../../src/community/text-review/operator.js';
import { TextReviewRuntime } from '../../src/community/text-review/runtime.js';
import {
  CommunityOfficialSource,
  CommunityOfficialPublicProjection,
} from '../../src/official-account-operations/source.js';
import {
  createRuntimeActor,
  setRuntimeVerification,
} from '../support/community-runtime-fixtures.js';
import {
  seedCommunityScope,
  appendIdentitySelection,
  withCommunityScopeWriter,
} from '../support/community-scope-fixtures.js';
import { observeExactQueries } from '../support/exact-discovery-counts.js';
import type { ExactQueryObservation } from '../support/exact-discovery-counts.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

/** Dedicated serial, disposable PostgreSQL lane. No fabricated V7 metadata,
 * disabled triggers, overridden runtime providers, or raised owner budgets.
 * Each publication uses real HTTP Review and publication; scalar owner gates
 * and service methods execute via the actual DatabaseService final proof. */
test(
  'Home distribution: genuine mixed V6/V7 reads, permissions and bounded final SQL proof',
  { timeout: 600000 },
  async (t) => {
    const databaseUrl = process.env['TEST_DATABASE_URL'];
    assert.ok(
      databaseUrl,
      'TEST_DATABASE_URL is required; this acceptance test never skips',
    );
    const url = new URL(databaseUrl);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const base = {
      NODE_ENV: 'test',
      DATABASE_URL: databaseUrl,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      COMMUNITY_UPDATES_PROCESSING: 'disabled',
      EXPERIENCE_PROCESSING: 'disabled',
      VIEW_REPORTING_RETENTION_PROCESSING: 'disabled',
      SUBSCRIPTION_COMPONENT_PROCESSING: 'manual_only',
      LIKE_COMPONENT_PROCESSING: 'manual_only',
      COMMENT_COMPONENT_PROCESSING: 'manual_only',
      HOT_FEED_PROCESSING: 'manual_only',
    };
    const pool = new Pool(poolOptions(loadConfig(base)));
    let suite: PoolClient | undefined, app: INestApplication | undefined;
    let owns = false,
      locked = false;
    let observer: ReturnType<typeof observeExactQueries> | undefined;
    try {
      suite = await pool.connect();
      locked = (
        await suite.query<{ locked: boolean }>(
          'SELECT pg_try_advisory_lock($1,$2) locked',
          [MIGRATION_LOCK[0], 2],
        )
      ).rows[0]!.locked;
      assert.ok(
        locked,
        'another disposable integration suite owns this database',
      );
      assert.ok(
        supportedPostgresVersion(
          (
            await suite.query<{ version: number }>(
              "SELECT current_setting('server_version_num')::integer version",
            )
          ).rows[0]!.version,
        ),
      );
      assert.equal(
        (
          await suite.query<{ n: number }>(
            "SELECT count(*)::integer n FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
          )
        ).rows[0]!.n,
        0,
      );
      owns = true;
      const migrations = (
        await readMigrations(
          fileURLToPath(new URL('../../migrations', import.meta.url)),
        )
      ).filter((m) => Number(m.name.slice(0, 4)) <= 178);
      assert.equal(
        migrations.at(-1)?.name,
        '0178_home_publication_protocol.sql',
      );
      await runMigrations(pool, migrations, { mode: 'up' });
      const scope = await seedCommunityScope(pool);
      const operatorName = `manual:${hostname()}:${userInfo().username}`;
      const config = loadConfig({
        ...base,
        COMMUNITY_TEXT_REVIEW: 'source_manual',
        COMMUNITY_TEXT_REVIEW_OPERATOR: operatorName,
        COMMUNITY_TEXT_SOURCE_REVIEW_POLICY_ID: randomUUID(),
        COMMUNITY_TEXT_REVIEW_SPACE_ID: scope.home.spaceId,
        COMMUNITY_TEXT_REVIEW_REGION_ID: scope.home.regionId,
      });
      app = await NestFactory.create(AppModule.register(config), {
        logger: false,
      });
      configureHttp(app);
      await app.init();
      const http = app.getHttpServer(),
        database = app.get(DatabaseService);
      const posts = app.get(CommunityRepository),
        access = app.get(CommunityAccessService);
      const feed = app.get(FeedService),
        pins = app.get(PostPinsService);
      const author = await createRuntimeActor(app),
        reader = await createRuntimeActor(app),
        foreign = await createRuntimeActor(app);
      for (const [actor, location] of [
        [author, scope.home],
        [reader, scope.home],
        [foreign, scope.foreign],
      ] as const) {
        const facts = await setRuntimeVerification(
          pool,
          actor.accountId,
          scope.institutionId,
          location.regionId,
        );
        await appendIdentitySelection(
          pool,
          actor.accountId,
          facts,
          scope,
          location.campusId,
        );
      }
      const operator = new TextReviewOperator(
        app.get(TextReviewRuntime),
        operatorName,
      );
      await inTransaction(pool, (tx) =>
        operator.run(
          {
            command: 'init-source-policy',
            basis: 'Disposable Home distribution acceptance fixture',
          },
          tx,
        ),
      );
      const input = (
        text: string,
        mode: 'named' | 'anonymous' = 'named',
        spaceId = scope.home.spaceId,
      ) => ({
        clientRequestId: randomUUID(),
        spaceId,
        category: 'discussion',
        text,
        imageAssetIds: [],
        authorMode: mode,
        commentsPolicy: 'open',
        textSource: { version: 1, format: 'plain', readingFormatting: 'auto' },
      });
      const publish = async (body: ReturnType<typeof input>) => {
        const review = await request(http)
          .post('/v1/community/reviews/posts')
          .set('Authorization', `Bearer ${author.accessToken}`)
          .send(body);
        assert.equal(review.status, 200, JSON.stringify(review.body));
        assert.equal(
          review.body.status,
          'pending',
          JSON.stringify(review.body),
        );
        const row = (
          await pool.query<{ digest: string; envelope: unknown }>(
            'SELECT digest,envelope FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
            [author.accountId, body.clientRequestId],
          )
        ).rows[0]!;
        const envelope = canonicalEnvelope(row.envelope);
        assert.equal(row.digest, approvalDigest(envelope));
        await inTransaction(pool, (tx) =>
          operator.run(
            {
              command: 'decide',
              accountId: author.accountId,
              requestId: body.clientRequestId,
              digest: row.digest,
              decision: 'allow',
              basis: 'Exact synthetic source reviewed for distribution test',
            },
            tx,
          ),
        );
        const created = await request(http)
          .post('/v1/community/posts')
          .set('Authorization', `Bearer ${author.accessToken}`)
          .send(body);
        assert.equal(created.status, 201, JSON.stringify(created.body));
        assert.equal(
          created.body.outcome,
          'created',
          JSON.stringify(created.body),
        );
        return { id: String(created.body.resourceId), envelope };
      };
      const recorded: ExactQueryObservation[] = [];
      observer = observeExactQueries(app);
      observer.setHook(async (event) => {
        recorded.push(event);
      });
      const measure = async <T>(label: string, operation: () => Promise<T>) => {
        recorded.length = 0;
        const result = await observer!.measure(label, operation);
        t.diagnostic(
          JSON.stringify({
            label,
            durationMs: result.measurement.durationMs,
            queries: result.measurement.queries,
            maximumBindArray: result.measurement.maxBindArray,
          }),
        );
        return result.value;
      };
      const homeReads = () =>
        recorded.filter((q) =>
          q.sql.includes('home_post_disposition_valid(p.id)'),
        );
      const homeFences = () =>
        recorded.filter(
          (q) =>
            q.sql.startsWith('LOCK TABLE') &&
            q.sql.includes('home_post_dispositions'),
        );
      const legacy: Awaited<ReturnType<typeof publish>>[] = [];
      for (let i = 0; i < 8; i++)
        legacy.push(
          await publish(
            input(
              `Preactivation ordinary legacy row ${i} with enough source text`,
            ),
          ),
        );
      assert.ok(legacy.every((row) => row.envelope.version === 6));
      await t.test(
        'actual all-legacy Feed keeps existing access proof but adds no Home final fence',
        async () => {
          const page = await measure('legacy-feed-8', () =>
            feed.feed(reader.accessToken, {
              spaceId: scope.home.spaceId,
              limit: 10,
            }),
          );
          assert.deepEqual(
            new Set(page.items.map((p) => p.id)),
            new Set(legacy.map((p) => p.id)),
          );
          assert.equal(homeFences().length, 0);
          assert.equal(homeReads().length, 1);
          assert.ok(
            recorded.some((q) => q.sql.includes('content_approval')),
            'existing Review owner still runs',
          );
          assert.ok(
            recorded.some((q) => q.sql === 'SET CONSTRAINTS ALL IMMEDIATE'),
            'managed final owner validation executes',
          );
        },
      );
      let definition: HomeAdmissionDefinition = {
        version: 1,
        sourceCommit: HOME_POLICY_SOURCE,
        categoryMappings: [
          {
            nativeCategory: 'discussion',
            sourceKind: 'regional',
            legacyChoose: 2,
          },
          { nativeCategory: 'water', sourceKind: 'regional', legacyChoose: 9 },
          {
            nativeCategory: 'discussion',
            sourceKind: 'global',
            legacyChoose: 100,
          },
        ],
        scopeMappings: [
          {
            sourceSpaceId: scope.home.spaceId,
            sourceKind: 'regional',
            sourceRegionId: scope.home.regionId,
            targetWaterSpaceId: scope.home.spaceId,
            targetRegionId: scope.home.regionId,
          },
          {
            sourceSpaceId: scope.global.spaceId,
            sourceKind: 'global',
            sourceRegionId: null,
            targetWaterSpaceId: scope.home.spaceId,
            targetRegionId: scope.home.regionId,
          },
        ],
        authorModes: ['named', 'anonymous'],
        exemptions: { audit: 'none', attachments: 'normalized_server_facts' },
        surfaces: { home: true, hot: 'exclude_water', following: 'excluded' },
        markdownReferences: false,
      };
      const admit = async () => {
        const proposal = {
          definition,
          evidenceRef: 'Disposable explicit Home surface mapping',
          validForHours: 2,
        };
        const prepared = (await inTransaction(pool, (tx) =>
          configureHomeAdmission(
            { command: 'prepare', ...proposal },
            config,
            operatorName,
            tx,
          ),
        )) as {
          preparationId: string;
          currentRevision: number;
          previewDigest: string;
        };
        await inTransaction(pool, (tx) =>
          configureHomeAdmission(
            {
              command: 'apply',
              ...proposal,
              preparationId: prepared.preparationId,
              expectedRevision: prepared.currentRevision,
              previewDigest: prepared.previewDigest,
            },
            config,
            operatorName,
            tx,
          ),
        );
      };
      await admit();
      const activate = async () => {
        const activation = (await inTransaction(pool, (tx) =>
          configureHomePublication(
            {
              command: 'prepare',
              evidenceRef: 'Disposable explicit Home activation',
              validForHours: 1,
            },
            config,
            operatorName,
            tx,
          ),
        )) as {
          preparationId: string;
          currentRevision: number;
          previewDigest: string;
        };
        await inTransaction(pool, (tx) =>
          configureHomePublication(
            {
              command: 'apply',
              preparationId: activation.preparationId,
              expectedRevision: activation.currentRevision,
              previewDigest: activation.previewDigest,
            },
            config,
            operatorName,
            tx,
          ),
        );
      };
      await activate();
      const excluded = await publish(input('短文'));
      assert.equal(excluded.envelope.version, 7);
      definition = {
        ...definition,
        surfaces: {
          home: true,
          hot: 'disabled',
          following: 'named_only_author_filter',
        },
      };
      await admit();
      await activate();
      const named = await publish(input('几个字')),
        anonymous = await publish(input('三个字', 'anonymous'));
      const ordinary = await publish(
        input(
          'Ordinary unrestricted source body, safely beyond the legacy short-text threshold.',
        ),
      );
      const restricted = [excluded, named, anonymous];
      const ordinaryIds = [ordinary.id];
      // 36 genuine rows total, crossing a native 32-candidate window. No bulk
      // forged metadata or synthetic final-proof function is used for scale.
      for (let i = 0; i < 24; i++) {
        if (i % 2)
          restricted.push(
            await publish(input('几句话', i % 3 ? 'named' : 'anonymous')),
          );
        else
          ordinaryIds.push(
            (
              await publish(
                input(
                  `Ordinary source scale row ${i}: real native publication with complete original text.`,
                ),
              )
            ).id,
          );
      }
      const projection = new CommunityOfficialPublicProjection(
        posts,
        access,
        app.get(CommunitySerializer),
      );
      const official = new CommunityOfficialSource(
        posts,
        access,
        app.get(HotScoreRepository),
        app.get(HotScoreStorage),
        projection,
      );
      await t.test(
        'historical absence cannot gain metadata or convert to V7, and V7 cannot downgrade',
        async () => {
          await assert.rejects(
            pool.query(
              'UPDATE whaleu_community.posts SET publication_envelope_version=7 WHERE id=$1',
              [legacy[0]!.id],
            ),
            { code: '23514' },
          );
          await assert.rejects(
            pool.query(
              'UPDATE whaleu_community.posts SET publication_envelope_version=6 WHERE id=$1',
              [named.id],
            ),
            { code: '23514' },
          );
          await assert.rejects(
            pool.query(
              `INSERT INTO whaleu_community.home_post_dispositions(post_id,decision_id,digest,evidence)
        SELECT $1,decision_id,digest,evidence FROM whaleu_community.home_post_dispositions WHERE post_id=$2`,
              [legacy[0]!.id, named.id],
            ),
            { code: '23514', constraint: 'home_publication_causal' },
          );
          const row = (
            await pool.query<{ version: number; disposition: string | null }>(
              'SELECT p.publication_envelope_version version,d.post_id disposition FROM whaleu_community.posts p LEFT JOIN whaleu_community.home_post_dispositions d ON d.post_id=p.id WHERE p.id=$1',
              [legacy[0]!.id],
            )
          ).rows[0]!;
          assert.deepEqual(row, { version: 6, disposition: null });
        },
      );
      await t.test(
        'actual Home pagination uses original author, not anonymous identity or caller parameters',
        async () => {
          const collect = async (token: string | null) => {
            const ids: string[] = [];
            let cursor: string | undefined;
            for (let pages = 0; pages < 10; pages++) {
              const page = await feed.feed(token, {
                spaceId: scope.home.spaceId,
                limit: 10,
                ...(cursor ? { cursor } : {}),
              });
              for (const post of page.items) {
                ids.push(post.id);
                assert.equal(
                  JSON.stringify(post).includes(author.accountId),
                  false,
                  'private account ID is absent from public DTO',
                );
              }
              if (!page.nextCursor) return ids;
              cursor = page.nextCursor;
            }
            throw new Error('Unexpected unbounded Home paging');
          };
          const own = await measure('mixed-home-author-36', () =>
            collect(author.accessToken),
          );
          assert.equal(new Set(own).size, 36);
          assert.ok(restricted.every((row) => own.includes(row.id)));
          assert.ok(homeFences().length > 0);
          const candidate = recorded.find(
            (q) =>
              q.sql.includes('home_disposition.post_id=p.id') &&
              q.sql.includes('LIMIT'),
          );
          assert.ok(candidate);
          const proof = homeReads().at(-1)!;
          assert.ok(
            proof.values[0] instanceof Array && proof.values[0].length <= 256,
          );
          const other = await measure('mixed-home-reader', () =>
            collect(reader.accessToken),
          );
          const unrestricted = new Set([
            ...legacy.map((p) => p.id),
            ...ordinaryIds,
          ]);
          assert.deepEqual(new Set(other), unrestricted);
          const guest = await measure('mixed-home-guest', () =>
            feed.feed(null, { spaceId: scope.home.spaceId, limit: 10 }),
          );
          assert.equal(guest.items.length, 10);
          assert.equal(guest.nextCursor, null);
          assert.equal(guest.continuation, 'login_required');
          assert.ok(
            guest.items.every((p) => unrestricted.has(p.id)),
            'Home restriction does not bypass existing guest continuation limits',
          );
          for (const [label, query] of [
            ['candidate', candidate],
            ['home-proof', proof],
          ] as const) {
            const plan = await inTransaction(pool, async (tx) => {
              await tx.query(
                "SELECT set_config('statement_timeout','100ms',true)",
              );
              return (
                await tx.query<{
                  'QUERY PLAN': {
                    'Planning Time': number;
                    'Execution Time': number;
                    Plan: { 'Actual Rows': number };
                  }[];
                }>(
                  `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query.sql}`,
                  query.values,
                )
              ).rows[0]!['QUERY PLAN'][0]!;
            });
            t.diagnostic(
              JSON.stringify({
                label: `explain-${label}-36`,
                planningMs: plan['Planning Time'],
                executionMs: plan['Execution Time'],
                actualRows: plan.Plan['Actual Rows'],
              }),
            );
          }
          const forged = await request(http)
            .get('/v1/community/posts')
            .set('Authorization', `Bearer ${reader.accessToken}`)
            .query({
              spaceId: scope.home.spaceId,
              accountId: author.accountId,
            });
          assert.equal(
            forged.status,
            400,
            'no public author bypass parameter is accepted',
          );
          const detail = await request(http)
            .get(`/v1/community/posts/${anonymous.id}`)
            .set('Authorization', `Bearer ${reader.accessToken}`);
          assert.equal(detail.status, 200, JSON.stringify(detail.body));
          assert.equal(
            JSON.stringify(detail.body).includes(author.accountId),
            false,
          );
        },
      );
      await t.test(
        'historical admitted surfaces remain exact after the current admission head changes; Following still requires a real edge',
        async () => {
          await database.transaction(
            async (tx) => {
              assert.equal(
                await homeDistributionAllowed(
                  excluded.id,
                  author.accountId,
                  'following',
                  tx,
                ),
                false,
              );
              assert.equal(
                await homeDistributionAllowed(
                  excluded.id,
                  author.accountId,
                  'hot',
                  tx,
                ),
                true,
              );
              assert.equal(
                await homeDistributionAllowed(
                  named.id,
                  author.accountId,
                  'following',
                  tx,
                ),
                true,
              );
              assert.equal(
                await homeDistributionAllowed(
                  named.id,
                  author.accountId,
                  'hot',
                  tx,
                ),
                false,
              );
              assert.equal(
                await homeDistributionAllowed(
                  anonymous.id,
                  author.accountId,
                  'following',
                  tx,
                ),
                false,
              );
            },
            { isolationLevel: 'read committed' },
          );
          const profile = await request(http)
            .get('/v1/me/public-profile-ref')
            .set('Authorization', `Bearer ${author.accessToken}`);
          assert.equal(profile.status, 200, JSON.stringify(profile.body));
          const follow = await request(http)
            .post(`/v1/profiles/${profile.body.profileId}/follow`)
            .set('Authorization', `Bearer ${reader.accessToken}`)
            .send({ requestId: randomUUID() });
          assert.equal(follow.status, 200, JSON.stringify(follow.body));
          const page = await measure('mixed-following-reader', () =>
            feed.feed(
              reader.accessToken,
              { spaceId: scope.home.spaceId, limit: 10 },
              true,
            ),
          );
          assert.ok(page.items.length > 0);
          assert.ok(
            page.items.every((p) => !restricted.some((r) => r.id === p.id)),
          );
          const own = await feed.feed(
            author.accessToken,
            { spaceId: scope.home.spaceId, limit: 10 },
            true,
          );
          assert.deepEqual(
            own.items,
            [],
            'named-only author permission does not create a self-follow',
          );
        },
      );
      await t.test(
        'actual Hot owner independently excludes current water for author and others',
        async () => {
          const materializer = app!.get(HotScoreMaterializer);
          for (const id of [legacy[0]!.id, ordinary.id, excluded.id, named.id])
            assert.ok(
              ['current', 'refreshed'].includes(await materializer.refresh(id)),
            );
          for (const token of [author.accessToken, reader.accessToken]) {
            const hot = await measure('mixed-hot', () =>
              app!.get(HotFeedService).read(token, {
                spaceId: scope.home.spaceId,
                range: 'day',
                limit: 10,
              }),
            );
            assert.ok(hot.items.some((p) => p.id === ordinary.id));
            assert.ok(hot.items.some((p) => p.id === legacy[0]!.id));
            assert.ok(hot.items.every((p) => p.category !== 'water'));
            assert.ok(
              hot.items.every((p) => !restricted.some((r) => r.id === p.id)),
            );
          }
        },
      );
      await t.test(
        'real pin command retains occupied manager slot while list distribution is author-only',
        async () => {
          await withCommunityScopeWriter(pool, async (tx) => {
            const pinScope = randomUUID(),
              until = new Date(Date.now() + 3600000);
            await tx.query(
              "INSERT INTO whaleu_community.post_pin_scopes(id,space_id,kind,operating_region_id,source_reference,provenance,accepted_at,valid_until) VALUES($1,$2,'regional',$3,'synthetic:home-distribution','accepted',clock_timestamp()-interval '1 minute',$4)",
              [pinScope, scope.home.spaceId, scope.home.regionId, until],
            );
            await tx.query(
              "INSERT INTO whaleu_community.post_pin_history(scope_id,coverage,source_reference,accepted_at,valid_until) VALUES($1,'accepted_empty','synthetic:home-distribution-empty-history',clock_timestamp()-interval '1 minute',$2)",
              [pinScope, until],
            );
            for (const account of [author.accountId, reader.accountId])
              await tx.query(
                "INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference,expires_at) VALUES($1,$2,'school_admin',$3,$2,'synthetic:home-distribution-pin',NULL)",
                [randomUUID(), account, scope.home.regionId],
              );
          });
          const command = await request(http)
            .post('/v1/community/post-pin-commands')
            .set('Authorization', `Bearer ${author.accessToken}`)
            .send({
              clientRequestId: randomUUID(),
              operation: 'pin',
              postId: named.id,
            });
          assert.equal(command.status, 200, JSON.stringify(command.body));
          assert.equal(
            command.body.outcome,
            'applied',
            JSON.stringify(command.body),
          );
          assert.equal(
            (
              await pins.list(author.accessToken, {
                spaceId: scope.home.spaceId,
              })
            ).items[0]?.post.id,
            named.id,
          );
          assert.deepEqual(
            (
              await pins.list(reader.accessToken, {
                spaceId: scope.home.spaceId,
              })
            ).items,
            [],
          );
          assert.deepEqual(
            (await pins.list(null, { spaceId: scope.home.spaceId })).items,
            [],
          );
          assert.equal(
            (await pins.slot(reader.accessToken, scope.home.spaceId)).pin
              ?.postId,
            named.id,
          );
        },
      );
      await t.test(
        'actual Official and related-sync boundaries deny restricted distribution without denying content access',
        async () => {
          for (const id of [named.id, ordinary.id])
            await pool.query(
              `INSERT INTO whaleu_official.export_eligibility(post_id,publication_xid,evidence_id,revision,decision,profile)
        SELECT id,local_creation_transaction,$2,$3,'allow','synthetic-official-v1' FROM whaleu_community.posts WHERE id=$1`,
              [id, randomUUID(), 'a'.repeat(64)],
            );
          await database.transaction(
            async (tx) => {
              assert.equal(
                (await official.inspect(named.id, false, tx))?.decision,
                'deny',
              );
              assert.equal(
                (await official.inspect(ordinary.id, false, tx))?.decision,
                'allow',
              );
              const post = await posts.post(named.id, tx);
              assert.equal(
                await access.visible(
                  reader.accountId,
                  post,
                  tx,
                  'list_projection',
                ),
                true,
              );
              const related = app!.get(CommunityDistributionService);
              const remote = await related.resolveView(
                await posts.space(scope.related.spaceId, tx),
                tx,
              );
              assert.ok(remote.remoteSpaceIds.includes(scope.home.spaceId));
              assert.equal(
                (
                  await related.allows(
                    remote,
                    named.id,
                    scope.home.spaceId,
                    'water',
                    tx,
                  )
                ).kind,
                'deny',
              );
              const local = await related.resolveView(
                await posts.space(scope.home.spaceId, tx),
                tx,
              );
              assert.equal(
                (
                  await related.allows(
                    local,
                    named.id,
                    scope.home.spaceId,
                    'water',
                    tx,
                  )
                ).kind,
                'allow',
              );
            },
            { isolationLevel: 'read committed' },
          );
          await assert.rejects(
            database.transaction((tx) => official.project(named.id, tx), {
              isolationLevel: 'read committed',
            }),
            { code: 'OFFICIAL_SOURCE_UNAVAILABLE' },
          );
          await assert.rejects(
            database.transaction((tx) => projection.read(named.id, tx), {
              isolationLevel: 'read committed',
            }),
            { code: 'OFFICIAL_SOURCE_UNAVAILABLE' },
          );
          assert.ok(
            (
              await database.transaction(
                (tx) => official.project(ordinary.id, tx),
                { isolationLevel: 'read committed' },
              )
            ).text,
          );
        },
      );
      await t.test(
        'global intent and author origin survive authorized regional redirection; unmapped origin cannot borrow it',
        async () => {
          const redirected = await publish(
            input('短文', 'named', scope.global.spaceId),
          );
          assert.equal(redirected.envelope.version, 7);
          if (redirected.envelope.version !== 7) throw new Error('V7 required');
          assert.equal(
            redirected.envelope.home.requestedIntent.spaceId,
            scope.global.spaceId,
          );
          assert.equal(
            redirected.envelope.home.requestedIntent.category,
            'discussion',
          );
          assert.equal(redirected.envelope.home.requestedRegionId, null);
          assert.equal(
            redirected.envelope.scope.authorOriginRegionId,
            scope.home.regionId,
          );
          assert.equal(redirected.envelope.spaceId, scope.home.spaceId);
          assert.equal(
            redirected.envelope.scope.originalRegionId,
            scope.home.regionId,
          );
          assert.equal(redirected.envelope.category, 'water');
          const deniedBody = input('短文', 'named', scope.global.spaceId);
          const denied = await request(http)
            .post('/v1/community/reviews/posts')
            .set('Authorization', `Bearer ${foreign.accessToken}`)
            .send(deniedBody);
          assert.notEqual(
            denied.body.status,
            'pending',
            JSON.stringify(denied.body),
          );
          assert.equal(
            (
              await pool.query<{ n: number }>(
                'SELECT count(*)::integer n FROM whaleu_community.text_review_requests WHERE account_id=$1 AND client_request_id=$2',
                [foreign.accountId, deniedBody.clientRequestId],
              )
            ).rows[0]!.n,
            0,
          );
        },
      );
      await t.test(
        'real V7 final proof retains 100ms query/500ms owner guard and fails closed on busy immutable fence',
        async () => {
          await measure('home-proof-mixed-36', () =>
            database.transaction(
              (tx) =>
                prepareHomeDistribution(
                  [
                    ...legacy.map((p) => p.id),
                    ...ordinaryIds,
                    ...restricted.map((p) => p.id),
                  ],
                  tx,
                ),
              { isolationLevel: 'read committed' },
            ),
          );
          assert.equal(homeFences().length, 1);
          assert.equal(homeReads().length, 2);
          assert.equal(homeReads()[0]!.rows, 36);
          assert.equal(
            homeReads()[1]!.rows,
            28,
            'legacy rows are not revalidated by Home final proof',
          );
          const fenceIndex = recorded.findIndex((q) => q === homeFences()[0]);
          assert.match(
            recorded[fenceIndex - 1]!.sql,
            /set_config\('statement_timeout'/,
          );
          assert.ok(
            Number(
              String(recorded[fenceIndex - 1]!.values[0]).replace('ms', ''),
            ) <= 100,
          );
          assert.equal(recorded[fenceIndex - 1]!.values[1], '1ms');
          t.diagnostic(
            JSON.stringify({
              label: 'home-final-proof-28',
              queryMs: homeReads()[1]!.durationMs,
              ownerLimitMs: 500,
              queryLimitMs: 100,
            }),
          );
          const writer = await pool.connect();
          try {
            await writer.query('BEGIN');
            await writer.query(
              'LOCK TABLE whaleu_community.home_policy_admissions IN ROW EXCLUSIVE MODE',
            );
            await assert.rejects(
              database.transaction(
                (tx) => prepareHomeDistribution([named.id], tx),
                { isolationLevel: 'read committed' },
              ),
              { code: 'COMMUNITY_UNAVAILABLE' },
            );
          } finally {
            await writer.query('ROLLBACK');
            writer.release();
          }
        },
      );
    } finally {
      observer?.restore();
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
