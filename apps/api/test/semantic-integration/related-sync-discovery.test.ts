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
import { installSemanticSearch } from '../../src/community/search/semantic/install.js';
import { createQwenSemanticProfile } from '../../src/community/search/semantic/profile.js';
import { QwenSemanticProvider } from '../../src/community/search/semantic/provider.js';
import type { QwenSemanticTransport } from '../../src/community/search/semantic/provider.js';
import {
  SemanticSearchEngine,
  fullCorpusScopeAuthority,
} from '../../src/community/search/semantic/engine.js';
import { SemanticIndexRepository } from '../../src/community/search/semantic/repository.js';
import { SemanticCorpusRepository } from '../../src/community/search/semantic/corpus-repository.js';
import {
  ContentReviewSearchEligibilityFacade,
  SEARCH_CONTENT_METADATA_LIMIT,
} from '../../src/community/content-review/search-eligibility.facade.js';
import { LocalApprovedContentVisibility } from '../../src/community/content-review/local-approved-content-visibility.js';
import { CampusContentScopeFacade } from '../../src/campus/content-scope.facade.js';
import { MediaContentSnapshotFacade } from '../../src/media/content-snapshot.facade.js';
import { SafetySearchEligibilityFacade } from '../../src/safety/search-eligibility.facade.js';
import { CommunityDistributionService } from '../../src/community/related-sync/service.js';
import { SearchService } from '../../src/community/search/service.js';
import { searchQuerySchema } from '../../src/community/search/contracts.js';

