import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { loadConfig } from '../src/config/config.js';
import { ApplicationError } from '../src/http/application-error.js';
import {
  approvalDigest,
  canonicalEnvelope,
  contentScopeSchema,
} from '../src/community/content-review/contracts.js';
import type { EffectiveContentEnvelope } from '../src/community/content-review/contracts.js';
import type {
  RelatedRootScope,
  InheritedRelatedScope,
} from '../src/community/content-review/scope-contracts.js';
import {
  CommunityMediaOwner,
  mediaActorScope,
} from '../src/community/media/owner.js';
import type { TextReviewRequest } from '../src/community/text-review/contracts.js';
import { TextReviewRuntime } from '../src/community/text-review/runtime.js';
import { reviewOperatorCommandSchema } from '../src/community/text-review/operator.js';
import { ApprovalRepository } from '../src/community/content-review/approval.repository.js';
import type { CommunityDistributionService } from '../src/community/related-sync/service.js';
import { PublicationService } from '../src/community/publication.service.js';
import type { Authority } from '../src/community/community-policy.js';
import type { CommunitySpace } from '../src/community/contracts.js';
import { postIntent } from '../src/community/publication-intent.js';
import { publicationHash } from '../src/community/publication.repository.js';
import { publishPostSchema } from '../src/community/contracts.js';
import { TextReviewSubmission } from '../src/community/text-review/contracts.js';
import { withDiscussionPublicationMedia } from '../src/community/discussion/publication-target.js';
import {
  discussionAncestorAuthorization,
  collectDiscussionAncestorMedia,
} from '../src/media/discussion-ancestor-proof.js';
import {
  startTransactionDeadlines,
  checkTransactionDeadlines,
  clearTransactionDeadlines,
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';

const id = (n: number) =>
  `10000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const spaceId = id(1),
  regionId = id(2),
  accountId = id(3),
  postId = id(4);
const actorScope = contentScopeSchema.parse({
  originalSpaceId: spaceId,
  originalRegionId: regionId,
  authorOriginRegionId: regionId,
  identityRegionId: regionId,
  topologySnapshotId: id(5),
  sync: 'none',
  configurationRevisionId: null,
  identityCampusId: id(6),
  identitySelectionId: id(7),
  affiliationSnapshotId: id(8),
  affiliationAssertionId: id(9),
});
const rootScope: RelatedRootScope = {
  ...actorScope,
  sync: 'related',
  originalRegionId: regionId,
  authorOriginRegionId: regionId,
  identityRegionId: regionId,
  topologySnapshotId: id(5),
  configurationRevisionId: id(10),
  identityCampusId: id(6),
  identitySelectionId: id(7),
  affiliationSnapshotId: id(8),
  affiliationAssertionId: id(9),
  syncPolicyId: id(11),
  publicationGroupId: id(12),
  publicationMembersDigest: 'a'.repeat(64),
};
const inheritedScope: InheritedRelatedScope = {
  ...actorScope,
  sync: 'inherited_related',
  originalRegionId: regionId,
  authorOriginRegionId: id(13),
  identityRegionId: id(13),
  identityCampusId: id(14),
  identitySelectionId: id(15),
  parentDistribution: { postId, decisionId: id(16), digest: 'b'.repeat(64) },
};
const environment = {
  DATABASE_URL: 'postgresql://dev:test@127.0.0.1:55432/whaleu_test',
  NODE_ENV: 'test',
  COMMUNITY_TEXT_REVIEW: 'local_manual',
  COMMUNITY_TEXT_REVIEW_SPACE_ID: spaceId,
  COMMUNITY_TEXT_REVIEW_REGION_ID: regionId,
  COMMUNITY_TEXT_REVIEW_POLICY_ID: id(17),
  COMMUNITY_RELATED_REVIEW_POLICY_ID: id(18),
  COMMUNITY_TEXT_REVIEW_OPERATOR: 'synthetic:test:operator',
};
const rootEnvelope = (): EffectiveContentEnvelope =>
  canonicalEnvelope({
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
    text: 'Synthetic related publication',
    images: [{ assetId: id(19), digest: 'c'.repeat(64) }],
    component: {
      kind: 'poll',
      question: 'Which?',
      selectionMode: 'single',
      options: ['A', 'B'],
    },
    trading: null,
    allowAnonymousDm: null,
    scope: rootScope,
  });
function client(reply: (sql: string, args: unknown[]) => unknown[] = () => []) {
  return {
    query: async (sql: string, args: unknown[] = []) => ({
      rows: reply(sql, args),
    }),
  } as unknown as PoolClient;
}
function distribution(
  check: (envelope: EffectiveContentEnvelope) => void = () => {},
) {
  return {
    requireEnvelopeShape: async (envelope: EffectiveContentEnvelope) =>
      check(envelope),
  } as unknown as CommunityDistributionService;
}

test('related media uses unchanged actor draft protocol bytes and retains identity/topology changes', () => {
  const expected = createHash('sha256')
    .update('whaleu-community-media-draft:v1\n')
    .update(JSON.stringify({ spaceId, scope: actorScope }))
    .digest('hex');
  assert.equal(
    CommunityMediaOwner.scopeRevision(spaceId, actorScope),
    expected,
  );
  assert.equal(CommunityMediaOwner.scopeRevision(spaceId, rootScope), expected);
  assert.deepEqual(mediaActorScope(rootScope), actorScope);
  for (const patch of [
    { topologySnapshotId: id(25) },
    { identitySelectionId: id(26) },
    { affiliationAssertionId: id(27) },
  ])
    assert.notEqual(
      CommunityMediaOwner.scopeRevision(spaceId, { ...rootScope, ...patch }),
      expected,
    );
});

test('inherited media hashes preserve child actor facts and unchanged discussion target protocol', () => {
  const localChild = mediaActorScope(inheritedScope),
    target = { kind: 'comment' as const, postId };
  const expected = createHash('sha256')
    .update('whaleu-community-media-draft:v2\n')
    .update(JSON.stringify({ spaceId, scope: localChild, postId, target }))
    .digest('hex');
  assert.equal(
    CommunityMediaOwner.discussionScopeRevision(
      spaceId,
      inheritedScope,
      postId,
      target,
    ),
    expected,
  );
  assert.equal(localChild.identityRegionId, id(13));
  assert.notEqual(localChild.identityCampusId, rootScope.identityCampusId);
  assert.notEqual(
    CommunityMediaOwner.discussionScopeRevision(
      spaceId,
      { ...inheritedScope, identitySelectionId: id(28) },
      postId,
      target,
    ),
    expected,
  );
});

test('sync changes exact Media publication intent but false and omission preserve legacy bytes', () => {
  const input = publishPostSchema.parse({
    clientRequestId: id(20),
    spaceId,
    category: 'discussion',
    text: 'Synthetic',
    imageAssetIds: [],
    authorMode: 'named',
    commentsPolicy: 'open',
  });
  const none = publicationHash('publish_post', postIntent(input));
  assert.equal(
    publicationHash(
      'publish_post',
      postIntent({ ...input, syncToRelatedCampuses: false }),
    ),
    none,
  );
  assert.notEqual(
    publicationHash(
      'publish_post',
      postIntent({ ...input, syncToRelatedCampuses: true }),
    ),
    none,
  );
  assert.equal(
    Object.keys(
      postIntent({
        ...input,
        allowAnonymousDm: false,
        syncToRelatedCampuses: true,
      }),
    ).at(-1),
    'syncToRelatedCampuses',
  );
});

test('old local review alone never accepts a related envelope', async () => {
  const config = loadConfig({
    ...environment,
    COMMUNITY_RELATED_REVIEW_POLICY_ID: undefined,
  });
  const runtime = new TextReviewRuntime(
    config,
    new ApprovalRepository(),
    distribution(),
  );
  await assert.rejects(
    runtime.requireEnvelope(
      rootEnvelope(),
      client(() => {
        throw new Error('No related policy was configured');
      }),
    ),
    (e: unknown) =>
      e instanceof ApplicationError && e.code === 'CONTENT_REVIEW_UNAVAILABLE',
  );
  assert.throws(() => loadConfig({ ...environment, NODE_ENV: 'production' }));
  assert.throws(() =>
    loadConfig({ ...environment, COMMUNITY_TEXT_REVIEW: 'disabled' }),
  );
  assert.equal(
    reviewOperatorCommandSchema.safeParse({
      command: 'init-related-policy',
      basis: 'Explicit synthetic acceptance',
    }).success,
    true,
  );
});

test('explicit related review delegates complete anonymous/image/component shape to applicability', async () => {
  const checked: EffectiveContentEnvelope[] = [],
    queries: string[] = [];
  const runtime = new TextReviewRuntime(
    loadConfig(environment),
    new ApprovalRepository(),
    distribution((envelope) => checked.push(envelope)),
  );
  await runtime.requireEnvelope(
    rootEnvelope(),
    client((sql, args) => {
      queries.push(sql);
      if (sql.includes('content_approval_policies')) {
        assert.match(sql, /local-related-v1/);
        assert.equal(args[0], id(18));
        return [{ valid_until: null }];
      }
      assert.match(sql, /related_sync_policies/);
      assert.equal(args[1], id(18));
      return [{ id: id(11) }];
    }),
  );
  assert.equal(checked.length, 1);
  assert.equal(checked[0]!.authorMode, 'anonymous');
  assert.equal(queries.length, 2);
});

test('child review never reapplies historical root mode or issuance-policy pairing', async () => {
  const child = canonicalEnvelope({
    ...rootEnvelope(),
    purpose: 'publish_comment',
    postId,
    authorMode: 'named',
    component: { kind: 'none' },
    scope: inheritedScope,
  });
  const runtime = new TextReviewRuntime(
    loadConfig(environment),
    new ApprovalRepository(),
    distribution(),
  );
  await runtime.requireEnvelope(
    child,
    client((sql) => {
      assert.match(sql, /content_approval_policies/);
      assert.doesNotMatch(sql, /related_sync_policies/);
      return [{ valid_until: null }];
    }),
  );
});

test('current applicability rejection and Review-policy mismatch fail related admission', async () => {
  const fail = new TextReviewRuntime(
    loadConfig(environment),
    new ApprovalRepository(),
    distribution(() => {
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    }),
  );
  await assert.rejects(
    fail.requireEnvelope(
      rootEnvelope(),
      client(() => [{ valid_until: null }]),
    ),
  );
  const mismatch = new TextReviewRuntime(
    loadConfig(environment),
    new ApprovalRepository(),
    distribution(),
  );
  await assert.rejects(
    mismatch.requireEnvelope(
      rootEnvelope(),
      client((sql) =>
        sql.includes('content_approval_policies')
          ? [{ valid_until: null }]
          : [],
      ),
    ),
    (e: unknown) =>
      e instanceof ApplicationError && e.code === 'CONTENT_REVIEW_UNAVAILABLE',
  );
});

test('discussion publication inherits own actor authority without copying root identity', async () => {
  const authority = {
    runtime: true,
    publicationScope: mediaActorScope(inheritedScope),
  } as Authority;
  const space = { id: spaceId, operatingRegionId: regionId } as CommunitySpace;
  const instance = Object.create(
    PublicationService.prototype,
  ) as PublicationService;
  Object.assign(instance, {
    distribution: {
      inherit: async (actualPost: string, childScope: unknown) => {
        assert.equal(actualPost, postId);
        assert.deepEqual(childScope, mediaActorScope(inheritedScope));
        return inheritedScope;
      },
    },
  });
  assert.deepEqual(
    await instance.discussionScope(authority, space, postId, 4, client()),
    { version: 4, allowAnonymousDm: null, scope: inheritedScope },
  );
  Object.assign(instance, { distribution: undefined });
  await assert.rejects(
    instance.discussionScope(authority, space, postId, 4, client()),
  );
  assert.deepEqual(
    await instance.discussionScope(authority, space, postId, 1, client()),
    { version: 1, scope: mediaActorScope(inheritedScope) },
  );
});

test('frozen Review request rejects changed identity/topology instead of silently re-reviewing', async () => {
  const envelope = rootEnvelope();
  const row: TextReviewRequest = {
    account_id: accountId,
    client_request_id: id(30),
    operation: 'publish_post',
    intent_hash: 'd'.repeat(64),
    digest: approvalDigest(envelope),
    envelope,
    decision_id: id(31),
    expires_at: new Date('2099-01-01T00:00:00Z'),
  };
  const runtime = new TextReviewRuntime(
    loadConfig(environment),
    new ApprovalRepository(),
    distribution(),
  );
  for (const patch of [
    { identitySelectionId: id(32) },
    { topologySnapshotId: id(33) },
    { syncPolicyId: id(34) },
  ]) {
    const changed = canonicalEnvelope({
      ...envelope,
      scope: { ...rootScope, ...patch },
    });
    await assert.rejects(
      runtime.requireRequest(
        changed,
        {
          clientRequestId: row.client_request_id,
          operation: row.operation,
          intentHash: row.intent_hash,
        },
        client(() => [row]),
      ),
      (error: unknown) =>
        error instanceof ApplicationError && error.code === 'REQUEST_CONFLICT',
    );
  }
});

test('settled Review status returns original recovery without refreshing historical eligibility', async () => {
  const envelope = rootEnvelope();
  const row: TextReviewRequest = {
    account_id: accountId,
    client_request_id: id(30),
    operation: 'publish_post',
    intent_hash: 'd'.repeat(64),
    digest: approvalDigest(envelope),
    envelope,
    decision_id: id(31),
    expires_at: new Date('2020-01-01T00:00:00Z'),
  };
  const runtime = new TextReviewRuntime(
    loadConfig(environment),
    new ApprovalRepository(),
    distribution(() => {
      throw new Error('Historical recovery must not refresh applicability');
    }),
  );
  const result = await runtime.status(
    row,
    client((sql) => {
      assert.match(sql, /receipt IS NOT NULL/);
      return [{ receipt: { outcome: 'created' } }];
    }),
  );
  assert.equal(result.status, 'settled');
});

test('missing optional distribution or Review-binding port never downgrades v4 to legacy', async () => {
  const service = Object.create(
    PublicationService.prototype,
  ) as PublicationService;
  const full = canonicalEnvelope({ ...rootEnvelope(), images: [] });
  const draft = full;
  Object.assign(service, {
    content: {
      bind: async () => {},
      check: async () => {
        throw new Error('Missing distribution cannot reach Review');
      },
    },
    distribution: undefined,
  });
  await assert.rejects(
    service.approved(
      accountId,
      'publish_post',
      draft.text,
      [],
      client(),
      undefined,
      draft,
    ),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'CONTENT_REVIEW_UNAVAILABLE',
  );
  Object.assign(service, {
    distribution: distribution(),
    content: {
      check: async () => {
        throw new Error('Missing binding cannot reach Review');
      },
    },
  });
  await assert.rejects(
    service.approved(
      accountId,
      'publish_post',
      draft.text,
      [],
      client(),
      undefined,
      draft,
    ),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'CONTENT_REVIEW_UNAVAILABLE',
  );
});

test('new true-root fails before actor scope reads when owner is absent', async () => {
  const service = Object.create(
    PublicationService.prototype,
  ) as PublicationService;
  const tx = client();
  Object.assign(service, {
    publications: {
      execute: async (
        _token: string,
        _request: string,
        _operation: string,
        _intent: unknown,
        create: (actor: string, tx: PoolClient) => Promise<unknown>,
      ) => create(accountId, tx),
    },
    repository: {
      space: async () => {
        throw new Error('Absent distribution must fail before space reads');
      },
    },
  });
  const body = publishPostSchema.parse({
    clientRequestId: id(35),
    spaceId,
    category: 'discussion',
    text: 'Synthetic true root',
    imageAssetIds: [],
    authorMode: 'named',
    commentsPolicy: 'open',
    syncToRelatedCampuses: true,
  });
  await assert.rejects(
    service.post('token', body),
    (error: unknown) =>
      error instanceof ApplicationError &&
      error.code === 'COMMUNITY_UNAVAILABLE',
  );
});

test('image digest and exact true-intent cannot change under a frozen Review key', async () => {
  const envelope = rootEnvelope(),
    context = {
      clientRequestId: id(36),
      operation: 'publish_post' as const,
      intentHash: 'e'.repeat(64),
    };
  const row: TextReviewRequest = {
    account_id: accountId,
    client_request_id: context.clientRequestId,
    operation: context.operation,
    intent_hash: context.intentHash,
    digest: approvalDigest(envelope),
    envelope,
    decision_id: id(37),
    expires_at: new Date('2099-01-01T00:00:00Z'),
  };
  const runtime = new TextReviewRuntime(
    loadConfig(environment),
    new ApprovalRepository(),
    distribution(),
  );
  await assert.rejects(
    runtime.requireRequest(
      canonicalEnvelope({
        ...envelope,
        images: [{ assetId: id(19), digest: 'f'.repeat(64) }],
      }),
      context,
      client(() => [row]),
    ),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === 'REQUEST_CONFLICT',
  );
  await assert.rejects(
    runtime.requireRequest(
      envelope,
      { ...context, intentHash: 'f'.repeat(64) },
      client(() => [row]),
    ),
    (error: unknown) =>
      error instanceof ApplicationError && error.code === 'REQUEST_CONFLICT',
  );
});

test('child Review sentinels retain full Media ancestor finalization for legacy and v4 after savepoint replay', async () => {
  for (const version of [1, 4] as const) {
    const tx = discussionReviewProofTransaction();
    startTransactionDeadlines(tx);
    try {
      const envelope = canonicalEnvelope({
        version,
        accountId,
        purpose: 'publish_comment',
        spaceId,
        category: 'discussion',
        authorMode: 'named',
        commentsPolicy: 'open',
        postId,
        rootCommentId: null,
        targetReplyId: null,
        text: 'Exact image Review preparation',
        images: [{ assetId: id(19), digest: 'c'.repeat(64) }],
        component: { kind: 'none' },
        trading: null,
        scope: version === 4 ? inheritedScope : actorScope,
        ...(version === 4 ? { allowAnonymousDm: null } : {}),
      });
      const submission = new TextReviewSubmission(envelope);
      const checkpoint = checkpointTransactionDeadlines(tx);
      let ancestorReads = 0;
      let effectWrites = 0;
      const approved = async () => {
        throw submission;
      };
      const prepare = () =>
        withDiscussionPublicationMedia(
          tx,
          { accountId, postId },
          true,
          async () => {
            await discussionAncestorAuthorization(
              tx,
              { postId },
              async () => {
                ancestorReads++;
                assert.equal(
                  collectDiscussionAncestorMedia(
                    tx,
                    {
                      ownerKind: 'community',
                      resourceKind: 'post',
                      resourceId: postId,
                      contentVersion: 1,
                    },
                    envelope.images,
                  ),
                  true,
                );
                return { postId, version: 1 };
              },
              (value) => JSON.stringify(value),
            );
            await approved();
            effectWrites++;
          },
        );
      await assert.rejects(prepare(), (error: unknown) => error === submission);
      assert.equal(
        ancestorReads,
        2,
        'The initial read and mandatory final ancestor read precede the sentinel',
      );
      restoreTransactionDeadlines(tx, checkpoint);
      await assert.rejects(prepare(), (error: unknown) => error === submission);
      assert.equal(ancestorReads, 4);
      assert.equal(
        effectWrites,
        0,
        'The sentinel never resumes profile, node, attachment or effect writes',
      );
      await checkTransactionDeadlines(tx);
    } finally {
      clearTransactionDeadlines(tx);
    }
  }
});

test('child Review still rejects changed ancestor evidence and propagates genuine preparation errors', async () => {
  for (const mode of ['ancestor-changed', 'genuine-error'] as const) {
    const tx = discussionReviewProofTransaction();
    startTransactionDeadlines(tx);
    try {
      let reads = 0;
      const underlying = new Error(
        'Synthetic actual Media preparation failure',
      );
      const submission = new TextReviewSubmission(rootEnvelope());
      await assert.rejects(
        withDiscussionPublicationMedia(tx, { postId }, true, async () => {
          await discussionAncestorAuthorization(
            tx,
            { postId },
            async () => ({ revision: ++reads }),
            (value) => JSON.stringify(value),
          );
          if (mode === 'genuine-error') throw underlying;
          throw submission;
        }),
        (error: unknown) =>
          mode === 'genuine-error'
            ? error === underlying
            : error instanceof ApplicationError &&
              error.code === 'MEDIA_UNAVAILABLE',
      );
      assert.equal(reads, mode === 'genuine-error' ? 1 : 2);
      await assert.rejects(
        checkTransactionDeadlines(tx),
        { code: 'MEDIA_UNAVAILABLE' },
        'A caller cannot commit a failed or unfinished ancestor proof',
      );
    } finally {
      clearTransactionDeadlines(tx);
    }
  }
});

test('a zero-row Media source write after the Review sentinel still invalidates the final proof', async () => {
  const tx = discussionReviewProofTransaction();
  startTransactionDeadlines(tx);
  try {
    const submission = new TextReviewSubmission(rootEnvelope());
    await assert.rejects(
      withDiscussionPublicationMedia(tx, { postId }, true, async () => {
        await discussionAncestorAuthorization(
          tx,
          { postId },
          async () => ({ postId }),
          (value) => JSON.stringify(value),
        );
        throw submission;
      }),
      (error: unknown) => error === submission,
    );
    await checkTransactionDeadlines(tx);
    // The fake port models the actual BEFORE STATEMENT Media generation trigger,
    // including a source statement that affects no rows. The PG slice also probes
    // this raw source mutation against an accepted child Media binding.
    await tx.query('DELETE FROM whaleu_media.asset_safety_heads WHERE false');
    await assert.rejects(checkTransactionDeadlines(tx), {
      code: 'MEDIA_UNAVAILABLE',
    });
  } finally {
    clearTransactionDeadlines(tx);
  }
});

function discussionReviewProofTransaction(): PoolClient {
  let mediaEpoch = 0;
  return {
    query: async (sql: string) => {
      if (sql === 'DELETE FROM whaleu_media.asset_safety_heads WHERE false')
        mediaEpoch++;
      return {
        rows: sql.includes("current_setting('transaction_isolation')")
          ? [
              {
                isolation: 'read committed',
                statement_timeout: '15s',
                lock_timeout: '0',
              },
            ]
          : sql.includes('clock_timestamp() AS now')
            ? [{ now: new Date() }]
            : sql.includes(
                  'SELECT slot,version,epoch::text FROM whaleu_media.media_owner_states',
                )
              ? Array.from({ length: 128 }, (_, slot) => ({
                  slot,
                  version: 1,
                  epoch: String(mediaEpoch),
                }))
              : sql.includes('to_regclass')
                ? [{ present: false }]
                : [],
      };
    },
  } as unknown as PoolClient;
}
