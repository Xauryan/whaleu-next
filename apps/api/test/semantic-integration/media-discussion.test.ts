import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';
import { syntheticMediaRuntimeFixture } from '../support/media/runtime-fixture.js';
import {
  readyDiscussionBatch,
  sealDiscussionBatch,
  publishDiscussionPost,
  responseOk,
} from '../support/media/discussion-batch-fixture.js';
import { seedReviewPolicy } from '../support/community-approval-fixtures.js';
import { sha256 } from '../../src/media/processing/protocol.js';
import { SearchService } from '../../src/community/search/service.js';
import { searchQuerySchema } from '../../src/community/search/contracts.js';
import { LocalApprovedContentVisibility } from '../../src/community/content-review/local-approved-content-visibility.js';
import { ContentReviewSearchEligibilityFacade } from '../../src/community/content-review/search-eligibility.facade.js';
import { CampusContentScopeFacade } from '../../src/campus/content-scope.facade.js';
import { MediaContentSnapshotFacade } from '../../src/media/content-snapshot.facade.js';
import { SafetySearchEligibilityFacade } from '../../src/safety/search-eligibility.facade.js';
import {
  SemanticSearchEngine,
  fullCorpusScopeAuthority,
} from '../../src/community/search/semantic/engine.js';
import { SemanticCorpusRepository } from '../../src/community/search/semantic/corpus-repository.js';
import { SemanticIndexRepository } from '../../src/community/search/semantic/repository.js';
import { QwenSemanticProvider } from '../../src/community/search/semantic/provider.js';
import type { QwenSemanticTransport } from '../../src/community/search/semantic/provider.js';
import { createQwenSemanticProfile } from '../../src/community/search/semantic/profile.js';
import { installSemanticSearch } from '../../src/community/search/semantic/install.js';
import type { DiscussionPublicationTarget } from '../../src/community/discussion/publication-target.js';

test(
  'actual typed three-image root/reply semantic eligibility classifies pure images as nontext without embedding bytes or labels',
  { timeout: 360000 },
  async () => {
    const sharp = (await import('sharp')).default;
    const bytes = await sharp({
      create: { width: 80, height: 60, channels: 3, background: '#234567' },
    })
      .png()
      .toBuffer();
    const f = await syntheticMediaRuntimeFixture([
      { sha256: sha256(bytes), verdict: 'allow' },
    ]);
    let installed = false;
    try {
      await seedReviewPolicy(f.pool);
      const actor = await f.actor(),
        reader = await f.actor();
      const postId = await publishDiscussionPost(f, actor),
        http = f.app.getHttpServer();
      const publish = async (
        target: DiscussionPublicationTarget,
        count: number,
        text: string,
      ) => {
        const ready = await readyDiscussionBatch(f, actor, target, count, [
          { bytes, mime: 'image/png' },
        ]);
        const sealed = await sealDiscussionBatch(f, actor, ready.status, text);
        const response = await request(http)
          .post(sealed.path)
          .set('Authorization', `Bearer ${actor.accessToken}`)
          .send(sealed.body);
        responseOk(response, 201);
        return {
          id: response.body.resourceId as string,
          assets: sealed.body.imageAssetIds,
        };
      };
      const root = await publish({ kind: 'comment', postId }, 3, '');
      const textReply = await publish(
        { kind: 'reply', rootCommentId: root.id, targetReplyId: null },
        3,
        'needle text and images',
      );
      const pureReply = await publish(
        { kind: 'reply', rootCommentId: root.id, targetReplyId: textReply.id },
        1,
        '',
      );
      await installSemanticSearch(f.pool);
      installed = true;
      const searches = f.app.get(SearchService),
        index = new SemanticIndexRepository();
      const certificates = new ContentReviewSearchEligibilityFacade(
        f.app.get(LocalApprovedContentVisibility),
        f.app.get(CampusContentScopeFacade),
        new MediaContentSnapshotFacade(),
      );
      const corpus = new SemanticCorpusRepository(
        new SafetySearchEligibilityFacade(),
      );
      const profile = createQwenSemanticProfile({
        providerId: 'offline-fixture',
        deploymentId: 'discussion-media',
        deploymentRevision: 'fixture-v1',
        embeddingModelRevision: 'fixture-v1',
        rerankerModelRevision: 'fixture-v1',
      });
      const embedded: string[] = [],
        reranked: string[] = [];
      const transport: QwenSemanticTransport = {
        embed: async (envelope) => {
          embedded.push(...envelope.request.input);
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
          reranked.push(...envelope.request.documents.map((d) => d.text));
          return {
            profileIdentity: envelope.profileIdentity,
            indexSpaceKey: envelope.indexSpaceKey,
            response: {
              model: envelope.request.model,
              results: envelope.request.documents.map((d, index) => ({
                index,
                id: d.id,
                score: -index,
              })),
            },
          };
        },
      };
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
      const query = searchQuerySchema.parse({
        spaceId: f.scope.home.spaceId,
        type: 'all',
        q: 'needle',
        limit: '10',
      });
      const snapshot = await searches.semanticScope(
        reader.accessToken,
        query,
        index,
        async (scope) => ({
          text: scope.sources.map((s) => s.candidate.id),
          nontext: scope.nonTextSources?.map((s) => s.candidate.id),
        }),
        'index',
      );
      assert.deepEqual(
        new Set(snapshot.nontext),
        new Set([root.id, pureReply.id]),
      );
      assert.ok(snapshot.text.includes(textReply.id));
      assert.equal(
        (await engine.indexScope(reader.accessToken, query)).indexed,
        2,
      );
      assert.deepEqual(
        new Set(embedded),
        new Set(['Discussion media parent', 'needle text and images']),
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_semantic.embeddings WHERE content_id=ANY($1::uuid[])',
            [[root.id, pureReply.id]],
          )
        ).rowCount,
        0,
      );
      assert.equal(
        (
          await f.pool.query(
            'SELECT 1 FROM whaleu_semantic.certificates_v2 WHERE content_id=ANY($1::uuid[])',
            [[root.id, pureReply.id, textReply.id]],
          )
        ).rowCount,
        3,
      );
      const result = await engine.search(reader.accessToken, query);
      assert.ok(result.items.some((item) => item.contentId === textReply.id));
      assert.ok(
        result.items.every(
          (item) =>
            item.contentId !== root.id && item.contentId !== pureReply.id,
        ),
      );
      assert.ok(
        [...embedded, ...reranked].every((text) => text.trim().length > 0),
      );
      for (const asset of [
        ...root.assets,
        ...textReply.assets,
        ...pureReply.assets,
      ])
        assert.ok(
          ![...embedded, ...reranked].some((text) => text.includes(asset)),
        );
      const detail = await request(http)
        .get(`/v1/community/posts/${postId}`)
        .set('Authorization', `Bearer ${reader.accessToken}`);
      responseOk(detail);
      assert.equal(detail.body.commentCount, 1);
      assert.equal(detail.body.replyCount, 2);
    } finally {
      if (installed) await f.pool.query('DROP SCHEMA whaleu_semantic CASCADE');
      await f.close();
    }
  },
);
