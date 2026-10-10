import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  decodeRatingDiscussionMediaIntent,
  ratingDiscussionMediaIntentHash,
} from '../../src/ratings/discussion-media-contract';
import {
  decodeRatingDiscussionBatchIdentity,
  ratingDiscussionBatchIdentityHash,
  ratingDiscussionMemberRequestHash,
} from '../../src/ratings/discussion-media-batch-contract';
import type { PendingRatingDiscussionBatch } from '../../src/ratings/discussion-media-pending';
import type { DiscussionBatchStatus } from '../../src/ratings/discussion-media-wire';
export const processId = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export function discussionProcessFixture() {
  const fixture = JSON.parse(
    readFileSync(
      join(
        __dirname,
        '../../../../packages/fixtures/ratings-discussion-media-v1.json',
      ),
      'utf8',
    ),
  ).cases[0];
  const intent = decodeRatingDiscussionMediaIntent(fixture.intent),
    p = intent.payload,
    actor = processId(50);
  const identity = decodeRatingDiscussionBatchIdentity({
    protocol: 'ratings-discussion-media-v1',
    batchRequestId: p.batchRequestId,
    commandRequestId: p.clientRequestId,
    draftRevision: p.draftRevision,
    categoryId: p.categoryId,
    expectedCategoryRevision: p.expectedCategoryRevision,
    context: intent.context,
    target: {
      kind: 'root',
      targetId: p.targetId,
      expectedTargetRevision: p.expectedTargetRevision,
      expectedDefinitionRevision: p.expectedDefinitionRevision,
      expectedContentVersion: p.expectedContentVersion,
    },
  });
  const initial: PendingRatingDiscussionBatch = {
    version: 12,
    phase: 'batch',
    accountId: actor,
    identity,
    identityHash: ratingDiscussionBatchIdentityHash(actor, identity),
    batchId: null,
    members: [],
    orderedMemberIds: [],
    sealedPlanDigest: null,
  };
  const members = p.images.map((image, sourceSlot) => {
    const member = {
      memberId: image.memberId,
      clientRequestId: processId(300 + sourceSlot),
      sourceSlot,
      declaration: {
        mime: 'image/png' as const,
        bytes: 1024,
        sha256: 'a'.repeat(64),
      },
      state: 'ready' as const,
      assetId: image.assetId,
      manifestDigest: fixture.review.images[sourceSlot]
        .manifestDigest as string,
    };
    return {
      ...member,
      requestHash: ratingDiscussionMemberRequestHash(
        actor,
        p.batchId!,
        initial.identityHash,
        member,
      ),
    };
  });
  const sealed: PendingRatingDiscussionBatch = {
    ...initial,
    batchId: p.batchId,
    members,
    orderedMemberIds: p.images.map((image) => image.memberId),
    sealedPlanDigest: p.sealedPlanDigest,
  };
  const batch: DiscussionBatchStatus = {
    protocol: 'ratings-discussion-media-v1',
    batchId: p.batchId!,
    identity,
    batchIdentityHash: initial.identityHash,
    revision: processId(90),
    state: 'sealed',
    expiresAt: 1,
    serverNow: 1000,
    members: members.map((m, index) => ({
      memberId: m.memberId,
      requestId: m.clientRequestId,
      intentId: processId(700 + index),
      sourceSlot: m.sourceSlot,
      state: 'live',
    })),
    sealedPlan: {
      batchId: p.batchId!,
      batchIdentityHash: initial.identityHash,
      orderedMembers: members.map((m, ordinal) => ({
        ordinal,
        memberId: m.memberId,
        assetId: m.assetId!,
        manifestDigest: m.manifestDigest!,
      })),
    },
    sealedPlanDigest: p.sealedPlanDigest,
    consumedParent: null,
  };
  const receipt = {
    protocolVersion: 4 as const,
    requestId: p.clientRequestId,
    operation: 'create_comment_scoped' as const,
    intentHash: ratingDiscussionMediaIntentHash(intent),
    outcome: 'applied' as const,
    result: {
      targetId: p.targetId,
      subjectId: processId(51),
      revision: processId(52),
      occurredAt: '2026-10-10T17:00:00.000Z',
    },
  };
  const consumed: DiscussionBatchStatus = {
    ...batch,
    state: 'consumed',
    members: batch.members.map((m) => ({ ...m, state: 'bound' })),
    consumedParent: {
      ownerKind: 'ratings',
      resourceKind: 'rating_comment',
      targetId: p.targetId,
      resourceId: receipt.result.subjectId,
      contentVersion: 1,
    },
  };
  return { actor, intent, initial, sealed, batch, receipt, consumed };
}
