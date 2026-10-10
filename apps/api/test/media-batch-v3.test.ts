import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { prepareMediaSchema } from '../src/media/contracts.js';
import {
  prepareMediaV2Schema,
  mediaRequestHash,
} from '../src/media/contracts-v2.js';
import {
  mediaBatchIdentitySchema,
  mediaBatchRequestHash,
  mediaMemberPrepareSchema,
  mediaMemberRequestHash,
  mediaBatchLayoutSchema,
  mediaBatchSealSchema,
  mediaBatchCommandHash,
  mediaAttachmentPlanDigest,
  mediaBatchStatusSchema,
  mediaMemberStatusSchema,
} from '../src/media/contracts-v3.js';
const identity = () => ({
  version: 1 as const,
  batchRequestId: randomUUID(),
  draftId: randomUUID(),
  spaceId: randomUUID(),
  purpose: 'community-post-images' as const,
});
const member = () => ({
  clientRequestId: randomUUID(),
  memberId: randomUUID(),
  sourceSlot: 0,
  declaration: { mime: 'image/png' as const, bytes: 8, sha256: 'a'.repeat(64) },
});
test('v3 identities are exact, bounded and isolated from legacy zero-ordinal protocols', () => {
  const actor = randomUUID(),
    batch = identity(),
    m = member();
  const hash = mediaMemberRequestHash(actor, batch, m);
  for (const changed of [
    { ...m, sourceSlot: 8 },
    { ...m, memberId: randomUUID() },
    { ...m, clientRequestId: randomUUID() },
    { ...m, declaration: { ...m.declaration, sha256: 'b'.repeat(64) } },
  ])
    assert.notEqual(hash, mediaMemberRequestHash(actor, batch, changed));
  assert.notEqual(hash, mediaMemberRequestHash(randomUUID(), batch, m));
  assert.notEqual(
    hash,
    mediaMemberRequestHash(actor, { ...batch, draftId: randomUUID() }, m),
  );
  for (const invalid of [
    { ...batch, version: 3 },
    { ...batch, purpose: 'comment-images' },
    { ...batch, url: 'x' },
  ])
    assert.equal(mediaBatchIdentitySchema.safeParse(invalid).success, false);
  for (const invalid of [
    { ...m, sourceSlot: 9 },
    { ...m, sourceSlot: -1 },
    { ...m, path: '/tmp/x' },
    { ...m, declaration: { ...m.declaration, bytes: 5242881 } },
  ])
    assert.equal(mediaMemberPrepareSchema.safeParse(invalid).success, false);
  const old = {
    clientRequestId: m.clientRequestId,
    purpose: 'community-post-image',
    draftId: batch.draftId,
    spaceId: batch.spaceId,
    slot: 'images',
    ordinal: 0,
    declaration: m.declaration,
  };
  assert.equal(prepareMediaV2Schema.safeParse(old).success, true);
  assert.equal(
    prepareMediaV2Schema.safeParse({ ...old, ordinal: 1 }).success,
    false,
  );
  assert.equal(
    prepareMediaV2Schema.safeParse({ ...old, batchId: randomUUID() }).success,
    false,
  );
  assert.equal(prepareMediaSchema.safeParse(old).success, false);
  const oldHash = createHash('sha256')
    .update('whaleu-media-request:v2\n')
    .update(
      JSON.stringify({
        version: 2,
        actorAccountId: actor,
        clientRequestId: old.clientRequestId,
        purpose: old.purpose,
        draftId: old.draftId,
        spaceId: old.spaceId,
        slot: old.slot,
        ordinal: 0,
        declaration: m.declaration,
      }),
    )
    .digest('hex');
  assert.equal(mediaRequestHash(actor, old), oldHash);
  assert.notEqual(mediaBatchRequestHash(actor, batch), hash);
});
test('layout and seal bind exact unique full order, revision and publication command', () => {
  const ids = Array.from({ length: 9 }, () => randomUUID()),
    batchId = randomUUID();
  const layout = {
    commandId: randomUUID(),
    expectedRevision: '1',
    orderedMemberIds: ids,
    removeMemberIds: [],
  };
  assert.equal(mediaBatchLayoutSchema.safeParse(layout).success, true);
  assert.equal(
    mediaBatchLayoutSchema.safeParse({
      ...layout,
      orderedMemberIds: [...ids, randomUUID()],
    }).success,
    false,
  );
  assert.equal(
    mediaBatchLayoutSchema.safeParse({
      ...layout,
      orderedMemberIds: [ids[0], ids[0]],
    }).success,
    false,
  );
  assert.equal(
    mediaBatchLayoutSchema.safeParse({ ...layout, removeMemberIds: [ids[0]] })
      .success,
    false,
  );
  assert.notEqual(
    mediaBatchCommandHash('layout', batchId, layout),
    mediaBatchCommandHash('layout', batchId, {
      ...layout,
      orderedMemberIds: [...ids].reverse(),
    }),
  );
  const seal = {
    commandId: randomUUID(),
    expectedRevision: '2',
    orderedMemberIds: ids,
    publication: {
      clientRequestId: randomUUID(),
      operation: 'publish_post',
      intentHash: 'b'.repeat(64),
    },
  };
  assert.equal(
    mediaBatchSealSchema.safeParse({ ...seal, orderedMemberIds: [] }).success,
    false,
  );
  assert.notEqual(
    mediaBatchCommandHash('seal', batchId, seal),
    mediaBatchCommandHash('seal', batchId, {
      ...seal,
      publication: { ...seal.publication, intentHash: 'c'.repeat(64) },
    }),
  );
  const assets = ids.map((memberId) => ({
    memberId,
    assetId: randomUUID(),
    manifestDigest: 'a'.repeat(64),
  }));
  assert.notEqual(
    mediaAttachmentPlanDigest(batchId, '3', assets),
    mediaAttachmentPlanDigest(batchId, '3', [...assets].reverse()),
  );
  assert.notEqual(
    mediaAttachmentPlanDigest(batchId, '3', assets),
    mediaAttachmentPlanDigest(batchId, '4', assets),
  );
});
test('batch recovery carries original declarations, no payload/locator and cannot omit unknown members', () => {
  const actor = randomUUID(),
    batch = identity(),
    batchId = randomUUID(),
    m = member(),
    intentId = randomUUID(),
    requestHash = mediaMemberRequestHash(actor, batch, m);
  const status = {
    version: 3,
    batchId,
    memberId: m.memberId,
    sourceSlot: 0,
    requestId: m.clientRequestId,
    requestHash,
    intentId,
    assetId: null,
    manifestDigest: null,
    prepare: m,
    observation: {
      version: 2,
      intentId,
      requestId: m.clientRequestId,
      requestHash,
      serverNow: 1,
      status: 'unavailable',
      reason: 'MEDIA_UNAVAILABLE',
      retryable: true,
    },
  };
  assert.equal(mediaMemberStatusSchema.safeParse(status).success, true);
  assert.equal(
    mediaMemberStatusSchema.safeParse({
      ...status,
      requestHash: 'b'.repeat(64),
    }).success,
    false,
  );
  const recovery = {
    version: 3,
    batchRequestId: batch.batchRequestId,
    batchRequestHash: mediaBatchRequestHash(actor, batch),
    batchIdentity: batch,
    batchId,
    revision: '2',
    serverNow: 1,
    orderedMemberIds: [m.memberId],
    members: [status],
    retiring: [],
    status: 'unavailable',
    reason: 'MEDIA_UNAVAILABLE',
    retryable: true,
  };
  assert.equal(mediaBatchStatusSchema.safeParse(recovery).success, true);
  for (const invalid of [
    { ...recovery, members: [] },
    { ...recovery, body: 'private post' },
    { ...recovery, url: 'https://example.invalid' },
    { ...recovery, members: [status, status] },
  ])
    assert.equal(mediaBatchStatusSchema.safeParse(invalid).success, false);
});
