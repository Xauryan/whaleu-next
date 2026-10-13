import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { ContentReviewCountFacade } from '../src/community/content-review/count-snapshot.facade.js';
import {
  ContentReviewCountRepository,
  SnapshotReadBudget,
  COUNT_SNAPSHOT_BATCH,
  COUNT_SNAPSHOT_BYTES,
} from '../src/community/content-review/count-snapshot.repository.js';
import type { CountReviewSnapshot } from '../src/community/content-review/count-snapshot.repository.js';
import type { DefinitionPost } from '../src/community/content-review/definition-validation.js';
import {
  canonicalEnvelope,
  approvalDigest,
} from '../src/community/content-review/contracts.js';
import type {
  ApprovalBinding,
  ApprovalRow,
} from '../src/community/content-review/approval-validation.js';
import type { RelatedRootScope } from '../src/community/related-sync/contracts.js';
import type { DistributionBindingFact } from '../src/community/related-sync/binding.js';
import type { CampusContentScopeFacade } from '../src/campus/content-scope.facade.js';
import type { SafetyContentVisibilityFacade } from '../src/safety/content-visibility.facade.js';
import { fenceSmallCampusContentCount } from '../src/campus/content-count-fence.js';
import { fenceSmallCommunityCount } from '../src/community/small-count-fence.js';

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
function fixture() {
  const now = Date.parse('2026-10-13T00:00:00.000Z'),
    postId = id(1),
    spaceId = id(2),
    regionId = id(3),
    accountId = id(4);
  const scope: RelatedRootScope = {
    sync: 'related',
    originalSpaceId: spaceId,
    originalRegionId: regionId,
    authorOriginRegionId: regionId,
    identityRegionId: regionId,
    topologySnapshotId: id(5),
    configurationRevisionId: id(6),
    identityCampusId: id(7),
    identitySelectionId: id(8),
    affiliationSnapshotId: id(9),
    affiliationAssertionId: id(10),
    syncPolicyId: id(11),
    publicationGroupId: id(12),
    publicationMembersDigest: 'a'.repeat(64),
  };
  const post: DefinitionPost = {
    id: postId,
    space_id: spaceId,
    account_id: accountId,
    category: 'discussion',
    text: 'Synthetic related root',
    author_mode: 'anonymous',
    comments_policy: 'open',
    visibility: 'approved',
    owner_hidden: false,
    deleted_at: null,
    published_at: new Date(now - 10000),
    publication_state: 'published',
    publication_envelope_version: 4,
    allow_anonymous_dm: null,
  };
  const envelope = canonicalEnvelope({
    version: 4,
    accountId,
    purpose: 'publish_post',
    spaceId,
    category: 'discussion',
    authorMode: 'anonymous',
    commentsPolicy: 'open',
    postId: null,
    rootCommentId: null,
    targetReplyId: null,
    text: post.text,
    images: [],
    component: { kind: 'none' },
    trading: null,
    allowAnonymousDm: null,
    scope,
  });
  const row: ApprovalRow = {
    id: id(13),
    account_id: accountId,
    operation: 'publish_post',
    envelope_version: 4,
    digest: approvalDigest(envelope),
    envelope,
    policy_revision_id: id(14),
    result: 'allow',
    coverage: 'complete',
    provenance: 'accepted',
    issuer: 'synthetic',
    provenance_ref: 'synthetic',
    evaluated_at: new Date(now - 5000),
    consume_until: new Date(now - 4000),
    visibility_model: 'durable',
    visibility_until: null,
    policy_key: 'local-related-v1',
    policy_version: 1,
    policy_coverage: 'complete',
    policy_provenance: 'accepted',
    policy_issuer: 'synthetic',
    policy_provenance_ref: 'synthetic',
    policy_valid_from: new Date(now - 6000),
    policy_valid_until: null,
    state: 'allow',
    event_at: new Date(now - 5000),
    event_coverage: 'complete',
    event_provenance: 'accepted',
    event_issuer: 'synthetic',
    event_provenance_ref: 'synthetic',
  };
  const binding: ApprovalBinding = {
    content_kind: 'post',
    content_id: postId,
    content_version: 1,
    decision_id: row.id,
    account_id: accountId,
    operation: 'publish_post',
    envelope_version: 4,
    digest: row.digest,
    envelope,
    scope,
  };
  const native: DistributionBindingFact = {
    postId,
    category: 'discussion',
    decisionId: row.id,
    digest: row.digest,
    scope,
    valid: true,
  };
  const snapshot: CountReviewSnapshot = {
    posts: new Map([[postId, post]]),
    roots: new Map(),
    replies: new Map(),
    spaces: new Map([
      [
        spaceId,
        {
          id: spaceId,
          is_active: true,
          kind: 'regional',
          operating_region_id: regionId,
        },
      ],
    ]),
    categorySnapshot: {
      categories: new Map([[postId, 'discussion']]),
      validUntil: null,
      exactValidUntil: null,
    },
    childContext: {
      allowed: new Map(),
      validUntil: null,
      exactValidUntil: null,
    },
    bindings: new Map([[`post:${postId}`, binding]]),
    approvals: new Map([[row.id, row]]),
    distributionBindings: new Map([[postId, native]]),
    images: new Map(),
    polls: new Map(),
    formations: new Map(),
    listings: new Map(),
    options: new Map(),
    creators: new Map(),
    now,
    budget: new SnapshotReadBudget(),
    dependencies: {
      contentIds: [postId],
      spaceIds: [spaceId],
      namedAccountIds: [],
    },
  };
  const records = {
    read: async () => snapshot,
  } as unknown as ContentReviewCountRepository;
  const campuses = {
    readRegionsBatch: async () => new Map([[regionId, true]]),
  } as unknown as CampusContentScopeFacade;
  const safety = {
    checkBatch: async () => ({ facts: new Map(), namedAccountIds: [] }),
  } as unknown as SafetyContentVisibilityFacade;
  const tx = {
    query: async () => {
      throw new Error(
        'Canonical count must not acquire current topology or author affiliation',
      );
    },
  } as unknown as PoolClient;
  const service = new ContentReviewCountFacade(records, campuses, safety);
  return {
    snapshot,
    native,
    postId,
    evaluate: async () =>
      (await service.evaluatePosts([postId], null, tx)).facts.get(postId)!,
  };
}

