import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  approvalDigest,
  canonicalEnvelope,
  canonicalJson,
  effectiveContentEnvelopeSchema,
} from '../src/community/content-review/contracts.js';
import { publicationMembersDigest } from '../src/community/related-sync/service.js';
import {
  relatedRootScopeSchema,
  inheritedRelatedScopeSchema,
} from '../src/community/content-review/scope-contracts.js';
import type { RelatedRootScope } from '../src/community/content-review/scope-contracts.js';

const id = (n: number) =>
  `10000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const scope: RelatedRootScope = {
  originalSpaceId: id(1),
  originalRegionId: id(2),
  authorOriginRegionId: id(2),
  identityRegionId: id(2),
  topologySnapshotId: id(3),
  configurationRevisionId: id(4),
  identityCampusId: id(5),
  identitySelectionId: id(6),
  affiliationSnapshotId: id(7),
  affiliationAssertionId: id(8),
  sync: 'related',
  syncPolicyId: id(9),
  publicationGroupId: id(10),
  publicationMembersDigest: publicationMembersDigest([id(2), id(11)]),
};
const root = () =>
  canonicalEnvelope({
    version: 4,
    accountId: id(12),
    purpose: 'publish_post',
    spaceId: id(1),
    category: 'discussion',
    authorMode: 'named',
    commentsPolicy: 'open',
    postId: null,
    rootCommentId: null,
    targetReplyId: null,
    text: 'Golden related',
    images: [],
    component: { kind: 'none' },
    trading: null,
    scope,
    allowAnonymousDm: null,
  });

test('pre-related v1/v2/v3 canonical bytes and approval digests are exact golden values', () => {
  const fixtures = JSON.parse(
    readFileSync(
      new URL('./fixtures/related-sync-legacy-goldens.json', import.meta.url),
      'utf8',
    ),
  ) as { envelope: unknown; canonical: string; digest: string }[];
  assert.equal(fixtures.length, 3);
  for (const fixture of fixtures) {
    const envelope = canonicalEnvelope(fixture.envelope);
    assert.equal(canonicalJson(envelope), fixture.canonical);
    assert.equal(approvalDigest(envelope), fixture.digest);
  }
});

test('all 139 applied SQL files, including optional sources, remain byte-identical', () => {
  const manifest = JSON.parse(
    readFileSync(
      new URL('./fixtures/related-sync-applied-sql.json', import.meta.url),
      'utf8',
    ),
  ) as Record<string, string>;
  assert.equal(Object.keys(manifest).length, 139);
  assert.equal(
    Object.keys(manifest).filter((path) =>
      path.startsWith('apps/api/migrations/'),
    ).length,
    137,
  );
  for (const [path, expected] of Object.entries(manifest))
    assert.equal(
      createHash('sha256')
        .update(readFileSync(new URL(`../../../${path}`, import.meta.url)))
        .digest('hex'),
      expected,
      path,
    );
});

test('publication members use domain-separated canonical sorted unique UUID bytes', () => {
  assert.equal(
    publicationMembersDigest([id(11), id(2), id(11)]),
    createHash('sha256')
      .update(`whaleu-related-publication-members:v1\n["${id(2)}","${id(11)}"]`)
      .digest('hex'),
  );
});

test('v4 root scope has no silent defaults and cannot inherit foreign identity region', () => {
  for (const key of Object.keys(scope)) {
    const changed: Record<string, unknown> = { ...scope };
    delete changed[key];
    assert.equal(relatedRootScopeSchema.safeParse(changed).success, false, key);
  }
  assert.equal(
    relatedRootScopeSchema.safeParse({ ...scope, identityRegionId: id(11) })
      .success,
    false,
  );
  assert.equal(
    relatedRootScopeSchema.safeParse({
      ...scope,
      parentDistribution: {
        postId: id(15),
        decisionId: id(16),
        digest: 'a'.repeat(64),
      },
    }).success,
    false,
  );
});

test('v4 child keeps its actor facts and exact immutable canonical root reference', () => {
  const actor = {
    originalSpaceId: id(1),
    originalRegionId: id(2),
    authorOriginRegionId: id(11),
    identityRegionId: id(11),
    topologySnapshotId: id(20),
    configurationRevisionId: null,
    identityCampusId: id(21),
    identitySelectionId: id(22),
    affiliationSnapshotId: id(23),
    affiliationAssertionId: id(24),
    sync: 'inherited_related' as const,
    parentDistribution: {
      postId: id(15),
      decisionId: id(16),
      digest: 'a'.repeat(64),
    },
  };
  const child = canonicalEnvelope({
    ...root(),
    accountId: id(25),
    purpose: 'publish_comment',
    postId: id(15),
    scope: actor,
  });
  assert.equal(child.scope.identityRegionId, id(11));
  const digest = approvalDigest(child);
  for (const patch of [
    { accountId: id(26) },
    { scope: { ...actor, identitySelectionId: id(27) } },
    {
      scope: {
        ...actor,
        parentDistribution: { ...actor.parentDistribution, decisionId: id(28) },
      },
    },
  ])
    assert.notEqual(
      approvalDigest(canonicalEnvelope({ ...child, ...patch })),
      digest,
    );
  assert.equal(
    inheritedRelatedScopeSchema.safeParse({ ...actor, syncPolicyId: id(9) })
      .success,
    false,
  );
  assert.equal(
    effectiveContentEnvelopeSchema.safeParse({ ...child, version: 1 }).success,
    false,
  );
  assert.equal(
    effectiveContentEnvelopeSchema.safeParse({ ...child, postId: id(29) })
      .success,
    false,
  );
  assert.equal(
    effectiveContentEnvelopeSchema.safeParse({ ...root(), scope: actor })
      .success,
    false,
  );
});

test('v4 exact review changes with policy, membership, opt-in shape and explicit DM value', () => {
  const original = root(),
    digest = approvalDigest(original);
  for (const patch of [
    { allowAnonymousDm: false },
    { allowAnonymousDm: true },
    { scope: { ...scope, syncPolicyId: id(30) } },
    { scope: { ...scope, publicationGroupId: id(31) } },
    { scope: { ...scope, publicationMembersDigest: 'b'.repeat(64) } },
  ])
    assert.notEqual(
      approvalDigest(canonicalEnvelope({ ...original, ...patch })),
      digest,
    );
  for (const patch of [
    { category: 'trading' },
    { category: 'feedback' },
    { scope: { ...scope, sync: 'none' } },
    { authorMode: 'anonymous', allowAnonymousDm: true },
    { allowAnonymousDm: undefined },
    { surplus: true },
  ])
    assert.equal(
      effectiveContentEnvelopeSchema.safeParse({ ...original, ...patch })
        .success,
      false,
    );
});

test('canonical global distribution performs no topology or generation reads and rejects stale or forged handles', async () => {
  const { CommunityDistributionService } =
    await import('../src/community/related-sync/service.js');
  const {
    startTransactionDeadlines,
    clearTransactionDeadlines,
    checkpointTransactionDeadlines,
    restoreTransactionDeadlines,
  } = await import('../src/database/transaction-deadlines.js');
  const owner = new CommunityDistributionService(
    {
      distributionGroup: async () => {
        throw new Error('Unexpected global topology read');
      },
    } as unknown as ConstructorParameters<
      typeof CommunityDistributionService
    >[0],
    {} as ConstructorParameters<typeof CommunityDistributionService>[1],
  );
  const tx = {
    query: async () => {
      throw new Error('Unexpected global database read');
    },
  } as unknown as import('pg').PoolClient;
  startTransactionDeadlines(tx);
  try {
    const scope = await owner.resolveView(
      {
        id: id(40),
        kind: 'global',
        name: 'Global',
        isActive: true,
        operatingRegionId: null,
      },
      tx,
    );
    assert.equal(scope.relatedCampusDistribution, 'complete');
    assert.deepEqual(scope.originalSpaceIds, [id(40)]);
    const params: unknown[] = [];
    assert.equal(
      owner.sqlPredicate(scope, 'p', 'category', params),
      '(p.space_id=$1::uuid)',
    );
    assert.deepEqual(params, [id(40)]);
    assert.throws(() => owner.sqlPredicate({ ...scope }, 'p', 'category', []), {
      code: 'COMMUNITY_UNAVAILABLE',
    });
    const checkpoint = checkpointTransactionDeadlines(tx);
    restoreTransactionDeadlines(tx, checkpoint);
    assert.throws(() => owner.sqlPredicate(scope, 'p', 'category', []), {
      code: 'COMMUNITY_UNAVAILABLE',
    });
  } finally {
    clearTransactionDeadlines(tx);
  }
});
