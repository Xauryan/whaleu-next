import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { cpus, totalmem } from 'node:os';
import { performance } from 'node:perf_hooks';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { AppModule } from '../../src/app.module.js';
import { CommunityAccessService } from '../../src/community/community-access.service.js';
import { CommunityRepository } from '../../src/community/community.repository.js';
import { CommunityDiscoveryCounts } from '../../src/community/discovery-counts.js';
import { loadConfig } from '../../src/config/config.js';
import {
  DatabaseService,
  poolOptions,
  supportedPostgresVersion,
} from '../../src/database/database.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { configureHttp } from '../../src/http/http.js';
import { ApplicationError } from '../../src/http/application-error.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';
import {
  setReviewState,
  seedReviewPolicy,
} from '../support/community-approval-fixtures.js';
import {
  createRuntimeActor,
  setRuntimeVerification,
  postApprovalEnvelope,
} from '../support/community-runtime-fixtures.js';
import {
  seedCommunityScope,
  appendIdentitySelection,
} from '../support/community-scope-fixtures.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';
import {
  observeExactQueries,
  seedExactContent,
  seedExactLikes,
} from '../support/exact-discovery-counts.js';
import type {
  ExactMeasurement,
  ExactSeedRow,
} from '../support/exact-discovery-counts.js';
import type { EffectiveContentEnvelope } from '../../src/community/content-review/contracts.js';

