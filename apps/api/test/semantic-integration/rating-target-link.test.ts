import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ratingTargetLinkFixture } from '../support/rating-target-link-fixture.js';
import { setRatingReviewState } from '../support/rating-runtime-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { installSemanticSearch } from '../../src/community/search/semantic/install.js';
import { createQwenSemanticProfile } from '../../src/community/search/semantic/profile.js';
import {
  QwenSemanticProvider,
  type QwenSemanticTransport,
} from '../../src/community/search/semantic/provider.js';
import {
  SemanticSearchEngine,
  fullCorpusScopeAuthority,
} from '../../src/community/search/semantic/engine.js';
import { SemanticIndexRepository } from '../../src/community/search/semantic/repository.js';
import { SemanticCorpusRepository } from '../../src/community/search/semantic/corpus-repository.js';
import { ContentReviewSearchEligibilityFacade } from '../../src/community/content-review/search-eligibility.facade.js';
import { LocalApprovedContentVisibility } from '../../src/community/content-review/local-approved-content-visibility.js';
import { CurrentRatingLinkDependency } from '../../src/community/rating-target-link/dependency.js';
import { CampusContentScopeFacade } from '../../src/campus/content-scope.facade.js';
import { MediaContentSnapshotFacade } from '../../src/media/content-snapshot.facade.js';
import { CommunityDistributionService } from '../../src/community/related-sync/service.js';
import { SafetySearchEligibilityFacade } from '../../src/safety/search-eligibility.facade.js';
import { SearchService } from '../../src/community/search/service.js';
import { searchQuerySchema } from '../../src/community/search/contracts.js';

/** Real optional pgvector and canonical owners. Deterministic local vectors are
 * synthetic acceptance only; no live semantic or generation provider is called. */
