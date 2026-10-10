import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import * as v3 from '../src/media/contracts-v3.js';
import * as v4 from '../src/media/contracts-v4.js';
import { publishCommentSchema } from '../src/community/contracts.js';
import { publishReplySchema } from '../src/community/discussion/contracts.js';

const actor = '11111111-1111-4111-8111-111111111111';
const comment = () => ({
  version: 2 as const,
  batchRequestId: randomUUID(),
  draftId: randomUUID(),
  spaceId: randomUUID(),
  purpose: 'community-comment-images' as const,
  target: { kind: 'comment' as const, postId: randomUUID() },
});
test('discussion v4 is strict and old v3 does not accept any discussion identity', () => {
  const identity = comment();
  assert.deepEqual(v4.mediaBatchIdentitySchema.parse(identity), identity);
  assert.equal(v3.mediaBatchIdentitySchema.safeParse(identity).success, false);
  for (const patch of [
    { version: 1 },
    { purpose: 'community-post-images' },
    { purpose: 'community-reply-images' },
    { target: { ...identity.target, targetReplyId: null } },
    { body: 'must not enter metadata' },
  ])
    assert.equal(
      v4.mediaBatchIdentitySchema.safeParse({ ...identity, ...patch }).success,
      false,
    );
  assert.equal(
    v4.mediaBatchIdentitySchema.safeParse({
      ...identity,
      purpose: 'community-reply-images',
      target: {
        kind: 'reply',
        rootCommentId: randomUUID(),
        targetReplyId: null,
      },
    }).success,
    true,
  );
  assert.notEqual(
    v4.mediaBatchRequestHash(actor, identity),
    v4.mediaBatchRequestHash(actor, {
      ...identity,
      target: { kind: 'comment', postId: randomUUID() },
    }),
  );
});
test('discussion member, reference and target recovery never reuse the post namespace or fourth slot', () => {
  const identity = comment();
  const member = {
    clientRequestId: randomUUID(),
    memberId: randomUUID(),
    sourceSlot: 2,
    declaration: { mime: 'image/png', bytes: 12, sha256: 'a'.repeat(64) },
  };
  assert.ok(v4.mediaMemberPrepareSchema.safeParse(member).success);
  assert.equal(
    v4.mediaMemberPrepareSchema.safeParse({ ...member, sourceSlot: 3 }).success,
    false,
  );
  const publication = {
    clientRequestId: randomUUID(),
    operation: 'publish_comment',
    intentHash: 'b'.repeat(64),
  };
  const recover = {
    publication,
    assetIds: [randomUUID()],
    target: identity.target,
  };
  assert.ok(v4.mediaBatchRecoverPublicationSchema.safeParse(recover).success);
  assert.equal(
    v4.mediaBatchRecoverPublicationSchema.safeParse({
      publication,
      assetIds: recover.assetIds,
    }).success,
    false,
  );
  assert.equal(
    v3.mediaBatchRecoverPublicationSchema.safeParse(recover).success,
    false,
  );
  assert.equal(
    v4.publicationReferenceSchema.safeParse({
      ...publication,
      operation: 'publish_post',
    }).success,
    false,
  );
  assert.notEqual(
    v4.mediaMemberRequestHash(actor, identity, member),
    v4.mediaMemberRequestHash(actor, identity, { ...member, sourceSlot: 1 }),
  );
});
test('original Community comment and reply bodies still allow exact pure-image subsets 1..3 only', () => {
  for (const schema of [publishCommentSchema, publishReplySchema]) {
    const base = {
      clientRequestId: randomUUID(),
      authorMode: 'named',
      text: '',
      ...(schema === publishReplySchema ? { targetReplyId: null } : {}),
    };
    for (const size of [1, 3])
      assert.ok(
        schema.safeParse({
          ...base,
          imageAssetIds: Array.from({ length: size }, () => randomUUID()),
        }).success,
      );
    for (const images of [[], Array.from({ length: 4 }, () => randomUUID())])
      assert.equal(
        schema.safeParse({ ...base, imageAssetIds: images }).success,
        false,
      );
    const id = randomUUID();
    assert.equal(
      schema.safeParse({ ...base, imageAssetIds: [id, id] }).success,
      false,
    );
  }
});
test('v4 cancel-before-prepare has null historical ancestor and recorded identities require one', () => {
  const base = {
    version: 4,
    batchRequestId: randomUUID(),
    batchRequestHash: 'a'.repeat(64),
    batchIdentity: null,
    resolvedPostId: null,
    batchId: null,
    revision: '1',
    serverNow: 1000,
    orderedMemberIds: [],
    members: [],
    retiring: [],
    status: 'terminal',
    reason: 'cancelled',
    cleanup: 'confirmed',
  };
  assert.ok(v4.mediaBatchStatusSchema.safeParse(base).success);
  assert.equal(
    v4.mediaBatchStatusSchema.safeParse({
      ...base,
      resolvedPostId: randomUUID(),
    }).success,
    false,
  );
  const identity = comment();
  const recorded = {
    ...base,
    batchRequestId: identity.batchRequestId,
    batchIdentity: identity,
    batchId: randomUUID(),
    resolvedPostId: identity.target.postId,
  };
  assert.ok(v4.mediaBatchStatusSchema.safeParse(recorded).success);
  assert.equal(
    v4.mediaBatchStatusSchema.safeParse({ ...recorded, resolvedPostId: null })
      .success,
    false,
  );
  assert.equal(
    v4.mediaBatchStatusSchema.safeParse({
      ...recorded,
      resolvedPostId: randomUUID(),
    }).success,
    false,
  );
});
