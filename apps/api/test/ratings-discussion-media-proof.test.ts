import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import {
  startTransactionDeadlines,
  clearTransactionDeadlines,
  checkpointTransactionDeadlines,
  restoreTransactionDeadlines,
} from '../src/database/transaction-deadlines.js';
import { RatingsDiscussionMediaProofRegistry } from '../src/media/ratings-discussion-owner-proof.js';
import type {
  RatingsDiscussionMediaReadRequest,
  RatingsDiscussionMediaReadProof,
} from '../src/media/ratings-discussion-owner-proof.js';
import {
  ratingsDiscussionMediaDescriptorSchema,
  ratingsDiscussionMemberPrepareSchema,
  ratingsDiscussionSealedPlanSchema,
} from '../src/media/contracts-ratings-discussion.js';
test('Media7 read proof binds authenticated current whole-set, exact request and transaction epoch', async () => {
  const tx = {} as PoolClient,
    actor = randomUUID(),
    request: RatingsDiscussionMediaReadRequest = {
      targetId: randomUUID(),
      rootId: randomUUID(),
      replyId: null,
      subjectRevision: randomUUID(),
      contextId: randomUUID(),
      contextToken: 'a'.repeat(43),
      attachmentSetDigest: 'b'.repeat(64),
      purpose: 'download',
      requestId: randomUUID(),
    };
  const images = Array.from({ length: 9 }, (_, ordinal) => ({
    ordinal,
    assetId: randomUUID(),
    manifestDigest: 'c'.repeat(64),
    bindingId: randomUUID(),
  }));
  const registry = new RatingsDiscussionMediaProofRegistry({
    authorizeCurrent: async () => ({
      principal: {
        kind: 'authenticatedRatings',
        accountId: actor,
        sessionId: randomUUID(),
      },
      actorAccountId: actor,
      parent: {
        ownerKind: 'ratings',
        resourceKind: 'rating_comment',
        targetId: request.targetId,
        resourceId: request.rootId,
        contentVersion: 1,
      },
      subjectRevision: request.subjectRevision,
      attachmentSetDigest: request.attachmentSetDigest,
      images,
      ownerRevision: 'd'.repeat(64),
      reviewRevision: 'e'.repeat(64),
    }),
  });
  startTransactionDeadlines(tx);
  try {
    const checkpoint = checkpointTransactionDeadlines(tx),
      proof = await registry.authorize('token', request, tx);
    assert.equal(registry.require(proof, request, tx).images.length, 9);
    assert.throws(() =>
      registry.require({} as RatingsDiscussionMediaReadProof, request, tx),
    );
    assert.throws(() =>
      registry.require(proof, { ...request, requestId: randomUUID() }, tx),
    );
    assert.throws(() => registry.require(proof, request, {} as PoolClient));
    restoreTransactionDeadlines(tx, checkpoint);
    assert.throws(() => registry.require(proof, request, tx));
  } finally {
    clearTransactionDeadlines(tx);
  }
});
test('Media7 input cannot claim manifest approval or redirect delivery; ordered assets must be unique', () => {
  const member = {
    protocol: 'ratings-discussion-media-v1',
    clientRequestId: randomUUID(),
    batchId: randomUUID(),
    batchIdentityHash: 'a'.repeat(64),
    memberId: randomUUID(),
    sourceSlot: 127,
    declaration: {
      mime: 'image/png',
      bytes: 5 * 1024 * 1024,
      sha256: 'a'.repeat(64),
    },
  };
  assert.equal(
    ratingsDiscussionMemberPrepareSchema.safeParse(member).success,
    true,
  );
  for (const extra of [
    { manifestDigest: 'a'.repeat(64) },
    { purpose: 'ratings-target-cover-image' },
    { approved: true },
    { sourceSlot: 128 },
  ])
    assert.equal(
      ratingsDiscussionMemberPrepareSchema.safeParse({ ...member, ...extra })
        .success,
      false,
    );
  const image = {
    ordinal: 0,
    memberId: randomUUID(),
    assetId: randomUUID(),
    manifestDigest: 'a'.repeat(64),
  };
  assert.equal(
    ratingsDiscussionSealedPlanSchema.safeParse({
      batchId: member.batchId,
      batchIdentityHash: member.batchIdentityHash,
      orderedMembers: [image, { ...image, ordinal: 1 }],
    }).success,
    false,
  );
  const descriptor = {
    protocol: 'ratings-discussion-media-v1',
    kind: 'ratings-discussion-media',
    targetId: randomUUID(),
    rootId: randomUUID(),
    replyId: null,
    subjectRevision: randomUUID(),
    contextId: randomUUID(),
    contextToken: 'a'.repeat(43),
    bindingId: randomUUID(),
    ordinal: 8,
    attachmentSetDigest: 'a'.repeat(64),
    width: 100,
    height: 100,
    variants: ['thumb-v1', 'display-v1'],
  };
  assert.equal(
    ratingsDiscussionMediaDescriptorSchema.safeParse(descriptor).success,
    true,
  );
  assert.equal(
    ratingsDiscussionMediaDescriptorSchema.safeParse({
      ...descriptor,
      url: 'https://example.org',
    }).success,
    false,
  );
  assert.equal(
    ratingsDiscussionMediaDescriptorSchema.safeParse({
      ...descriptor,
      replyId: randomUUID(),
    }).success,
    false,
  );
});