test(
  'rating link semantic source/certificates invalidate on identity-preserving successors, denial and unknown including descendants',
  { timeout: 300000 },
  async () => {
    const f = await ratingTargetLinkFixture();
    let installed = false;
    try {
      assert.equal(await installSemanticSearch(f.pool), 'installed');
      installed = true;
      const category = await f.createLinkCategory('course', true),
        target = await f.createLinkTarget(category),
        body = await f.card(target.id),
        post = await f.publishCard(body),
        reader = await f.actor();
      const child = {
        clientRequestId: randomUUID(),
        text: 'Exact semantic descendant wording',
        authorMode: 'named',
        imageAssetIds: [],
      };
      assert.equal(
        (
          await f.linkCall(
            reader,
            `/v1/community/reviews/posts/${post.resourceId}/comments`,
            child,
          )
        ).status,
        200,
      );
      await f.approveLinkCommunity(reader, child.clientRequestId);
      const published = await f.linkCall(
        reader,
        `/v1/community/posts/${post.resourceId}/comments`,
        child,
      );
      assert.equal(published.status, 201, JSON.stringify(published.body));
      const commentId = String(published.body.resourceId);
      const profile = createQwenSemanticProfile({
        providerId: 'offline-rating-link-fixture',
        deploymentId: 'synthetic',
        deploymentRevision: 'fixture-v1',
        embeddingModelRevision: 'fixture-v1',
        rerankerModelRevision: 'fixture-v1',
      });
      const disclosed: string[][] = [];
      const transport: QwenSemanticTransport = {
        embed: async (input) => ({
          profileIdentity: input.profileIdentity,
          indexSpaceKey: input.indexSpaceKey,
          response: {
            model: input.request.model,
            data: input.request.input.map((_text, index) => ({
              index,
              embedding: Array.from({ length: 4096 }, (_, i) =>
                i === 0 ? 1 : 0,
              ),
            })),
          },
        }),
        rerank: async (input) => {
          disclosed.push(input.request.documents.map((doc) => doc.text));
          return {
            profileIdentity: input.profileIdentity,
            indexSpaceKey: input.indexSpaceKey,
            response: {
              model: input.request.model,
              results: input.request.documents.map((doc, index) => ({
                index,
                id: doc.id,
                score: 10 - index,
              })),
            },
          };
        },
      };
      const index = new SemanticIndexRepository(),
        certificates = new ContentReviewSearchEligibilityFacade(
          f.app.get(LocalApprovedContentVisibility),
          f.app.get(CampusContentScopeFacade),
          f.app.get(MediaContentSnapshotFacade),
          f.app.get(CommunityDistributionService),
          f.app.get(CurrentRatingLinkDependency),
        );
      const engine = new SemanticSearchEngine(
        new QwenSemanticProvider(profile, transport),
        index,
        fullCorpusScopeAuthority(
          f.app.get(SearchService),
          index,
          certificates,
          new SemanticCorpusRepository(
            f.app.get(SafetySearchEligibilityFacade),
          ),
          profile,
        ),
        'local_fixture',
        certificates,
      );
      const query = searchQuerySchema.parse({
        spaceId: f.scope.home.spaceId,
        q: 'wording',
        type: 'all',
      });
      assert.equal(
        (await engine.indexScope(reader.accessToken, query)).indexed,
        2,
      );
      const ids = [post.resourceId, commentId].sort();
      assert.deepEqual(
        (await engine.search(reader.accessToken, query)).items
          .map((hit) => hit.contentId)
          .sort(),
        ids,
      );
      const snapshot = async () =>
        (
          await f.pool.query(
            "SELECT jsonb_build_array(p.text,l.component,b.envelope,b.digest,q.receipt) value FROM whaleu_community.posts p JOIN whaleu_community.post_rating_target_links l ON l.post_id=p.id JOIN whaleu_community.content_approval_bindings b ON b.content_kind='post' AND b.content_id=p.id JOIN whaleu_community.publication_requests q ON (q.account_id,q.client_request_id)=(l.account_id,l.client_request_id) WHERE p.id=$1",
            [post.resourceId],
          )
        ).rows[0].value;
      const before = await snapshot();
      const renamed = await f.editLinkTarget(
        target.id,
        'Accepted semantic rename',
      );
      await assert.rejects(engine.search(reader.accessToken, query));
      assert.equal(
        (await engine.indexScope(reader.accessToken, query)).indexed,
        2,
      );
      assert.deepEqual(
        (await engine.search(reader.accessToken, query)).items
          .map((hit) => hit.contentId)
          .sort(),
        ids,
      );
      assert.deepEqual(await snapshot(), before);
      const description = await f.editLinkTarget(
        target.id,
        'Accepted semantic rename',
        f.creator,
        'Description-only accepted successor',
      );
      assert.notEqual(description.revision, renamed.revision);
      await assert.rejects(engine.search(reader.accessToken, query));
      await engine.indexScope(reader.accessToken, query);
      assert.deepEqual(
        (await engine.search(reader.accessToken, query)).items
          .map((hit) => hit.contentId)
          .sort(),
        ids,
      );
      assert.deepEqual(await snapshot(), before);
      const rootId = String(
        (
          await f.pool.query(
            'SELECT component FROM whaleu_community.post_rating_target_links WHERE post_id=$1',
            [post.resourceId],
          )
        ).rows[0].component.binding.ancestry[0].categoryId,
      );
      const visibility = async (hidden: boolean) => {
        const context = await f.managementContext(f.admin, f.linkSelector);
        await f.executeManagement(
          f.admin,
          f.managementIntent(context, 'set_category_visibility_scoped', {
            categoryId: rootId,
            hidden,
          }),
        );
      };
      await visibility(true);
      const hiddenBefore = disclosed.length;
      assert.deepEqual(
        (await engine.search(reader.accessToken, query)).items,
        [],
      );
      assert.ok(
        disclosed
          .slice(hiddenBefore)
          .every((documents) => documents.length === 0),
      );
      await visibility(false);
      await engine.indexScope(reader.accessToken, query);
      assert.deepEqual(
        (await engine.search(reader.accessToken, query)).items
          .map((hit) => hit.contentId)
          .sort(),
        ids,
      );
      await setRatingReviewState(
        f.pool,
        description.approval.decisionId,
        'revoked',
      );
      const prior = disclosed.length;
      assert.deepEqual(
        (await engine.search(reader.accessToken, query)).items,
        [],
      );
      assert.ok(
        disclosed.slice(prior).every((documents) => documents.length === 0),
      );
      await setRatingReviewState(
        f.pool,
        description.approval.decisionId,
        'allow',
      );
      await assert.rejects(engine.search(reader.accessToken, query));
      await engine.indexScope(reader.accessToken, query);
      await withCommunityScopeWriter(f.pool, async (tx) => {
        const event = randomUUID();
        await tx.query(
          "INSERT INTO whaleu_community.rating_approval_events(id,decision_id,state,coverage,provenance,issuer,provenance_ref,occurred_at) VALUES($1,$2,'allow','missing','accepted','synthetic-rating-review','semantic-incomplete-card',clock_timestamp())",
          [event, description.approval.decisionId],
        );
        await tx.query(
          'UPDATE whaleu_community.rating_approval_heads SET event_id=$2 WHERE decision_id=$1',
          [description.approval.decisionId, event],
        );
      });
      const unknownBefore = disclosed.length;
      await assert.rejects(engine.search(reader.accessToken, query));
      assert.equal(disclosed.length, unknownBefore);
      await setRatingReviewState(
        f.pool,
        description.approval.decisionId,
        'allow',
      );
      await engine.indexScope(reader.accessToken, query);
      const context = await f.managementContext(f.admin, f.linkSelector);
      await f.executeManagement(
        f.admin,
        f.managementIntent(context, 'set_category_scope_scoped', {
          categoryId: rootId,
          placement: { kind: 'campuses', campusIds: [f.campusB] },
          propagation: 'subtree',
        }),
      );
      const movedBefore = disclosed.length;
      assert.deepEqual(
        (await engine.search(reader.accessToken, query)).items,
        [],
      );
      assert.ok(
        disclosed
          .slice(movedBefore)
          .every((documents) => documents.length === 0),
      );
      assert.deepEqual(await snapshot(), before);
    } finally {
      if (installed) await f.pool.query('DROP SCHEMA whaleu_semantic CASCADE');
      await f.close();
    }
  },
);