// This deliberately fails if every large answer is unavailable. All authority is
// ordinary AppModule ownership with canonical synthetic decisions and bindings.
test(
  'exact discovery counts: canonical AppModule acceptance and measured envelope',
  { timeout: 600000 },
  async (t) => {
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(
      database,
      'Set TEST_DATABASE_URL to disposable loopback whaleu_test',
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
      PG_STATEMENT_TIMEOUT_MS: '30000',
      COMMUNITY_UPDATES_PROCESSING: 'disabled',
    });
    const pool = new Pool(poolOptions(config));
    let suite: PoolClient | undefined,
      app: INestApplication | undefined,
      owns = false,
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
      assert.equal(locked, true, 'Run disposable integration suites serially');
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
      const migrations = await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      );
      // Genuine pre-0019 memberships, migrated to null dates through the actual
      // migration. No trigger is disabled and no historical date is fabricated.
      await runMigrations(
        pool,
        migrations.filter((m) => Number(m.name.slice(0, 4)) <= 18),
        { mode: 'up' },
      );
      const start = async () => {
        app = await NestFactory.create(AppModule.register(config), {
          logger: false,
        });
        configureHttp(app);
        await app.init();
      };
      await start();
      const scope = await seedCommunityScope(pool),
        policy = await seedReviewPolicy(pool);
      const createAuthor = async () => {
        const actor = await createRuntimeActor(app!);
        const facts = await setRuntimeVerification(
          pool,
          actor.accountId,
          scope.institutionId,
          scope.home.regionId,
        );
        await appendIdentitySelection(pool, actor.accountId, facts, scope);
        const response = await request(app!.getHttpServer())
          .patch('/v1/me/profile')
          .set('Authorization', `Bearer ${actor.accessToken}`)
          .send({
            expectedRevision: 0,
            nickname: 'ExactAuthor',
            bio: '',
          });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        const ref = await request(app!.getHttpServer())
          .get('/v1/me/public-profile-ref')
          .set('Authorization', `Bearer ${actor.accessToken}`);
        assert.equal(ref.status, 200);
        assert.equal(typeof ref.body.profileId, 'string');
        return { ...actor, profileId: ref.body.profileId as string };
      };
      const author1025 = await createAuthor(),
        author4097 = await createAuthor(),
        author25000 = await createAuthor(),
        unrelated = await createAuthor();
      const reader1025 = await createRuntimeActor(app!),
        reader4097 = await createRuntimeActor(app!),
        reader25000 = await createRuntimeActor(app!);
      const template = async (
        author: typeof author1025,
        spaceId = scope.home.spaceId,
      ) =>
        postApprovalEnvelope(app!, pool, author.accountId, {
          clientRequestId: randomUUID(),
          spaceId,
          category: 'discussion',
          text: 'Canonical synthetic exact count text',
          imageAssetIds: [],
          authorMode: 'named',
          commentsPolicy: 'open',
        });
      const smallTemplate = await template(author1025),
        mediumTemplate = await template(author4097),
        bigTemplate = await template(author25000),
        unrelatedTemplate = await template(unrelated);
      const mediumGlobal = await template(author4097, scope.global.spaceId);
      const bigGlobal = await template(author25000, scope.global.spaceId);
      const unrelatedGlobal = await template(unrelated, scope.global.spaceId);
      const smallGlobal = await template(author1025, scope.global.spaceId);
      const small = await seedExactContent(
        pool,
        policy,
        'post',
        1025,
        () => smallTemplate,
      );
      const medium = await seedExactContent(
        pool,
        policy,
        'post',
        4097,
        (i) => (i % 2 ? mediumGlobal : mediumTemplate),
        {
          // Rows255/256 only differ below milliseconds at the256-row count boundary.
          time: (i) =>
            i === 255
              ? '2020-01-01T00:00:00.000255Z'
              : i === 256
                ? '2020-01-01T00:00:00.000254Z'
                : i < 255
                  ? new Date(Date.UTC(2020, 0, 2) - i * 1000).toISOString()
                  : new Date(Date.UTC(2019, 0, 1) - i * 1000).toISOString(),
        },
      );
      const big = await seedExactContent(pool, policy, 'post', 25000, (i) =>
        i % 2 ? bigGlobal : bigTemplate,
      );
      const other = await seedExactContent(
        pool,
        policy,
        'post',
        1,
        () => unrelatedTemplate,
      );
      const roots = await seedExactContent(
        pool,
        policy,
        'comment',
        1365,
        (i) => ({
          ...(i % 2 ? unrelatedGlobal : unrelatedTemplate),
          purpose: 'publish_comment',
          postId: medium[i]!.id,
          text: 'Canonical synthetic root',
          accountId: unrelated.accountId,
        }),
      );
      const replies = await seedExactContent(
        pool,
        policy,
        'reply',
        1365,
        (i) => ({
          ...(i % 2 ? smallGlobal : smallTemplate),
          purpose: 'publish_reply',
          postId: medium[i]!.id,
          rootCommentId: roots[i]!.id,
          text: 'Canonical synthetic reply',
          accountId: author1025.accountId,
        }),
      );
      await seedExactLikes(
        pool,
        reader1025.accountId,
        'post',
        small.slice(0, 31).map((r) => r.id),
        false,
      );
      await seedExactLikes(
        pool,
        reader4097.accountId,
        'post',
        medium.slice(0, 31).map((r) => r.id),
        false,
      );
      await seedExactLikes(
        pool,
        reader4097.accountId,
        'comment',
        roots.slice(0, 31).map((r) => r.id),
        false,
      );
      await seedExactLikes(
        pool,
        reader4097.accountId,
        'reply',
        replies.slice(0, 31).map((r) => r.id),
        false,
      );
      await seedExactLikes(
        pool,
        reader25000.accountId,
        'post',
        big.slice(0, 31).map((r) => r.id),
        false,
      );
      await app!.close();
      app = undefined;
      await runMigrations(pool, migrations, { mode: 'up' });
      await start();
      await seedExactLikes(
        pool,
        reader1025.accountId,
        'post',
        small.slice(31).map((r) => r.id),
        true,
      );
      await seedExactLikes(
        pool,
        reader4097.accountId,
        'post',
        medium.slice(31, 1367).map((r) => r.id),
        true,
      );
      await seedExactLikes(
        pool,
        reader4097.accountId,
        'comment',
        roots.slice(31).map((r) => r.id),
        true,
      );
      await seedExactLikes(
        pool,
        reader4097.accountId,
        'reply',
        replies.slice(31).map((r) => r.id),
        true,
      );
      await seedExactLikes(
        pool,
        reader25000.accountId,
        'post',
        big.slice(31).map((r) => r.id),
        true,
      );
      // Finish bulk-fixture maintenance before timed quiet-window measurements.
      // Runtime autovacuum remains enabled; explicit lock contention is tested below.
      await pool.query('VACUUM (ANALYZE)');
      const pgSettings = (
        await pool.query(
          'SELECT name,setting,unit FROM pg_settings WHERE name=ANY($1::text[]) ORDER BY name',
          [
            [
              'shared_buffers',
              'work_mem',
              'max_connections',
              'default_transaction_isolation',
              'jit',
              'fsync',
              'synchronous_commit',
            ],
          ],
        )
      ).rows;
      t.diagnostic(
        JSON.stringify({
          benchmarkEnvironment: {
            node: process.version,
            cpu: cpus()[0]?.model,
            logicalCpus: cpus().length,
            totalMemory: totalmem(),
            pgSettings,
            cache:
              'post-seeding VACUUM ANALYZE, warm OS/PostgreSQL caches; no false cold-cache claim',
            fixture:
              'canonical text review bindings; all content inserted with triggers and constraints enabled',
          },
        }),
      );
      observer = observeExactQueries(app!);
      const lockFailures: {
        code: string | null;
        holders: Record<string, unknown>[];
      }[] = [];
      observer.setFailureHook(async (event) => {
        if (!event.sql.startsWith('LOCK TABLE') || event.code !== '55P03')
          return;
        const holders = (
          await pool.query<Record<string, unknown>>(
            `SELECT l.pid,l.mode,l.granted,n.nspname || '.' || c.relname AS relation,
            a.backend_type,a.application_name,a.state,a.wait_event_type
           FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
           JOIN pg_namespace n ON n.oid=c.relnamespace
           LEFT JOIN pg_stat_activity a ON a.pid=l.pid
           WHERE n.nspname=ANY($1::text[]) AND l.granted
             AND l.mode=ANY($2::text[]) ORDER BY n.nspname,c.relname,l.pid,l.mode`,
            [
              ['whaleu_community', 'whaleu_safety', 'whaleu_campus'],
              [
                'RowExclusiveLock',
                'ShareUpdateExclusiveLock',
                'ShareRowExclusiveLock',
                'ExclusiveLock',
                'AccessExclusiveLock',
              ],
            ],
          )
        ).rows;
        const evidence = { code: event.code, holders };
        lockFailures.push(evidence);
        t.diagnostic(JSON.stringify({ countFenceConflict: evidence }));
      });
      const getProfile = (
        author = author4097,
        token: string | null = reader4097.accessToken,
      ) => {
        const req = request(app!.getHttpServer()).get(
          `/v1/profiles/${author.profileId}`,
        );
        return token ? req.set('Authorization', `Bearer ${token}`) : req;
      };
      const getPosts = (
        author = author4097,
        query: Record<string, string> = { limit: '1' },
      ) =>
        request(app!.getHttpServer())
          .get(`/v1/profiles/${author.profileId}/posts`)
          .query(query)
          .set('Authorization', `Bearer ${reader4097.accessToken}`);
      const getLikes = (
        reader = reader4097,
        query: Record<string, string> = { limit: '1' },
      ) =>
        request(app!.getHttpServer())
          .get('/v1/me/community/liked')
          .query(query)
          .set('Authorization', `Bearer ${reader.accessToken}`);
      const emit = (
        measurement: ExactMeasurement,
        body: Record<string, unknown>,
      ) =>
        t.diagnostic(
          JSON.stringify({
            exactCountMeasurement: {
              ...measurement,
              postCount: body['postCount'],
              postCountStatus: body['postCountStatus'],
              total: body['total'],
              totalStatus: body['totalStatus'],
              visibleLikedCount: body['visibleLikedCount'],
              visibleLikedCountStatus: body['visibleLikedCountStatus'],
            },
          }),
        );
      const known = (
        response: request.Response,
        field: string,
        value: number,
      ) => {
        assert.equal(response.status, 200, JSON.stringify(response.body));
        assert.equal(
          response.body[`${field}Status`],
          'known',
          JSON.stringify(response.body),
        );
        assert.equal(response.body[field], value);
      };
      await t.test(
        'positive exact1025 and4097 HTTP counts and bounded batch SQL, including1365 complete liked chains',
        async () => {
          for (const [author, reader, size] of [
            [author1025, reader1025, 1025],
            [author4097, reader4097, 4097],
          ] as const) {
            for (let repetition = 0; repetition < 2; repetition++) {
              const profile = await observer!.measure(
                `profile-${size}-${repetition}`,
                async () => getProfile(author),
              );
              emit(profile.measurement, profile.value.body);
              known(profile.value, 'postCount', size);
              known(profile.value, 'tradeCount', 0);
              assert.ok(
                profile.measurement.maxBindArray <= 769,
                'No whole-history UUID array',
              );
              assert.ok(
                profile.measurement.queries < size,
                'Actual PostgreSQL calls must be batch-scaled',
              );
              assert.ok(
                profile.measurement.begins.every((x) => x === 'read committed'),
                'Read mode explicitly chosen',
              );
              const likes = await observer!.measure(
                `likes-${size}-${repetition}`,
                async () => getLikes(reader),
              );
              emit(likes.measurement, likes.value.body);
              known(likes.value, 'visibleLikedCount', size);
              assert.equal(likes.value.body.items.length, 1);
              assert.equal(likes.value.body.continuation, 'more');
              assert.ok(likes.measurement.maxBindArray <= 769);
              assert.ok(likes.measurement.queries < size);
            }
          }
          const page = await getPosts();
          known(page, 'total', 4097);
          assert.equal(page.body.items.length, 1);
          assert.match(page.body.nextCursor, /^[A-Za-z0-9_-]{43}$/);
          const guest = await getProfile(author4097, null);
          known(guest, 'postCount', 4097);
          for (const id of [
            author4097.accountId,
            reader4097.accountId,
            medium[0]!.decision,
            policy,
          ])
            assert.ok(
              !JSON.stringify(guest.body).includes(id),
              'No private owner/review identifiers',
            );
          assert.equal(guest.body.totalInteractions, null);
        },
      );
      await t.test(
        'uninstrumented4097 HTTP timing provides an observation-overhead comparison',
        async () => {
          observer!.restore();
          try {
            for (const [label, read, field] of [
              ['profile-4097-uninstrumented', () => getProfile(), 'postCount'],
              [
                'likes-4097-uninstrumented',
                () => getLikes(),
                'visibleLikedCount',
              ],
            ] as const) {
              const start = performance.now(),
                response = await read(),
                durationMs = performance.now() - start;
              t.diagnostic(
                JSON.stringify({
                  uninstrumentedMeasurement: {
                    label,
                    durationMs,
                    value: response.body[field],
                    status: response.body[`${field}Status`],
                  },
                }),
              );
              known(response, field, 4097);
            }
          } finally {
            observer = observeExactQueries(app!);
          }
        },
      );
      await t.test(
        '25000 exact records and memberships within explicitly finite benchmark budget',
        async () => {
          for (const [label, read] of [
            ['profile-25000-default-budget', () => getProfile(author25000)],
            ['likes-25000-default-budget', () => getLikes(reader25000)],
          ] as const) {
            const result = await observer!.measure(label, async () => read());
            emit(result.measurement, result.value.body);
            assert.equal(result.value.status, 200);
          }
          const counts = app!.get(CommunityDiscoveryCounts),
            profile = counts.profile.bind(counts),
            liked = counts.liked.bind(counts);
          // Resource budget only. Canonical owner facts and policy remain unchanged.
          counts.profile = (owner, viewer, kind, tx, subtype) =>
            profile(owner, viewer, kind, tx, subtype, 15000);
          counts.liked = (owner, tx) => liked(owner, tx, 15000);
          try {
            for (const [label, read, field] of [
              ['profile-25000', () => getProfile(author25000), 'postCount'],
              ['likes-25000', () => getLikes(reader25000), 'visibleLikedCount'],
            ] as const) {
              const result = await observer!.measure(label, async () => read());
              emit(result.measurement, result.value.body);
              known(result.value, field, 25000);
              assert.ok(
                result.measurement.durationMs < 30000,
                'Finite outer benchmark bound',
              );
              assert.ok(result.measurement.maxBindArray <= 769);
              assert.ok(
                result.measurement.queries < 5000,
                'Cannot hide per-subject query work',
              );
            }
          } finally {
            counts.profile = profile;
            counts.liked = liked;
          }
        },
      );
      await t.test(
        'two concurrent ordinary requests report exact availability and finalizer contention',
        async () => {
          observer!.restore();
          try {
            for (const mixed of [false, true]) {
              const attempts: {
                durationMs: number;
                field: string;
                status: string;
                value: number | null;
              }[] = [];
              for (let pair = 0; pair < 3; pair++) {
                const reads = [
                  { field: 'postCount', read: () => getProfile() },
                  {
                    field: mixed ? 'visibleLikedCount' : 'postCount',
                    read: () => (mixed ? getLikes() : getProfile()),
                  },
                ];
                attempts.push(
                  ...(await Promise.all(
                    reads.map(async (item) => {
                      const start = performance.now(),
                        response = await item.read();
                      assert.equal(response.status, 200);
                      const status = response.body[
                          `${item.field}Status`
                        ] as string,
                        value = response.body[item.field] as number | null;
                      if (status === 'known') assert.equal(value, 4097);
                      else assert.equal(value, null);
                      return {
                        durationMs: performance.now() - start,
                        field: item.field,
                        status,
                        value,
                      };
                    }),
                  )),
                );
              }
              t.diagnostic(
                JSON.stringify({
                  concurrentCounts: {
                    concurrency: 2,
                    workload: mixed ? 'profile+mixed-liked' : 'profile+profile',
                    attempts,
                    known: attempts.filter((a) => a.status === 'known').length,
                  },
                }),
              );
            }
          } finally {
            observer = observeExactQueries(app!);
          }
        },
      );
      await t.test(
        'candidate plans retain index seeks with no whole-history sort spill',
        async () => {
          const plans: { kind: string; sql: string; values: unknown[] }[] = [];
          observer!.setHook(async (event) => {
            if (
              /LIMIT\s+257/i.test(event.sql) &&
              !event.sql.includes('count_snapshot_source')
            ) {
              const kind = event.sql.includes('UNION ALL')
                ? 'liked'
                : 'profile';
              if (!plans.some((p) => p.kind === kind))
                plans.push({ kind, sql: event.sql, values: event.values });
            }
          });
          try {
            await getProfile(author25000);
            await getLikes(reader25000);
          } finally {
            observer!.setHook(null);
          }
          const describe = (node: Record<string, unknown>): unknown => ({
            type: node['Node Type'],
            relation: node['Relation Name'],
            index: node['Index Name'],
            rows: node['Actual Rows'],
            loops: node['Actual Loops'],
            sort: node['Sort Method'],
            sortSpace: node['Sort Space Used'],
            sortSpaceType: node['Sort Space Type'],
            sharedHits: node['Shared Hit Blocks'],
            sharedReads: node['Shared Read Blocks'],
            tempRead: node['Temp Read Blocks'],
            tempWritten: node['Temp Written Blocks'],
            children: Array.isArray(node['Plans'])
              ? node['Plans'].map((v) => describe(v as Record<string, unknown>))
              : [],
          });
          for (const plan of plans) {
            const result = await pool.query(
              `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${plan.sql}`,
              plan.values,
            );
            const output = result.rows[0]['QUERY PLAN'][0] as Record<
              string,
              unknown
            >;
            t.diagnostic(
              JSON.stringify({
                candidatePlan: {
                  kind: plan.kind,
                  executionMs: output['Execution Time'],
                  planningMs: output['Planning Time'],
                  plan: describe(output['Plan'] as Record<string, unknown>),
                },
              }),
            );
          }
          assert.deepEqual(plans.map((p) => p.kind).sort(), [
            'liked',
            'profile',
          ]);
        },
      );
      await t.test(
        'profile privacy remains mandatory while own counts bypass only hide preference',
        async () => {
          const own = await request(app!.getHttpServer())
            .get('/v1/me/profile')
            .set('Authorization', `Bearer ${author4097.accessToken}`);
          const hide = await request(app!.getHttpServer())
            .patch('/v1/me/preferences')
            .set('Authorization', `Bearer ${author4097.accessToken}`)
            .send({
              expectedRevision: own.body.revision,
              preferences: { hideProfilePosts: true },
            });
          assert.equal(hide.status, 200, JSON.stringify(hide.body));
          try {
            known(await getProfile(), 'postCount', 0);
            known(await getProfile(author4097, null), 'postCount', 0);
            known(
              await getProfile(author4097, author4097.accessToken),
              'postCount',
              4097,
            );
            const hidden = await getPosts();
            assert.equal(hidden.body.status, 'hidden');
            known(hidden, 'total', 0);
            known(await getLikes(), 'visibleLikedCount', 4097);
          } finally {
            const reset = await request(app!.getHttpServer())
              .patch('/v1/me/preferences')
              .set('Authorization', `Bearer ${author4097.accessToken}`)
              .send({
                expectedRevision: hide.body.revision,
                preferences: { hideProfilePosts: false },
              });
            assert.equal(reset.status, 200);
          }
        },
      );
      await t.test(
        'approved historical reads do not depend on current phone/student/selection authority',
        async () => {
          await setRuntimeVerification(
            pool,
            author4097.accountId,
            scope.institutionId,
            scope.home.regionId,
            'unavailable',
            'unavailable',
          );
          await setRuntimeVerification(
            pool,
            reader4097.accountId,
            scope.institutionId,
            scope.home.regionId,
            'unavailable',
            'unavailable',
          );
          known(await getProfile(), 'postCount', 4097);
          known(await getLikes(), 'visibleLikedCount', 4097);
        },
      );
      await t.test(
        'current scalar chain oracle agrees on held parent and root short-circuit',
        async () => {
          const access = app!.get(CommunityAccessService),
            repo = app!.get(CommunityRepository);
          const scalar = (
            post: ExactSeedRow,
            root?: ExactSeedRow,
            reply?: ExactSeedRow,
          ) =>
            app!.get(DatabaseService).transaction(async (tx) => {
              try {
                await lockSafetyPolicy(tx);
                await access.accessiblePost(post.id, reader4097.accountId, tx);
                if (
                  root &&
                  !(await access.visible(
                    reader4097.accountId,
                    await repo.comment(root.id, tx, true),
                    tx,
                    'direct_post',
                  ))
                )
                  return 'deny';
                if (
                  reply &&
                  !(await access.visible(
                    reader4097.accountId,
                    await repo.reply(reply.id, tx, true),
                    tx,
                    'direct_post',
                  ))
                )
                  return 'deny';
                return 'allow';
              } catch (error) {
                if (!(error instanceof ApplicationError)) throw error;
                if (error.code === 'POST_NOT_FOUND') return 'deny';
                if (error.code === 'COMMUNITY_UNAVAILABLE')
                  return 'unavailable';
                throw error;
              }
            });
          assert.equal(
            await scalar(medium[0]!, roots[0]!, replies[0]!),
            'allow',
          );
          await setReviewState(pool, medium[0]!.decision, 'held');
          try {
            assert.equal(
              await scalar(medium[0]!, roots[0]!, replies[0]!),
              'deny',
            );
            known(await getProfile(), 'postCount', 4096);
            known(await getLikes(), 'visibleLikedCount', 4094);
          } finally {
            await setReviewState(pool, medium[0]!.decision, 'allow');
          }
          await setReviewState(pool, roots[0]!.decision, 'held');
          try {
            assert.equal(
              await scalar(medium[0]!, roots[0]!, replies[0]!),
              'deny',
            );
            known(await getProfile(), 'postCount', 4097);
            known(await getLikes(), 'visibleLikedCount', 4095);
          } finally {
            await setReviewState(pool, roots[0]!.decision, 'allow');
          }
        },
      );
      await t.test(
        'trade totals preserve every subtype, urgency and resolved-liked difference',
        async () => {
          const subtypes = [
            'qiugou',
            'shuma',
            'shujia',
            'yifu',
            'meizhuang',
            'yundong',
            'riyong',
            'shipin',
            'kaquan',
            'xiangbao',
            'zixingche',
            'diandongche',
            'xianshiqi',
          ] as const;
          const trading = (index: number): EffectiveContentEnvelope => ({
            ...unrelatedTemplate,
            category: 'trading',
            text: 'Synthetic canonical trading',
            trading: {
              subtype: subtypes[Math.floor(index / 2)]!,
              price: '12.5',
              urgency: index % 2 ? 'urgent' : 'normal',
              location: 'Synthetic pickup',
              contacts: {
                wechat: 'synthetic-contact-private',
                qq: '',
                phone: '',
              },
            },
          });
          const trades = await seedExactContent(
            pool,
            policy,
            'post',
            26,
            trading,
          );
          const resolved = await seedExactContent(pool, policy, 'post', 1, () =>
            trading(2),
          );
          await pool.query(
            "UPDATE whaleu_community.trading_listings SET resolution='resolved' WHERE post_id=$1",
            [resolved[0]!.id],
          );
          known(await getProfile(unrelated), 'tradeCount', 26);
          for (const subtype of subtypes) {
            const response = await request(app!.getHttpServer())
              .get(`/v1/profiles/${unrelated.profileId}/trading`)
              .query({ limit: '1', tradingSubtype: subtype })
              .set('Authorization', `Bearer ${reader4097.accessToken}`);
            known(response, 'total', 2);
            assert.equal(response.body.items.length, 1);
            assert.ok(
              !JSON.stringify(response.body).includes(
                'synthetic-contact-private',
              ),
              'Counts/pages do not reveal contact facts',
            );
          }
          await seedExactLikes(
            pool,
            reader4097.accountId,
            'post',
            [resolved[0]!.id],
            true,
          );
          const resolvedLikes = await getLikes();
          await pool.query(
            'DELETE FROM whaleu_community.post_likes WHERE post_id=$1 AND account_id=$2',
            [resolved[0]!.id, reader4097.accountId],
          );
          known(resolvedLikes, 'visibleLikedCount', 4098);
          assert.equal(trades.length, 26);
          // A missing review for a resolved, different-subtype row is still unknown:
          // current canonical evaluation checks visibility before listing filters.
          const unknown = randomUUID();
          // Both inserts use the same checked transaction.
          const tx = await pool.connect();
          try {
            await tx.query('BEGIN');
            await tx.query(
              "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy,published_at) VALUES($1,$2,$3,'trading','Synthetic missing review','named','open','1900-01-01')",
              [unknown, scope.home.spaceId, unrelated.accountId],
            );
            await tx.query(
              "INSERT INTO whaleu_community.trading_listings(post_id,subtype,price,urgency,resolution,location,wechat,qq,phone) VALUES($1,'shuma',1,'normal','resolved','Synthetic','synthetic','','')",
              [unknown],
            );
            await tx.query('COMMIT');
          } finally {
            tx.release();
          }
          const basic = await getProfile(unrelated);
          assert.equal(basic.status, 200);
          assert.equal(basic.body.tradeCountStatus, 'unavailable');
          assert.equal(basic.body.tradeCount, null);
          known(basic, 'postCount', 1);
          const narrowed = await request(app!.getHttpServer())
            .get(`/v1/profiles/${unrelated.profileId}/trading`)
            .query({ limit: '1', tradingSubtype: 'qiugou' })
            .set('Authorization', `Bearer ${reader4097.accessToken}`);
          assert.equal(narrowed.status, 200);
          assert.equal(narrowed.body.totalStatus, 'unavailable');
          assert.equal(narrowed.body.items.length, 1);
          await pool.query(
            "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
            [unknown],
          );
          known(await getProfile(unrelated), 'tradeCount', 26);
        },
      );
      await t.test(
        'anonymous source modes bypass only their own named relation, with full three-node chains',
        async () => {
          const viewer = await createAuthor();
          const viewerEnvelope = await template(viewer);
          const blockSource = (
            await seedExactContent(
              pool,
              policy,
              'post',
              1,
              () => viewerEnvelope,
            )
          )[0]!;
          const parents = await seedExactContent(
            pool,
            policy,
            'post',
            8,
            (i) => ({
              ...unrelatedTemplate,
              authorMode: i & 4 ? 'named' : 'anonymous',
            }),
          );
          const childRoots = await seedExactContent(
            pool,
            policy,
            'comment',
            8,
            (i) => ({
              ...smallTemplate,
              purpose: 'publish_comment',
              postId: parents[i]!.id,
              authorMode: i & 2 ? 'named' : 'anonymous',
              text: 'Synthetic mode root',
            }),
          );
          const childReplies = await seedExactContent(
            pool,
            policy,
            'reply',
            8,
            (i) => ({
              ...mediumTemplate,
              purpose: 'publish_reply',
              postId: parents[i]!.id,
              rootCommentId: childRoots[i]!.id,
              authorMode: i & 1 ? 'named' : 'anonymous',
              text: 'Synthetic mode reply',
            }),
          );
          await seedExactLikes(
            pool,
            viewer.accountId,
            'reply',
            childReplies.slice(0, 4).map((r) => r.id),
            true,
          );
          await pool.query(
            "INSERT INTO whaleu_community.reply_likes(reply_id,account_id,liked_at) SELECT unnest($1::uuid[]),$2,'2020-01-01'::timestamptz",
            [childReplies.slice(4).map((r) => r.id), viewer.accountId],
          );
          known(
            await getLikes(viewer, { limit: '50' }),
            'visibleLikedCount',
            8,
          );
          const block = randomUUID();
          const writeBlock = async (active: boolean) => {
            const tx = await pool.connect();
            try {
              await tx.query('BEGIN');
              if (active)
                await tx.query(
                  "INSERT INTO whaleu_safety.blocks(id,blocker_id,blocked_id,active,revision,display_snapshot,source_kind,source_id) VALUES($1,$2,$3,true,1,'Synthetic','post',$4)",
                  [
                    block,
                    unrelated.accountId,
                    viewer.accountId,
                    blockSource.id,
                  ],
                );
              else
                await tx.query(
                  'UPDATE whaleu_safety.blocks SET active=false,revision=revision+1 WHERE id=$1',
                  [block],
                );
              await tx.query(
                'INSERT INTO whaleu_safety.events(id,account_id,relationship_id,kind,revision) SELECT $1,blocker_id,id,$2,revision FROM whaleu_safety.blocks WHERE id=$3',
                [randomUUID(), active ? 'blocked' : 'unblocked', block],
              );
              await tx.query('COMMIT');
            } catch (error) {
              await tx.query('ROLLBACK');
              throw error;
            } finally {
              tx.release();
            }
          };
          await writeBlock(true);
          known(await getLikes(viewer), 'visibleLikedCount', 4);
          const inaccessible = await getProfile(unrelated, viewer.accessToken);
          assert.deepEqual(inaccessible.body, {
            status: 'unavailable',
            profileId: unrelated.profileId,
          });
          await writeBlock(false);
          await pool.query(
            "UPDATE whaleu_safety.account_heads SET block_coverage='missing' WHERE account_id=$1",
            [unrelated.accountId],
          );
          const unknown = await getLikes(viewer);
          assert.equal(unknown.status, 200);
          assert.equal(unknown.body.visibleLikedCountStatus, 'unavailable');
          // Hide all named parents before unknown safety. Anonymous parents remain
          // canonical, and their underlying owner's missing head must never matter.
          await pool.query(
            "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=ANY($1::uuid[])",
            [parents.slice(4).map((r) => r.id)],
          );
          known(await getLikes(viewer), 'visibleLikedCount', 4);
          await pool.query(
            "UPDATE whaleu_safety.account_heads SET block_coverage='complete' WHERE account_id=$1",
            [unrelated.accountId],
          );
          const hiddenParent = parents[4]!;
          const unknownRoot = randomUUID();
          await pool.query(
            "INSERT INTO whaleu_community.root_comments(id,post_id,account_id,text,author_mode) VALUES($1,$2,$3,'Synthetic unknown root','named')",
            [unknownRoot, hiddenParent.id, unrelated.accountId],
          );
          await pool.query(
            "INSERT INTO whaleu_community.comment_likes(comment_id,account_id,liked_at) VALUES($1,$2,'2020-01-01')",
            [unknownRoot, viewer.accountId],
          );
          known(await getLikes(viewer), 'visibleLikedCount', 4);
          await pool.query(
            "UPDATE whaleu_community.posts SET visibility='approved' WHERE id=$1",
            [hiddenParent.id],
          );
          const exposed = await getLikes(viewer);
          assert.equal(exposed.status, 200);
          assert.equal(exposed.body.visibleLikedCountStatus, 'unavailable');
          await pool.query(
            "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
            [hiddenParent.id],
          );
          known(await getLikes(viewer), 'visibleLikedCount', 4);
          await pool.query(
            "UPDATE whaleu_identity.accounts SET status='blocked' WHERE id=$1",
            [unrelated.accountId],
          );
          try {
            known(await getLikes(viewer), 'visibleLikedCount', 4);
            known(await getLikes(), 'visibleLikedCount', 4097);
            assert.deepEqual(
              (await getProfile(unrelated, viewer.accessToken)).body,
              { status: 'unavailable', profileId: unrelated.profileId },
            );
          } finally {
            await pool.query(
              "UPDATE whaleu_identity.accounts SET status='active' WHERE id=$1",
              [unrelated.accountId],
            );
          }
        },
      );
      await t.test(
        'cross-kind UUID collisions and addressed-reply review never collapse or add visibility ancestors',
        async () => {
          const owner = await createAuthor(),
            envelope = await template(owner),
            sharedId = randomUUID();
          const parent = (
            await seedExactContent(pool, policy, 'post', 1, () => envelope, {
              id: () => sharedId,
            })
          )[0]!;
          const root = (
            await seedExactContent(
              pool,
              policy,
              'comment',
              1,
              () => ({
                ...envelope,
                purpose: 'publish_comment',
                postId: parent.id,
                text: 'Synthetic same-UUID root',
              }),
              { id: () => sharedId },
            )
          )[0]!;
          const addressed = (
            await seedExactContent(pool, policy, 'reply', 1, () => ({
              ...envelope,
              purpose: 'publish_reply',
              postId: parent.id,
              rootCommentId: root.id,
              text: 'Synthetic addressed reply',
            }))
          )[0]!;
          const exact = (
            await seedExactContent(
              pool,
              policy,
              'reply',
              1,
              () => ({
                ...envelope,
                purpose: 'publish_reply',
                postId: parent.id,
                rootCommentId: root.id,
                targetReplyId: addressed.id,
                text: 'Synthetic exact reply',
              }),
              { id: () => sharedId },
            )
          )[0]!;
          await setReviewState(pool, addressed.decision, 'held');
          for (const kind of ['post', 'comment', 'reply'] as const)
            await seedExactLikes(pool, owner.accountId, kind, [sharedId], true);
          assert.equal(exact.id, parent.id);
          assert.equal(root.id, parent.id);
          known(await getLikes(owner), 'visibleLikedCount', 3);
          await pool.query(
            "UPDATE whaleu_safety.account_heads SET block_coverage='missing' WHERE account_id=$1",
            [owner.accountId],
          );
          try {
            known(await getLikes(owner), 'visibleLikedCount', 3);
          } finally {
            await pool.query(
              "UPDATE whaleu_safety.account_heads SET block_coverage='complete' WHERE account_id=$1",
              [owner.accountId],
            );
          }
        },
      );
      await t.test(
        'unsupported canonical media remains unknown against scalar owner policy',
        async () => {
          const owner = await createAuthor(),
            envelope = await template(owner);
          await seedExactContent(pool, policy, 'post', 1, () => envelope);
          const media = (
            await seedExactContent(
              pool,
              policy,
              'post',
              1,
              () => ({
                ...envelope,
                images: [{ assetId: randomUUID(), digest: 'a'.repeat(64) }],
              }),
              { time: () => '1800-01-01T00:00:00.000Z' },
            )
          )[0]!;
          await assert.rejects(
            () =>
              app!
                .get(DatabaseService)
                .transaction((tx) =>
                  app!
                    .get(CommunityAccessService)
                    .accessiblePost(media.id, reader4097.accountId, tx),
                ),
            (error) =>
              error instanceof ApplicationError &&
              error.code === 'COMMUNITY_UNAVAILABLE',
          );
          const response = await getProfile(owner);
          assert.equal(response.status, 200);
          assert.equal(response.body.postCountStatus, 'unavailable');
          const page = await getPosts(owner);
          assert.equal(page.status, 200);
          assert.equal(page.body.items.length, 1);
          assert.equal(page.body.totalStatus, 'unavailable');
          await pool.query(
            "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
            [media.id],
          );
          known(await getProfile(owner), 'postCount', 1);
        },
      );
      await t.test(
        'resource cancellation stays optional, SQL programming errors are never converted to an unavailable count',
        async () => {
          let fired = false;
          observer!.setHook(async (event, tx) => {
            if (!fired && /LIMIT\s+257/i.test(event.sql)) {
              fired = true;
              await tx.query('SELECT pg_sleep(3)');
            }
          });
          try {
            const response = await getProfile();
            assert.equal(fired, true);
            assert.equal(response.status, 200);
            assert.equal(response.body.postCount, null);
            assert.equal(response.body.postCountStatus, 'unavailable');
            known(response, 'tradeCount', 0);
          } finally {
            observer!.setHook(null);
          }
          known(await getProfile(), 'postCount', 4097);
          fired = false;
          observer!.setHook(async (event, tx) => {
            if (!fired && /LIMIT\s+257/i.test(event.sql)) {
              fired = true;
              await tx.query('SELECT exact_count_deliberately_missing_column');
            }
          });
          try {
            const response = await getProfile();
            assert.equal(fired, true);
            assert.equal(response.status, 500);
            assert.ok(
              !JSON.stringify(response.body).includes(
                'exact_count_deliberately_missing_column',
              ),
            );
          } finally {
            observer!.setHook(null);
          }
          known(await getProfile(), 'postCount', 4097);
        },
      );
      await t.test(
        'final optional expiry preserves basics and durable guest reads still perform source proof',
        async () => {
          const expiringAuthor = await createAuthor(),
            envelope = await template(expiringAuthor);
          const expiresAt = new Date(Date.now() + 3000);
          await seedExactContent(pool, policy, 'post', 1, () => envelope, {
            visibilityUntil: expiresAt,
          });
          let waited = false;
          observer!.setHook(async (event, tx) => {
            if (!waited && event.sql === 'SET CONSTRAINTS ALL IMMEDIATE') {
              waited = true;
              await tx.query(
                'SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-clock_timestamp()))))',
                [expiresAt],
              );
            }
          });
          try {
            const response = await getProfile(expiringAuthor, null);
            assert.equal(response.status, 200);
            assert.equal(waited, true);
            assert.equal(response.body.status, 'available');
            assert.equal(response.body.postCount, null);
            assert.equal(response.body.postCountStatus, 'unavailable');
            known(response, 'tradeCount', 0);
          } finally {
            observer!.setHook(null);
          }
          let fenced = false;
          observer!.setHook(async (event) => {
            if (/pg_try_advisory_xact_lock_shared/.test(event.sql))
              fenced = true;
          });
          try {
            known(await getProfile(author4097, null), 'postCount', 4097);
            assert.equal(
              fenced,
              true,
              'Guest durable review with no expiry must validate versions',
            );
          } finally {
            observer!.setHook(null);
          }
        },
      );
      await t.test(
        'unrelated direct writer cannot create a blended count and baseline recovers',
        async () => {
          let triggered = false;
          observer!.setHook(async (event) => {
            if (
              !triggered &&
              /LIMIT\s+257/i.test(event.sql) &&
              /whaleu_community\.posts/.test(event.sql)
            ) {
              triggered = true;
              await pool.query(
                "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
                [other[0]!.id],
              );
            }
          });
          try {
            const response = await getProfile();
            assert.equal(response.status, 200);
            assert.equal(triggered, true);
            assert.equal(response.body.postCountStatus, 'unavailable');
            assert.equal(response.body.postCount, null);
          } finally {
            observer!.setHook(null);
            await pool.query(
              "UPDATE whaleu_community.posts SET visibility='approved' WHERE id=$1",
              [other[0]!.id],
            );
          }
          known(await getProfile(), 'postCount', 4097);
          for (const intervalMs of [500, 100, 10]) {
            let running = true,
              writes = 0,
              writerMaximumMs = 0;
            const writer = (async () => {
              while (running) {
                const start = performance.now();
                await pool.query(
                  "UPDATE whaleu_community.posts SET visibility=CASE visibility WHEN 'approved' THEN 'hidden' ELSE 'approved' END WHERE id=$1",
                  [other[0]!.id],
                );
                writes++;
                writerMaximumMs = Math.max(
                  writerMaximumMs,
                  performance.now() - start,
                );
                await sleep(intervalMs);
              }
            })();
            let knownCounts = 0;
            try {
              for (let i = 0; i < 3; i++) {
                const result = await observer!.measure(
                  `profile-4097-unrelated-writer-${intervalMs}ms-${i}`,
                  async () => getProfile(),
                );
                emit(result.measurement, result.value.body);
                assert.equal(result.value.status, 200);
                if (result.value.body.postCountStatus === 'known') {
                  assert.equal(result.value.body.postCount, 4097);
                  knownCounts++;
                } else assert.equal(result.value.body.postCount, null);
              }
            } finally {
              running = false;
              await writer;
              await pool.query(
                "UPDATE whaleu_community.posts SET visibility='approved' WHERE id=$1",
                [other[0]!.id],
              );
            }
            t.diagnostic(
              JSON.stringify({
                unrelatedWriter: {
                  countAttempts: 3,
                  knownCounts,
                  writes,
                  writerMaximumMs,
                  intervalMs,
                  meaning:
                    'Any absent count is a measured operational availability gap, not a passing scalability claim',
                },
              }),
            );
          }
          known(await getProfile(), 'postCount', 4097);
        },
      );
      await t.test(
        'long visible prefix becomes unknown honestly and sparse history retains its sole old member',
        async () => {
          const unbound = randomUUID();
          await pool.query(
            "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy,published_at) VALUES($1,$2,$3,'discussion','Synthetic unknown after complete prefix','named','open','1500-01-01')",
            [unbound, scope.home.spaceId, author4097.accountId],
          );
          try {
            const response = await getProfile();
            assert.equal(response.status, 200);
            assert.equal(response.body.postCountStatus, 'unavailable');
            assert.equal(response.body.postCount, null);
            const page = await getPosts();
            assert.equal(page.status, 200);
            assert.equal(page.body.items.length, 1);
            assert.equal(page.body.totalStatus, 'unavailable');
          } finally {
            await pool.query(
              "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
              [unbound],
            );
          }
          known(await getProfile(), 'postCount', 4097);
          const sparseAuthor = await createAuthor(),
            envelope = await template(sparseAuthor);
          const sparse = await seedExactContent(
            pool,
            policy,
            'post',
            1500,
            () => envelope,
            { state: (i) => (i === 1499 ? 'allow' : 'held') },
          );
          known(await getProfile(sparseAuthor), 'postCount', 1);
          const first = await getPosts(sparseAuthor);
          known(first, 'total', 1);
          assert.equal(first.body.items.length, 0);
          assert.equal(first.body.continuation, 'scan_pending');
          let cursor = first.body.nextCursor as string | null,
            found: string | null = null,
            hops = 0;
          while (cursor) {
            const next = await getPosts(sparseAuthor, { limit: '1', cursor });
            known(next, 'total', 1);
            if (next.body.items.length) found = next.body.items[0].id;
            cursor = next.body.nextCursor;
            assert.ok(++hops < 20, 'Bounded scan continuation makes progress');
          }
          assert.equal(found, sparse[1499]!.id);
        },
      );
      await t.test(
        'nonfinite historical timestamps at a256-row boundary are unavailable, never a partial exact count',
        async () => {
          const owner = await createAuthor(),
            envelope = await template(owner);
          const records = await seedExactContent(
            pool,
            policy,
            'post',
            258,
            () => envelope,
            {
              time: (i) => (i < 257 ? 'infinity' : '2020-01-01T00:00:00.000Z'),
            },
          );
          assert.equal(
            (
              await pool.query<{ n: number }>(
                'SELECT count(*)::int n FROM whaleu_community.posts WHERE account_id=$1 AND NOT isfinite(published_at)',
                [owner.accountId],
              )
            ).rows[0]!.n,
            257,
          );
          await app!
            .get(DatabaseService)
            .transaction((tx) =>
              app!
                .get(CommunityAccessService)
                .accessiblePost(records[0]!.id, reader4097.accountId, tx),
            );
          const response = await getProfile(owner);
          assert.equal(response.status, 200);
          assert.equal(response.body.postCountStatus, 'unavailable');
          assert.equal(response.body.postCount, null);
          known(response, 'tradeCount', 0);
        },
      );
      await t.test(
        'unsupported older liked coordinates only clear the optional complete count',
        async () => {
          const owner = await createAuthor(),
            envelope = await template(owner);
          const records = await seedExactContent(
            pool,
            policy,
            'post',
            2,
            () => envelope,
          );
          await pool.query(
            `INSERT INTO whaleu_community.post_likes(post_id,account_id,liked_at)
             VALUES($1,$3,'2020-01-01'::timestamptz),($2,$3,'0001-01-01 BC'::timestamptz)`,
            [records[0]!.id, records[1]!.id, owner.accountId],
          );
          const response = await getLikes(owner, { limit: '1' });
          assert.equal(response.status, 200, JSON.stringify(response.body));
          assert.equal(response.body.items.length, 1);
          assert.equal(response.body.items[0].targetId, records[0]!.id);
          assert.equal(response.body.visibleLikedCount, null);
          assert.equal(response.body.visibleLikedCountStatus, 'unavailable');
          assert.equal(response.body.continuation, 'more');
          assert.ok(response.body.nextCursor);
        },
      );
      await t.test(
        'HTTP explicitly selects READ COMMITTED when new connections default to REPEATABLE READ',
        async () => {
          observer!.restore();
          await app!.close();
          app = undefined;
          await pool.query(
            "ALTER DATABASE whaleu_test SET default_transaction_isolation TO 'repeatable read'",
          );
          try {
            await start();
            observer = observeExactQueries(app!);
            const result = await observer.measure(
              'profile-4097-server-default-repeatable-read',
              async () => getProfile(),
            );
            emit(result.measurement, result.value.body);
            known(result.value, 'postCount', 4097);
            assert.ok(
              result.measurement.begins.every((x) => x === 'read committed'),
            );
            known(await getLikes(), 'visibleLikedCount', 4097);
          } finally {
            await pool.query(
              'ALTER DATABASE whaleu_test RESET default_transaction_isolation',
            );
            observer?.restore();
            await (app as INestApplication | undefined)?.close();
            app = undefined;
            await start();
            observer = observeExactQueries(app!);
          }
        },
      );
      await t.test(
        'restart preserves opaque cursor paging and exact totals',
        async () => {
          const first = await getPosts();
          known(first, 'total', 4097);
          const cursor = first.body.nextCursor as string,
            id = first.body.items[0].id;
          observer!.restore();
          await app!.close();
          app = undefined;
          await start();
          observer = observeExactQueries(app!);
          const next = await getPosts(author4097, { limit: '1', cursor });
          known(next, 'total', 4097);
          assert.notEqual(next.body.items[0].id, id);
          known(await getLikes(), 'visibleLikedCount', 4097);
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