/** Optional pgvector, real canonical owners and deterministic in-memory models only. */
test(
  'related semantic corpus stays canonical, rejects unknown coverage and invalidates topology races before results',
  { timeout: 240000 },
  async (t) => {
    const f = await relatedSyncRuntimeFixture();
    let installed = false;
    try {
      assert.equal(await installSemanticSearch(f.pool), 'installed');
      installed = true;
      await setRegionPolicy(f.pool, f.scope.home.regionId, {
        relatedSyncEnabled: true,
        unverifiedCommentEnabled: true,
      });
      const author = await f.actor(),
        reader = await f.actor({ campusId: f.scope.related.campusId });
      const auth = `Bearer ${author.accessToken}`,
        readAuth = `Bearer ${reader.accessToken}`;
      const publish = async (text: string, sync: boolean) => {
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
      const remote = await publish('Shared semantic headphones', true),
        local = await publish('Canonical local headphones', false);
      const input = {
        clientRequestId: randomUUID(),
        text: 'Shared semantic child headphones',
        authorMode: 'named',
        imageAssetIds: [],
      };
      const reviewed = await request(f.app.getHttpServer())
        .post(`/v1/community/reviews/posts/${remote}/comments`)
        .set('Authorization', readAuth)
        .send(input);
      assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
      await f.decide(reader.accountId, input.clientRequestId);
      const child = await request(f.app.getHttpServer())
        .post(`/v1/community/posts/${remote}/comments`)
        .set('Authorization', readAuth)
        .send(input);
      assert.equal(child.status, 201, JSON.stringify(child.body));
      const commentId = child.body.resourceId as string;
      const profile = createQwenSemanticProfile({
        providerId: 'offline-related-fixture',
        deploymentId: 'synthetic',
        deploymentRevision: 'fixture-v1',
        embeddingModelRevision: 'fixture-v1',
        rerankerModelRevision: 'fixture-v1',
      });
      let modelCalls = 0;
      let duringRerank: (() => Promise<void>) | undefined;
      const transport: QwenSemanticTransport = {
        embed: async (envelope) => {
          modelCalls++;
          return {
            profileIdentity: envelope.profileIdentity,
            indexSpaceKey: envelope.indexSpaceKey,
            response: {
              model: envelope.request.model,
              data: envelope.request.input.map((_text, index) => ({
                index,
                embedding: Array.from({ length: 4096 }, (_, i) =>
                  i === 0 ? 1 : 0,
                ),
              })),
            },
          };
        },
        rerank: async (envelope) => {
          modelCalls++;
          const mutate = duringRerank;
          duringRerank = undefined;
          await mutate?.();
          return {
            profileIdentity: envelope.profileIdentity,
            indexSpaceKey: envelope.indexSpaceKey,
            response: {
              model: envelope.request.model,
              results: envelope.request.documents.map((doc, index) => ({
                index,
                id: doc.id,
                score: 10 - index,
              })),
            },
          };
        },
      };
      const searches = f.app.get(SearchService),
        index = new SemanticIndexRepository();
      const certificates = new ContentReviewSearchEligibilityFacade(
        f.app.get(LocalApprovedContentVisibility),
        f.app.get(CampusContentScopeFacade),
        f.app.get(MediaContentSnapshotFacade),
        f.app.get(CommunityDistributionService),
      );
      assert.equal(
        (
          certificates as unknown as {
            distribution: CommunityDistributionService;
          }
        ).distribution,
        f.app.get(CommunityDistributionService),
        'full-corpus eligibility must use the actual AppModule distribution singleton',
      );
      const corpus = new SemanticCorpusRepository(
        f.app.get(SafetySearchEligibilityFacade),
      );
      const engine = new SemanticSearchEngine(
        new QwenSemanticProvider(profile, transport),
        index,
        fullCorpusScopeAuthority(
          searches,
          index,
          certificates,
          corpus,
          profile,
        ),
        'local_fixture',
        certificates,
      );
      const all = searchQuerySchema.parse({
        scope: 'all',
        q: 'headphones',
        type: 'all',
      });
      const regional = (spaceId: string) =>
        searchQuerySchema.parse({ spaceId, q: 'headphones', type: 'all' });
      const vectorCount = async () =>
        Number(
          (
            await f.pool.query(
              'SELECT count(*)::int n FROM whaleu_semantic.embeddings WHERE index_space_key=$1',
              [profile.indexSpaceKey],
            )
          ).rows[0].n,
        );

      await t.test(
        'index once by canonical source; complete B corpus includes root and inherited child, never local none root',
        async () => {
          assert.deepEqual(await engine.indexScope(reader.accessToken, all), {
            indexed: 3,
          });
          assert.equal(await vectorCount(), 3);
          const result = await engine.search(
            reader.accessToken,
            regional(f.scope.related.spaceId),
          );
          assert.equal(result.mode, 'exact-full-corpus-v1');
          assert.deepEqual(
            result.items.map((hit) => hit.contentId).sort(),
            [remote, commentId].sort(),
          );
          assert.ok(
            result.items.every(
              (hit) =>
                hit.space.id === f.scope.home.spaceId &&
                hit.isRelatedCampusSync === true,
            ),
          );
          assert.deepEqual(
            (
              await engine.search(
                reader.accessToken,
                regional(f.scope.foreign.spaceId),
              )
            ).items,
            [],
          );
          assert.deepEqual(
            (await engine.search(reader.accessToken, all)).items
              .map((hit) => hit.contentId)
              .sort(),
            [remote, local, commentId].sort(),
          );
        },
      );

      await t.test(
        'full-scope metadata planning observes membership once per fresh phase and retains canonical source cardinality',
        async () => {
          const observer = observeExactQueries(f.app);
          const plans: RelatedCandidatePlan[] = [];
          let membershipReads = 0;
          observer.setHook(async (event) => {
            if (
              event.sql ===
              'SELECT whaleu_campus.community_distribution_group($1) AS fact'
            )
              membershipReads++;
            if (event.sql.startsWith('WITH structural AS (')) {
              assert.equal(
                event.rows,
                2,
                'one canonical root and one child, not one copy per destination',
              );
              plans.push({
                label: `semantic-full-scope-phase-${plans.length + 1}`,
                sql: event.sql,
                values: event.values,
                maximumRows: SEARCH_CONTENT_METADATA_LIMIT + 1,
              });
            }
          });
          try {
            const result = await observer.measure('related-full-scope', () =>
              engine.search(
                reader.accessToken,
                regional(f.scope.related.spaceId),
              ),
            );
            assert.deepEqual(
              result.value.items.map((hit) => hit.contentId).sort(),
              [remote, commentId].sort(),
            );
            assert.equal(
              membershipReads,
              3,
              'preflight, pre-model corpus and final corpus each re-observe once',
            );
            assert.equal(membershipReads, result.measurement.begins.length);
            assert.equal(
              plans.length,
              2,
              'both full-corpus phases must prove complete membership',
            );
            assert.equal(
              await vectorCount(),
              3,
              'read phases never create destination embeddings',
            );
          } finally {
            observer.restore();
          }
          await explainRelatedCandidatePlans(f.pool, plans, (message) =>
            t.diagnostic(message),
          );
        },
      );

      await t.test(
        'a missing eligible embedding is unavailable, never complete or zero',
        async () => {
          await f.pool.query(
            "DELETE FROM whaleu_semantic.embeddings WHERE index_space_key=$1 AND kind='post' AND content_id=$2",
            [profile.indexSpaceKey, remote],
          );
          await assert.rejects(
            engine.search(
              reader.accessToken,
              regional(f.scope.related.spaceId),
            ),
            { code: 'COMMUNITY_UNAVAILABLE' },
          );
          assert.deepEqual(await engine.indexScope(reader.accessToken, all), {
            indexed: 3,
          });
          assert.equal(await vectorCount(), 3);
        },
      );

      await t.test(
        'topology changes during model work invalidate old scope; new C can retrieve old embeddings without reindexing',
        async () => {
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
          duringRerank = async () => {
            await appendTopologyRevision(f.pool, topology);
          };
          await assert.rejects(
            engine.search(
              reader.accessToken,
              regional(f.scope.related.spaceId),
            ),
            { code: 'COMMUNITY_UNAVAILABLE' },
          );
          assert.deepEqual(
            (
              await engine.search(
                reader.accessToken,
                regional(f.scope.related.spaceId),
              )
            ).items,
            [],
          );
          const added = await engine.search(
            reader.accessToken,
            regional(f.scope.foreign.spaceId),
          );
          assert.deepEqual(
            added.items.map((hit) => hit.contentId).sort(),
            [remote, commentId].sort(),
          );
          assert.equal(await vectorCount(), 3);
        },
      );

      await t.test(
        'unknown topology blocks regional preflight even if corpus would be empty, while broad canonical search stays available',
        async () => {
          await appendTopologyRevision(
            f.pool,
            structuredClone(f.scope.topology),
            { coverageState: 'conflicting' },
          );
          const calls = modelCalls;
          await assert.rejects(
            engine.search(
              reader.accessToken,
              regional(f.scope.related.spaceId),
            ),
            { code: 'COMMUNITY_UNAVAILABLE' },
          );
          assert.equal(
            modelCalls,
            calls,
            'unknown scope must not transmit even the query to a model',
          );
          const broad = await engine.search(reader.accessToken, all);
          assert.deepEqual(
            broad.items.map((hit) => hit.contentId).sort(),
            [remote, local, commentId].sort(),
          );
          assert.equal(await vectorCount(), 3);
        },
      );
    } finally {
      if (installed) await f.pool.query('DROP SCHEMA whaleu_semantic CASCADE');
      await f.close();
    }
  },
);
