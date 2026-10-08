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
import { DatabaseService, poolOptions } from '../../src/database/database.js';
import { SafetyRepository } from '../../src/safety/repository.js';
import { enableSafetyRelationshipProof } from '../../src/safety/relationship-proof.js';
import { ApplicationError } from '../../src/http/application-error.js';
import {
  MIGRATION_LOCK,
  readMigrations,
  runMigrations,
} from '../../src/database/migrations.js';
import { configureHttp } from '../../src/http/http.js';
import {
  createRuntimeActor,
  setRuntimeVerification,
  postApprovalEnvelope,
} from '../support/community-runtime-fixtures.js';
import {
  seedCommunityScope,
  appendIdentitySelection,
} from '../support/community-scope-fixtures.js';
import { seedReviewPolicy } from '../support/community-approval-fixtures.js';
import {
  observeExactQueries,
  seedExactContent,
  seedExactLikes,
} from '../support/exact-discovery-counts.js';
import { migrationSchemaNames } from '../support/migration-schemas.js';

// Transparent post-query barriers with real AppModule owners and raw SQL writers.
// Raw transitions retain the actual owner audit constraints but deliberately do
// not take the service's common policy gate: the final mandatory proof must cover
// that documented gap independently of optional count availability.
test(
  'mandatory discovery relationships fail closed against raw block races',
  { timeout: 120000 },
  async (t) => {
    const database = process.env['TEST_DATABASE_URL'];
    assert.ok(database);
    const url = new URL(database);
    assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/whaleu_test');
    const config = loadConfig({
      NODE_ENV: 'test',
      DATABASE_URL: database,
      PG_SSL_MODE: 'disable',
      LOG_LEVEL: 'silent',
      PG_POOL_MAX: '12',
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
      assert.equal(locked, true);
      assert.equal(
        (
          await pool.query<{ n: number }>(
            "SELECT count(*)::integer n FROM pg_namespace WHERE nspname LIKE 'whaleu\\_%' ESCAPE '\\'",
          )
        ).rows[0]!.n,
        0,
      );
      owns = true;
      const migrations = await readMigrations(
        fileURLToPath(new URL('../../migrations', import.meta.url)),
      );
      await runMigrations(pool, migrations, { mode: 'up' });
      app = await NestFactory.create(AppModule.register(config), {
        logger: false,
      });
      configureHttp(app);
      await app.init();
      const scope = await seedCommunityScope(pool),
        policy = await seedReviewPolicy(pool);
      const createActor = async () => {
        const actor = await createRuntimeActor(app!);
        const response = await request(app!.getHttpServer())
          .patch('/v1/me/profile')
          .set('Authorization', `Bearer ${actor.accessToken}`)
          .send({
            expectedRevision: 0,
            nickname: 'ProofActor',
            bio: '',
          });
        assert.equal(response.status, 200, JSON.stringify(response.body));
        const reference = await request(app!.getHttpServer())
          .get('/v1/me/public-profile-ref')
          .set('Authorization', `Bearer ${actor.accessToken}`);
        assert.equal(reference.status, 200);
        return { ...actor, profileId: reference.body.profileId as string };
      };
      const author = await createActor();
      const verification = await setRuntimeVerification(
        pool,
        author.accountId,
        scope.institutionId,
        scope.home.regionId,
      );
      await appendIdentitySelection(
        pool,
        author.accountId,
        verification,
        scope,
      );
      const envelope = await postApprovalEnvelope(app, pool, author.accountId, {
        clientRequestId: randomUUID(),
        spaceId: scope.home.spaceId,
        category: 'discussion',
        text: 'Private selected content must not escape a late block',
        imageAssetIds: [],
        authorMode: 'named',
        commentsPolicy: 'open',
      });
      const post = (
        await seedExactContent(pool, policy, 'post', 1, () => envelope)
      )[0]!;
      observer = observeExactQueries(app);

      // Tiny fresh-fixture success gate: do not confuse bulk-seed autovacuum
      // contention with unrelated committed DML. Runtime maintenance stays on.
      const extra = await seedExactContent(
        pool,
        policy,
        'post',
        2,
        () => envelope,
      );
      const unrelated = await createActor();
      const other = [{ id: randomUUID() }];
      await pool.query(
        "INSERT INTO whaleu_community.posts(id,space_id,account_id,category,text,author_mode,comments_policy) VALUES($1,$2,$3,'discussion','Synthetic unrelated unreviewed writer source','named','open')",
        [other[0]!.id, scope.home.spaceId, unrelated.accountId],
      );
      const getProfile = (owner = author) =>
        request(app!.getHttpServer())
          .get(`/v1/profiles/${owner.profileId}`)
          .set('Authorization', `Bearer ${unrelated.accessToken}`);
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

      await t.test(
        'small exact counts survive unrelated committed source churn',
        async () => {
          const owner = author;
          await pool.query('VACUUM (ANALYZE)');
          let fired = false;
          let writer:
            Promise<{ durationMs: number; error?: unknown }> | undefined;
          let fenceStarted: number | null = null;
          observer!.setHook(async (event) => {
            if (
              !fired &&
              /LIMIT\s+257/i.test(event.sql) &&
              event.values[0] === owner.accountId
            ) {
              fired = true;
              await pool.query(
                "UPDATE whaleu_community.posts SET visibility='hidden' WHERE id=$1",
                [other[0]!.id],
              );
            }
            if (
              !writer &&
              event.sql.startsWith('LOCK TABLE') &&
              event.sql.includes('whaleu_community.posts')
            ) {
              fenceStarted = performance.now();
              const start = fenceStarted;
              writer = pool
                .query(
                  "UPDATE whaleu_community.posts SET visibility='approved' WHERE id=$1",
                  [other[0]!.id],
                )
                .then(
                  () => ({ durationMs: performance.now() - start }),
                  (error: unknown) => ({
                    durationMs: performance.now() - start,
                    error,
                  }),
                );
            }
          });
          try {
            known(await getProfile(owner), 'postCount', 3);
            assert.equal(fired, true);
            assert.ok(
              writer && fenceStarted !== null,
              'Final small-count fence was exercised',
            );
            const outcome = await writer;
            assert.equal(outcome.error, undefined);
            assert.ok(
              outcome.durationMs < 750,
              'Small500ms recount must not turn into a long writer stall',
            );
            t.diagnostic(
              JSON.stringify({
                smallCountFallbackWriter: {
                  candidates: 3,
                  recountBudgetMs: 500,
                  writerWaitAndExecuteMs: outcome.durationMs,
                  knownCount: 3,
                },
              }),
            );
          } finally {
            observer!.setHook(null);
            await writer;
            await pool.query(
              "UPDATE whaleu_community.posts SET visibility='approved' WHERE id=$1",
              [other[0]!.id],
            );
          }
        },
      );
      await t.test(
        'small final fences capture maintenance-mode and real writer conflicts without leaking a guessed total',
        async () => {
          const owner = author,
            records = [post, ...extra];
          await pool.query('VACUUM (ANALYZE)');
          for (const maintenance of [true, false]) {
            const blocker = await pool.connect();
            const beforeFailures = lockFailures.length;
            let fired = false;
            try {
              await blocker.query('BEGIN');
              const pid = (
                await blocker.query<{ pid: number }>(
                  'SELECT pg_backend_pid() AS pid',
                )
              ).rows[0]!.pid;
              if (maintenance)
                await blocker.query(
                  'LOCK TABLE whaleu_community.content_approval_decisions IN SHARE UPDATE EXCLUSIVE MODE',
                );
              else
                await blocker.query(
                  'UPDATE whaleu_community.posts SET visibility=visibility WHERE id=$1',
                  [records[0]!.id],
                );
              observer!.setHook(async (event) => {
                if (
                  !fired &&
                  /LIMIT\s+257/i.test(event.sql) &&
                  event.values[0] === owner.accountId
                ) {
                  fired = true;
                  await pool.query(
                    'UPDATE whaleu_community.posts SET visibility=visibility WHERE id=$1',
                    [other[0]!.id],
                  );
                }
              });
              const response = await getProfile(owner);
              assert.equal(response.status, 200, JSON.stringify(response.body));
              assert.equal(response.body.status, 'available');
              assert.equal(response.body.postCount, null);
              assert.equal(response.body.postCountStatus, 'unavailable');
              assert.equal(fired, true);
              if (maintenance) {
                fired = false;
                const page = await request(app!.getHttpServer())
                  .get(`/v1/profiles/${owner.profileId}/posts?limit=1`)
                  .set('Authorization', `Bearer ${unrelated.accessToken}`);
                assert.equal(page.status, 200, JSON.stringify(page.body));
                assert.equal(page.body.status, 'available');
                assert.equal(page.body.items.length, 1);
                assert.equal(page.body.total, null);
                assert.equal(page.body.totalStatus, 'unavailable');
                assert.equal(fired, true);
              }
              const conflicts = lockFailures
                .slice(beforeFailures)
                .flatMap((entry) => entry.holders);
              assert.ok(
                conflicts.some(
                  (holder) =>
                    holder['pid'] === pid &&
                    holder['mode'] ===
                      (maintenance
                        ? 'ShareUpdateExclusiveLock'
                        : 'RowExclusiveLock') &&
                    holder['relation'] ===
                      (maintenance
                        ? 'whaleu_community.content_approval_decisions'
                        : 'whaleu_community.posts'),
                ),
                'Actual pg_locks holder was captured',
              );
            } finally {
              observer!.setHook(null);
              await blocker.query('ROLLBACK');
              blocker.release();
            }
            known(await getProfile(owner), 'postCount', 3);
          }
        },
      );
      const writeBlock = async (
        blocker: string,
        blocked: string,
        source: string,
        active: boolean,
        id?: string,
      ) => {
        const client = await pool.connect(),
          relation = id ?? randomUUID();
        try {
          await client.query('BEGIN');
          if (id)
            await client.query(
              'UPDATE whaleu_safety.blocks SET active=$2,revision=revision+1 WHERE id=$1',
              [id, active],
            );
          else
            await client.query(
              `INSERT INTO whaleu_safety.blocks(id,blocker_id,blocked_id,active,revision,display_snapshot,source_kind,source_id)
          VALUES($1,$2,$3,$4,1,'Synthetic','profile',$5)`,
              [relation, blocker, blocked, active, source],
            );
          await client.query(
            `INSERT INTO whaleu_safety.events(id,account_id,relationship_id,kind,revision)
          SELECT $1,blocker_id,id,$2,revision FROM whaleu_safety.blocks WHERE id=$3`,
            [randomUUID(), active ? 'blocked' : 'unblocked', relation],
          );
          await client.query('COMMIT');
          return relation;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      };
      for (const endpoint of ['profile', 'page', 'liked'] as const)
        for (const mutation of ['insert', 'update'] as const)
          for (const direction of ['outgoing', 'incoming'] as const)
            await t.test(
              `${endpoint} ${mutation} ${direction} after scalar allow never returns stale private output`,
              async () => {
                const viewer = await createActor();
                if (endpoint === 'liked')
                  await seedExactLikes(
                    pool,
                    viewer.accountId,
                    'post',
                    [post.id],
                    true,
                  );
                const blocker =
                  direction === 'outgoing'
                    ? viewer.accountId
                    : author.accountId;
                const blocked =
                  direction === 'outgoing'
                    ? author.accountId
                    : viewer.accountId;
                const source =
                  direction === 'outgoing'
                    ? author.profileId
                    : viewer.profileId;
                let relation: string | undefined;
                if (mutation === 'update')
                  relation = await writeBlock(blocker, blocked, source, false);
                let fired = false;
                observer!.setHook(async (event) => {
                  if (
                    !fired &&
                    event.sql.startsWith(
                      'SELECT EXISTS(SELECT 1 FROM whaleu_safety.blocks',
                    ) &&
                    event.values[0] === viewer.accountId &&
                    event.values[1] === author.accountId
                  ) {
                    fired = true;
                    relation = await writeBlock(
                      blocker,
                      blocked,
                      source,
                      true,
                      relation,
                    );
                  }
                });
                try {
                  const path =
                    endpoint === 'profile'
                      ? `/v1/profiles/${author.profileId}`
                      : endpoint === 'page'
                        ? `/v1/profiles/${author.profileId}/posts?limit=1`
                        : '/v1/me/community/liked?limit=1';
                  const response = await request(app!.getHttpServer())
                    .get(path)
                    .set('Authorization', `Bearer ${viewer.accessToken}`);
                  assert.equal(
                    fired,
                    true,
                    'Actual scalar owner allow was crossed',
                  );
                  assert.equal(
                    response.status,
                    503,
                    JSON.stringify(response.body),
                  );
                  assert.ok(
                    ['SAFETY_UNAVAILABLE', 'COMMUNITY_UNAVAILABLE'].includes(
                      response.body.error.code,
                    ),
                  );
                  assert.equal(
                    JSON.stringify(response.body).includes(envelope.text),
                    false,
                  );
                  assert.equal('items' in response.body, false);
                  assert.equal('displayName' in response.body, false);
                } finally {
                  observer!.setHook(null);
                  if (relation)
                    await writeBlock(blocker, blocked, source, false, relation);
                }
              },
            );

      await t.test(
        'earlier allowed pair survives later deny and purpose-specific coalescing on real PostgreSQL',
        async () => {
          for (const mode of [
            'allow-then-deny',
            'direct-then-list',
            'list-only-incoming',
          ] as const) {
            const viewer = await createActor();
            const incoming = mode !== 'allow-then-deny';
            const blocker = incoming ? author.accountId : viewer.accountId;
            const blocked = incoming ? viewer.accountId : author.accountId;
            const source = incoming ? viewer.profileId : author.profileId;
            let relation: string | undefined;
            try {
              const work = app!.get(DatabaseService).transaction(
                async (tx) => {
                  enableSafetyRelationshipProof(tx);
                  const records = app!.get(SafetyRepository);
                  const firstPurpose =
                    mode === 'list-only-incoming'
                      ? 'list_projection'
                      : 'direct_post';
                  assert.deepEqual(
                    await records.directions(
                      viewer.accountId,
                      author.accountId,
                      firstPurpose,
                      tx,
                    ),
                    { outgoing: false, incoming: false },
                  );
                  relation = await writeBlock(blocker, blocked, source, true);
                  const later = await records.directions(
                    viewer.accountId,
                    author.accountId,
                    mode === 'allow-then-deny'
                      ? 'direct_post'
                      : 'list_projection',
                    tx,
                  );
                  assert.equal(later?.outgoing, !incoming);
                  assert.equal(later?.incoming, incoming);
                },
                { isolationLevel: 'read committed' },
              );
              if (mode === 'list-only-incoming') await work;
              else
                await assert.rejects(
                  work,
                  (error) =>
                    error instanceof ApplicationError &&
                    error.code === 'COMMUNITY_UNAVAILABLE',
                );
            } finally {
              if (relation)
                await writeBlock(blocker, blocked, source, false, relation);
            }
          }
        },
      );

      await t.test(
        'controlled profile block and unblock keep intended receipt behavior',
        async () => {
          const viewer = await createActor();
          await setRuntimeVerification(
            pool,
            viewer.accountId,
            scope.institutionId,
            scope.home.regionId,
          );
          const blocked = await request(app!.getHttpServer())
            .put('/v1/me/safety/blocks')
            .set('Authorization', `Bearer ${viewer.accessToken}`)
            .send({
              clientRequestId: randomUUID(),
              source: { kind: 'profile', id: author.profileId },
              blocked: true,
            });
          assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
          assert.equal(blocked.body.receipt.outcome, 'applied');
          assert.equal(blocked.body.current.blocked, true);
          const unblocked = await request(app!.getHttpServer())
            .put(`/v1/me/safety/blocks/${blocked.body.current.relationshipId}`)
            .set('Authorization', `Bearer ${viewer.accessToken}`)
            .send({
              clientRequestId: randomUUID(),
              expectedRevision: blocked.body.current.revision,
              blocked: false,
            });
          assert.equal(unblocked.status, 200, JSON.stringify(unblocked.body));
          assert.equal(unblocked.body.receipt.outcome, 'applied');
          assert.equal(unblocked.body.current.blocked, false);
        },
      );
      await t.test(
        'guest and self profile reads issue no mandatory named relationship reread',
        async () => {
          for (const token of [null, author.accessToken]) {
            let relationshipReads = 0;
            observer!.setHook(async (event) => {
              if (
                event.sql.includes(
                  'WITH ORDINALITY AS r(viewer,author,bilateral,ordinality)',
                )
              )
                relationshipReads++;
            });
            try {
              const req = request(app!.getHttpServer()).get(
                `/v1/profiles/${author.profileId}`,
              );
              if (token) req.set('Authorization', `Bearer ${token}`);
              const response = await req;
              assert.equal(response.status, 200, JSON.stringify(response.body));
              assert.equal(response.body.status, 'available');
              assert.equal(relationshipReads, 0);
            } finally {
              observer!.setHook(null);
            }
          }
        },
      );
    } finally {
      observer?.restore();
      await app?.close();
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
  },
);
