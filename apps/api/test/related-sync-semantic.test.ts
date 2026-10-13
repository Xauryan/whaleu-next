import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  ContentReviewSearchEligibilityFacade,
  evaluateSearchContentCertificate,
} from '../src/community/content-review/search-eligibility.facade.js';
import type {
  SearchContentCertificate,
  SearchContentNode,
} from '../src/community/content-review/search-eligibility.facade.js';
import type { LocalApprovedContentVisibility } from '../src/community/content-review/local-approved-content-visibility.js';
import type { CampusContentScopeFacade } from '../src/campus/content-scope.facade.js';
import type { CommunityDistributionService } from '../src/community/related-sync/service.js';
import type { CommunityDistributionScope } from '../src/community/related-sync/contracts.js';
import type {
  SearchCandidate,
  SearchStructuralScope,
} from '../src/community/search/repository.js';
import { createQwenSemanticProfile } from '../src/community/search/semantic/profile.js';

const uuid = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const id = uuid(1),
  spaceId = uuid(2),
  generation = uuid(3),
  approval = uuid(4),
  policy = uuid(5),
  event = uuid(6);
const digest = 'a'.repeat(64),
  indexSpaceKey = 'b'.repeat(64),
  now = Date.parse('2026-10-13T00:00:00.000Z');
const candidate: SearchCandidate = {
  kind: 'post',
  id,
  postId: id,
  rootCommentId: null,
  spaceId,
  at: '2026-10-12T00:00:00.000000Z',
};
const node: SearchContentNode = {
  kind: 'post',
  id,
  post_id: id,
  root_comment_id: null,
  account_id: uuid(7),
  author_mode: 'anonymous',
  visibility: 'approved',
  deleted_at: null,
  publication_state: 'published',
  publication_envelope_version: 4,
  envelope_version: 4,
  generation,
  digest,
  decision_id: approval,
  event_id: event,
  policy_revision_id: policy,
  result: 'allow',
  coverage: 'complete',
  provenance: 'accepted',
  issuer: 'synthetic',
  provenance_ref: 'synthetic',
  evaluated_at: new Date(now - 1000),
  consume_until: new Date(now - 500),
  visibility_model: 'durable',
  visibility_until: null,
  policy_key: 'local-related-v1',
  policy_version: 1,
  policy_coverage: 'complete',
  policy_provenance: 'accepted',
  policy_issuer: 'synthetic',
  policy_provenance_ref: 'synthetic',
  policy_valid_from: new Date(now - 2000),
  policy_valid_until: null,
  state: 'allow',
  event_at: new Date(now - 1000),
  event_coverage: 'complete',
  event_provenance: 'accepted',
  event_issuer: 'synthetic',
  event_provenance_ref: 'synthetic',
  exact_time_valid: true,
  images: [],
  expected_images: [],
  current_distribution_allowed: true,
};
const certificate: SearchContentCertificate = {
  index_space_key: indexSpaceKey,
  kind: 'post',
  content_id: id,
  post_id: id,
  root_comment_id: null,
  source_revision: [['post', id, generation, digest, approval, policy, event]],
  body_digest: 'c'.repeat(64),
  has_searchable_text: true,
  space_id: spaceId,
  region_id: uuid(8),
  certificate_version: 1,
  valid_until: null,
};
const evaluate = (patch: Partial<SearchContentNode>) =>
  evaluateSearchContentCertificate(
    candidate,
    certificate,
    new Map([[`post:${id}`, { ...node, ...patch }]]),
    { active: true, kind: 'regional', regionId: uuid(8), regionActive: true },
    indexSpaceKey,
    now,
  );

test('canonical related certificate needs native immutable distribution proof and never treats its absence as denial', () => {
  assert.equal(evaluate({}).decision, 'allow');
  assert.equal(evaluate({ envelope_version: 1 }).decision, 'unknown');
  assert.equal(
    evaluate({ publication_envelope_version: 1 }).decision,
    'unknown',
  );
  assert.equal(
    evaluate({ envelope_version: 1, publication_envelope_version: 1 }).decision,
    'unknown',
    'legacy envelopes cannot inherit related Review acceptance',
  );
  assert.equal(
    evaluate({ current_distribution_allowed: false }).decision,
    'unknown',
  );
  const missing = { ...node };
  delete missing.current_distribution_allowed;
  assert.equal(
    evaluateSearchContentCertificate(
      candidate,
      certificate,
      new Map([[`post:${id}`, missing]]),
      { active: true, kind: 'regional', regionId: uuid(8), regionActive: true },
      indexSpaceKey,
      now,
    ).decision,
    'unknown',
  );
  assert.equal(
    evaluate({
      current_distribution_allowed: false,
      current_classification_allowed: false,
    }).decision,
    'unknown',
  );
  assert.equal(
    certificate.space_id,
    spaceId,
    'certificate stays original-space keyed',
  );
  assert.equal(
    certificate.source_revision.length,
    1,
    'no destination-multiplied source revision',
  );
});

test('unknown related topology fails full-corpus preparation before reading any vectors, even for an empty corpus', async () => {
  let queries = 0;
  const tx = {
    query: async () => {
      queries++;
      throw new Error('No corpus reads allowed');
    },
  } as unknown as PoolClient;
  const profile = createQwenSemanticProfile({
    providerId: 'synthetic',
    deploymentId: 'synthetic',
    deploymentRevision: 'v1',
    embeddingModelRevision: 'v1',
    rerankerModelRevision: 'v1',
  });
  const distribution: CommunityDistributionScope = {
    viewSpaceId: spaceId,
    viewRegionId: uuid(8),
    fingerprint: digest,
    relatedCampusDistribution: 'unavailable',
    originalSpaceIds: [spaceId],
    remoteSpaceIds: [],
  };
  const scope: SearchStructuralScope = {
    spaceId,
    distribution,
    category: null,
    tradingSubtype: null,
    excludeUrgentTrading: true,
    types: ['post'],
    from: null,
    to: null,
    postId: null,
  };
  for (const owner of [undefined, {} as CommunityDistributionService]) {
    const facade = new ContentReviewSearchEligibilityFacade(
      {} as LocalApprovedContentVisibility,
      {} as CampusContentScopeFacade,
      undefined,
      owner,
    );
    await assert.rejects(facade.prepare(scope, profile, tx), {
      code: 'COMMUNITY_UNAVAILABLE',
    });
  }
  assert.equal(queries, 0);
});