test('canonical related count counts one root without current topology, but missing native proof remains unknown', async () => {
  const f = fixture();
  assert.equal((await f.evaluate()).decision, 'allow');
  f.snapshot.distributionBindings!.delete(f.postId);
  assert.equal((await f.evaluate()).decision, 'unknown');
  f.snapshot.distributionBindings!.set(f.postId, { ...f.native, valid: false });
  assert.equal((await f.evaluate()).decision, 'unknown');
  f.snapshot.distributionBindings!.set(f.postId, {
    ...f.native,
    scope: { ...f.native.scope, publicationGroupId: id(20) },
  });
  assert.equal((await f.evaluate()).decision, 'unknown');
  assert.equal(COUNT_SNAPSHOT_BATCH, 256);
  assert.equal(COUNT_SNAPSHOT_BYTES, 4 * 1024 * 1024);
});

test('small-count fences cover native bindings; current topology is only added for a related-view count', async () => {
  const statements: string[] = [];
  const tx = {
    query: async (sql: string) => {
      statements.push(sql);
      return { rows: [] };
    },
  } as unknown as PoolClient;
  await fenceSmallCommunityCount(tx);
  assert.ok(
    statements.some(
      (sql) =>
        sql.includes('post_distribution_bindings') &&
        sql.includes('related_sync_policies') &&
        sql.includes('report_origins') &&
        sql.includes('publication_requests'),
    ),
  );
  statements.length = 0;
  await fenceSmallCampusContentCount(tx);
  assert.equal(statements.length, 1);
  assert.ok(!statements[0]!.includes('community_topology'));
  await fenceSmallCampusContentCount(tx, true);
  assert.match(statements[1]!, /community_topology_snapshots/);
  assert.match(statements[1]!, /community_topology_heads/);
  assert.match(statements[1]!, /community_distribution_generation/);
  assert.match(statements[1]!, /IN SHARE MODE NOWAIT/);
});
