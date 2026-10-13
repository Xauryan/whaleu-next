import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { relatedSyncRuntimeFixture } from '../support/related-sync-fixtures.js';
import { observeExactQueries } from '../support/exact-discovery-counts.js';
import { explainRelatedCandidatePlans } from '../support/related-sync-discovery-plans.js';
import type { RelatedCandidatePlan } from '../support/related-sync-discovery-plans.js';
import {
  appendTopologyRevision,
  setRegionPolicy,
} from '../support/community-scope-fixtures.js';
import { CommunityDistributionService } from '../../src/community/related-sync/service.js';
import { DatabaseService } from '../../src/database/database.js';
import {
  CommunityDiscoveryCounts,
  bindDiscoveryCount,
} from '../../src/community/discovery-counts.js';
import { HotFeedProcessing } from '../../src/community/hot-score/processing.js';
import type { PostView } from '../../src/community/contracts.js';
import type { SearchHit } from '../../src/community/search/contracts.js';

const errorCode = (response: { body: { error?: { code?: string } } }) =>
  response.body.error?.code;
const ids = (items: PostView[]) => items.map((item) => item.id).sort();

test(
  'related discovery: canonical A/B graph, exact category, hot/search/count, incomplete scope and topology restarts',
  { timeout: 240000 },
  async (t) => {
    const f = await relatedSyncRuntimeFixture({
      HOT_FEED_PROCESSING: 'manual_only',
    });
    try {
      assert.ok(
        f.app.get(CommunityDistributionService),
        'real AppModule must bind the canonical distribution owner',
      );
      await setRegionPolicy(f.pool, f.scope.home.regionId, {
        relatedSyncEnabled: true,
        unverifiedCommentEnabled: true,
      });
      const author = await f.actor(),
        reader = await f.actor({ campusId: f.scope.related.campusId });
      const auth = `Bearer ${author.accessToken}`,
        readAuth = `Bearer ${reader.accessToken}`;
      const publish = async (text: string, sync = true) => {
        const input = {
          clientRequestId: randomUUID(),
          spaceId: f.scope.home.spaceId,
          category: 'discussion',
          text,
          authorMode: 'named',
          commentsPolicy: 'open',
          imageAssetIds: [],
          ...(sync ? { syncToRelatedCampuses: true } : {}),
        };
        const review = await request(f.app.getHttpServer())
          .post('/v1/community/reviews/posts')
          .set('Authorization', auth)
          .send(input);
        assert.equal(review.status, 200, JSON.stringify(review.body));
        await f.decide(author.accountId, input.clientRequestId);
        const created = await request(f.app.getHttpServer())
          .post('/v1/community/posts')
          .set('Authorization', auth)
          .send(input);
        assert.equal(created.status, 201, JSON.stringify(created.body));
        assert.equal(created.body.outcome, 'created');
        return created.body.resourceId as string;
      };
      const synced = [
        await publish('Related needle first'),
        await publish('Related needle second'),
      ];
      const local = await publish('Local needle canonical only', false);
      const feed = (
        spaceId: string,
        extra: Record<string, unknown> = {},
        authenticated = true,
      ) => {
        const call = request(f.app.getHttpServer())
          .get('/v1/community/posts')
          .query({ spaceId, ...extra });
        return authenticated ? call.set('Authorization', readAuth) : call;
      };
      const search = (spaceId: string, extra: Record<string, unknown> = {}) =>
        request(f.app.getHttpServer())
          .get('/v1/community/search')
          .set('Authorization', readAuth)
          .query({ spaceId, q: 'needle', type: 'post', ...extra });
      const hot = (spaceId: string, extra: Record<string, unknown> = {}) =>
        request(f.app.getHttpServer())
          .get('/v1/community/hot')
          .set('Authorization', readAuth)
          .query({ spaceId, range: 'history', ...extra });
      const canonicalCount = () =>
        f.app.get(DatabaseService).transaction(
          async (tx) => {
            const count = await f.app
              .get(CommunityDiscoveryCounts)
              .profile(author.accountId, reader.accountId, 'posts', tx);
            const result: {
              status: 'known' | 'unavailable';
              value: number | null;
            } = { status: count.status, value: count.value };
            bindDiscoveryCount(tx, count, () => {
              result.status = 'unavailable';
              result.value = null;
            });
            return result;
          },
          { isolationLevel: 'read committed' },
        );

      await t.test(
        'A/B retain one original source; foreign C and mismatching categories do not acquire projections',
        async () => {
          const original = await feed(f.scope.home.spaceId),
            related = await feed(f.scope.related.spaceId),
            foreign = await feed(f.scope.foreign.spaceId);
          for (const response of [original, related, foreign]) {
            assert.equal(response.status, 200, JSON.stringify(response.body));
            assert.equal(response.body.relatedCampusDistribution, 'complete');
          }
          assert.deepEqual(ids(original.body.items), [...synced, local].sort());
          assert.deepEqual(ids(related.body.items), [...synced].sort());
          assert.deepEqual(foreign.body.items, []);
          for (const item of related.body.items as PostView[]) {
            assert.equal(item.space.id, f.scope.home.spaceId);
            assert.equal(item.isRelatedCampusSync, true);
            assert.deepEqual(item.sourceRegion, {
              id: f.scope.home.regionId,
              name: 'Synthetic home region',
            });
            assert.ok(!JSON.stringify(item).includes(f.scope.home.campusId));
            assert.ok(
              !JSON.stringify(item).includes(f.scope.topologySnapshotId),
            );
          }
          for (const item of original.body.items as PostView[]) {
            assert.equal(item.isRelatedCampusSync, false);
            assert.equal(item.sourceRegion, undefined);
          }
          assert.deepEqual(
            ids((await feed(f.scope.related.spaceId, {}, false)).body.items),
            [...synced].sort(),
          );
          assert.deepEqual(
            (await feed(f.scope.related.spaceId, { category: 'scenery' })).body
              .items,
            [],
          );
          const detail = await request(f.app.getHttpServer())
            .get(`/v1/community/posts/${synced[0]}`)
            .set('Authorization', readAuth)
            .query({ viewSpaceId: f.scope.related.spaceId });
          assert.equal(detail.status, 200, JSON.stringify(detail.body));
          assert.equal(detail.body.space.id, f.scope.home.spaceId);
          assert.equal(detail.body.isRelatedCampusSync, true);
          const nonsync = await request(f.app.getHttpServer())
            .get(`/v1/community/posts/${local}`)
            .set('Authorization', readAuth)
            .query({ viewSpaceId: f.scope.related.spaceId });
          assert.equal(nonsync.status, 404);
        },
      );

      await t.test(
        'lexical/hot candidates use current view while canonical all-search and exact profile count deduplicate',
        async () => {
          const searched = await search(f.scope.related.spaceId);
          assert.equal(searched.status, 200, JSON.stringify(searched.body));
          assert.deepEqual(
            (searched.body.items as SearchHit[])
              .map((hit) => hit.postId)
              .sort(),
            [...synced].sort(),
          );
          assert.ok(
            (searched.body.items as SearchHit[]).every(
              (hit) =>
                hit.space.id === f.scope.home.spaceId &&
                hit.isRelatedCampusSync === true,
            ),
          );
          const broad = await request(f.app.getHttpServer())
            .get('/v1/community/search')
            .set('Authorization', readAuth)
            .query({ scope: 'all', q: 'needle', type: 'post' });
          assert.equal(broad.status, 200, JSON.stringify(broad.body));
          assert.deepEqual(
            (broad.body.items as SearchHit[]).map((hit) => hit.postId).sort(),
            [...synced, local].sort(),
          );
          assert.equal(broad.body.relatedCampusDistribution, undefined);
          assert.deepEqual(await canonicalCount(), {
            status: 'known',
            value: 3,
          });
          const processed = await f.app
            .get(HotFeedProcessing)
            .processSelected([...synced, local]);
          assert.equal(processed.failed, 0);
          assert.equal(processed.blocked, 0);
          assert.equal(processed.current, 3);
          const ranked = await hot(f.scope.related.spaceId);
          assert.equal(ranked.status, 200, JSON.stringify(ranked.body));
          assert.deepEqual(ids(ranked.body.items), [...synced].sort());
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_post_hotness.scores WHERE post_id=ANY($1::uuid[])',
                [synced],
              )
            ).rows[0].n,
            2,
          );
        },
      );

      await t.test(
        'actual candidate plans retain canonical roots, shared scope observation and bounded continuation/count seeks',
        async () => {
          const observer = observeExactQueries(f.app);
          const plans: RelatedCandidatePlan[] = [];
          let label = '',
            membershipReads = 0;
          observer.setHook(async (event) => {
            if (
              event.sql ===
              'SELECT whaleu_campus.community_distribution_group($1) AS fact'
            )
              membershipReads++;
            const maximumRows = event.sql.startsWith(
              'SELECT p.* FROM whaleu_community.posts p JOIN',
            )
              ? 32
              : event.sql.startsWith(
                    'SELECT id,kind,"spaceId","postId","rootCommentId",at FROM',
                  )
                ? 129
                : event.sql.includes(
                      'FROM whaleu_post_hotness.scores hs JOIN whaleu_community.posts p',
                    )
                  ? 129
                  : /LIMIT\s+257/.test(event.sql) &&
                      !event.sql.includes('count_snapshot_source')
                    ? 257
                    : null;
            if (
              maximumRows !== null &&
              !plans.some((plan) => plan.label === label)
            )
              plans.push({
                label,
                sql: event.sql,
                values: event.values,
                maximumRows,
              });
            if (
              label === 'canonical-profile-count' &&
              event.sql.includes('count_snapshot_source') &&
              event.sql.includes('related_sync_binding_valid')
            ) {
              assert.equal(
                event.rows,
                2,
                'count batch proves each related root once',
              );
              assert.deepEqual(
                [...(event.values[0] as string[])].sort(),
                [...synced].sort(),
              );
              const proofLabel = 'canonical-count-native-binding-proof';
              if (!plans.some((plan) => plan.label === proofLabel))
                plans.push({
                  label: proofLabel,
                  sql: event.sql,
                  values: event.values,
                  maximumRows: 256,
                });
            }
          });
          try {
            for (const [kind, read] of [
              ['feed', feed],
              ['search', search],
              ['hot', hot],
            ] as const) {
              label = `${kind}-first`;
              membershipReads = 0;
              const first = await read(f.scope.related.spaceId, { limit: '1' });
              assert.equal(first.status, 200, JSON.stringify(first.body));
              assert.equal(
                membershipReads,
                1,
                `${label}: one shared topology observation, independent of root count`,
              );
              assert.equal(first.body.items.length, 1);
              assert.ok(first.body.nextCursor);
              label = `${kind}-continuation`;
              membershipReads = 0;
              const next = await read(f.scope.related.spaceId, {
                limit: '1',
                cursor: first.body.nextCursor,
              });
              assert.equal(next.status, 200, JSON.stringify(next.body));
              assert.equal(
                membershipReads,
                1,
                `${label}: continuation must re-observe current scope once`,
              );
              const returned = [...first.body.items, ...next.body.items].map(
                (item: PostView | SearchHit) =>
                  'contentId' in item ? item.postId : item.id,
              );
              assert.deepEqual(returned.sort(), [...synced].sort());
              assert.equal(
                new Set(returned).size,
                2,
                'destination projection must never multiply one root',
              );
            }
            label = 'canonical-profile-count';
            membershipReads = 0;
            assert.deepEqual(await canonicalCount(), {
              status: 'known',
              value: 3,
            });
            assert.equal(
              membershipReads,
              0,
              'canonical aggregate must not depend on current destination membership',
            );
          } finally {
            observer.restore();
          }
          assert.deepEqual(plans.map((plan) => plan.label).sort(), [
            'canonical-count-native-binding-proof',
            'canonical-profile-count',
            'feed-continuation',
            'feed-first',
            'hot-continuation',
            'hot-first',
            'search-continuation',
            'search-first',
          ]);
          for (const plan of plans.filter((item) =>
            item.label.endsWith('-continuation'),
          ))
            assert.ok(
              plan.values.some(
                (value) => typeof value === 'string' && synced.includes(value),
              ),
              'actual continuation binds a canonical source ID',
            );
          await explainRelatedCandidatePlans(f.pool, plans, (message) =>
            t.diagnostic(message),
          );

          const names = [
            'related_posts_scope_page',
            'post_distribution_original',
            'posts_feed',
            'posts_public_profile_keyset',
            'posts_search_chronological',
            'hot_scores_order',
          ];
          const indexes = await f.pool.query<{
            indexname: string;
            indexdef: string;
          }>(
            'SELECT indexname,indexdef FROM pg_indexes WHERE schemaname=ANY($1::text[]) AND indexname=ANY($2::text[]) ORDER BY indexname',
            [['whaleu_community', 'whaleu_post_hotness'], names],
          );
          assert.deepEqual(
            indexes.rows.map((row) => row.indexname),
            [...names].sort(),
          );
          assert.match(
            indexes.rows.find(
              (row) => row.indexname === 'related_posts_scope_page',
            )!.indexdef,
            /space_id, category, published_at DESC, id DESC.*publication_envelope_version = 4/,
          );
          const inventory = await f.pool.query<{
            relation: string;
            function: string;
            type: number;
          }>(
            `SELECT t.tgrelid::regclass::text AS relation,t.tgfoid::regproc::text AS function,t.tgtype::int AS type
             FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled<>'D' AND
             ((t.tgrelid=ANY($1::regclass[]) AND t.tgfoid='whaleu_community.advance_discovery_count_epoch()'::regprocedure)
              OR (t.tgrelid=ANY($2::regclass[]) AND t.tgname='a000_related_distribution_generation')
              OR (t.tgrelid='whaleu_community.spaces'::regclass AND t.tgname='a000_related_view_generation')) ORDER BY relation`,
            [
              [
                'whaleu_community.post_distribution_bindings',
                'whaleu_community.related_sync_policies',
                'whaleu_community.related_sync_policy_heads',
                'whaleu_community.report_origins',
                'whaleu_community.publication_requests',
              ],
              [
                'whaleu_campus.community_topology_snapshots',
                'whaleu_campus.community_topology_heads',
                'whaleu_campus.operating_regions',
              ],
            ],
          );
          assert.equal(
            inventory.rows.length,
            9,
            'new binding/policy count sources and topology/catalog generation sources must all be enrolled',
          );
          assert.ok(
            inventory.rows.every((row) => row.type === 62),
            'BEFORE STATEMENT INSERT/UPDATE/DELETE/TRUNCATE must include zero-row writers',
          );
          t.diagnostic(
            JSON.stringify({
              relatedDiscoveryInventory: {
                indexes: indexes.rows,
                sources: inventory.rows,
              },
            }),
          );
        },
      );

      await t.test(
        'origin disables only new issuance; topology withdrawal invalidates all continuations, and new C receives old canonical posts',
        async () => {
          await setRegionPolicy(f.pool, f.scope.home.regionId, {
            relatedSyncEnabled: false,
          });
          assert.deepEqual(
            ids((await feed(f.scope.related.spaceId)).body.items),
            [...synced].sort(),
          );
          const before = await feed(f.scope.related.spaceId, { limit: '1' });
          const searchBefore = await search(f.scope.related.spaceId, {
            limit: '1',
          });
          const hotBefore = await hot(f.scope.related.spaceId, { limit: '1' });
          assert.ok(before.body.nextCursor);
          assert.ok(searchBefore.body.nextCursor);
          assert.ok(hotBefore.body.nextCursor);
          const topology = structuredClone(f.scope.topology);
          const aGroup = topology.regions.find(
            (row) => row.regionId === f.scope.home.regionId,
          )!.groupId;
          const cGroup = topology.regions.find(
            (row) => row.regionId === f.scope.foreign.regionId,
          )!.groupId;
          topology.regions.find(
            (row) => row.regionId === f.scope.related.regionId,
          )!.groupId = cGroup;
          topology.regions.find(
            (row) => row.regionId === f.scope.foreign.regionId,
          )!.groupId = aGroup;
          await appendTopologyRevision(f.pool, topology);
          assert.equal(
            (
              await feed(f.scope.related.spaceId, {
                limit: '1',
                cursor: before.body.nextCursor,
              })
            ).status,
            400,
          );
          // Current topology is part of the opaque scope hash. Preserve the
          // existing scope-mismatch 400 contract; native continuation handlers
          // clear old pagination on BAD_REQUEST as well as 409 restart errors.
          for (const response of [
            await search(f.scope.related.spaceId, {
              limit: '1',
              cursor: searchBefore.body.nextCursor,
            }),
            await hot(f.scope.related.spaceId, {
              limit: '1',
              cursor: hotBefore.body.nextCursor,
            }),
          ]) {
            assert.equal(response.status, 400, JSON.stringify(response.body));
            assert.equal(errorCode(response), 'BAD_REQUEST');
            assert.deepEqual(Object.keys(response.body), ['error']);
          }
          assert.deepEqual(
            (await feed(f.scope.related.spaceId)).body.items,
            [],
          );
          assert.deepEqual(
            (await search(f.scope.related.spaceId)).body.items,
            [],
          );
          assert.deepEqual((await hot(f.scope.related.spaceId)).body.items, []);
          assert.deepEqual(
            ids((await feed(f.scope.foreign.spaceId)).body.items),
            [...synced].sort(),
          );
          const source = await request(f.app.getHttpServer())
            .get(`/v1/community/posts/${synced[0]}`)
            .set('Authorization', readAuth);
          assert.equal(source.status, 200, JSON.stringify(source.body));
          assert.equal(source.body.isRelatedCampusSync, false);
          assert.equal(
            (
              await f.pool.query(
                'SELECT count(*)::int n FROM whaleu_community.post_distribution_bindings',
              )
            ).rows[0].n,
            2,
          );
          assert.deepEqual(await canonicalCount(), {
            status: 'known',
            value: 3,
          });
        },
      );

      await t.test(
        'unknown topology preserves honest local pages and canonical count without a false complete empty remote scope',
        async () => {
          await appendTopologyRevision(
            f.pool,
            structuredClone(f.scope.topology),
            { coverageState: 'missing' },
          );
          for (const response of [
            await feed(f.scope.related.spaceId),
            await search(f.scope.related.spaceId),
            await hot(f.scope.related.spaceId),
          ]) {
            assert.equal(response.status, 200, JSON.stringify(response.body));
            assert.equal(
              response.body.relatedCampusDistribution,
              'unavailable',
            );
            assert.deepEqual(response.body.items, []);
          }
          const original = await feed(f.scope.home.spaceId);
          assert.equal(original.status, 200, JSON.stringify(original.body));
          assert.equal(original.body.relatedCampusDistribution, 'unavailable');
          assert.deepEqual(ids(original.body.items), [...synced, local].sort());
          assert.deepEqual(await canonicalCount(), {
            status: 'known',
            value: 3,
          });
        },
      );
    } finally {
      await f.close();
    }
  },
);
