import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  prepareRatingsMediaSchema,
  ratingsMediaRequestHash,
  ratingsMediaParentSchema,
  ratingsMediaDescriptorSchema,
  ratingsMediaStatusSchema,
} from '../src/media/contracts-ratings.js';
import { prepareProfileMediaSchema } from '../src/media/contracts-profile.js';
import { prepareMediaV4Schema } from '../src/media/contracts-v4.js';

const prepare = () => ({
  protocol: 'ratings-target-media-v1' as const,
  clientRequestId: randomUUID(),
  editScopeId: randomUUID(),
  scopeRevision: 'a'.repeat(64),
  slot: 'cover' as const,
  declaration: {
    mime: 'image/png' as const,
    bytes: 12,
    sha256: 'b'.repeat(64),
  },
});
test('Ratings upload has an independent exact canonical identity and opaque cover slot', () => {
  const actor = randomUUID(),
    input = prepare();
  assert.deepEqual(prepareRatingsMediaSchema.parse(input), input);
  assert.equal(
    ratingsMediaRequestHash(actor, input),
    createHash('sha256')
      .update('whaleu-ratings-target-media-prepare:v1\n')
      .update(
        JSON.stringify({
          protocol: input.protocol,
          actorAccountId: actor,
          clientRequestId: input.clientRequestId,
          editScopeId: input.editScopeId,
          scopeRevision: input.scopeRevision,
          slot: input.slot,
          declaration: input.declaration,
        }),
      )
      .digest('hex'),
  );
  for (const patch of [
    { editScopeId: randomUUID() },
    { scopeRevision: 'c'.repeat(64) },
    { declaration: { ...input.declaration, bytes: 13 } },
  ])
    assert.notEqual(
      ratingsMediaRequestHash(actor, { ...input, ...patch }),
      ratingsMediaRequestHash(actor, input),
    );
  for (const schema of [prepareProfileMediaSchema, prepareMediaV4Schema])
    assert.equal(schema.safeParse(input).success, false);
  for (const extra of [
    { approved: true },
    { url: 'https://invalid.test' },
    { ordinal: 0 },
    { assetId: randomUUID() },
    { protocolVersion: 6 },
  ])
    assert.equal(
      prepareRatingsMediaSchema.safeParse({ ...input, ...extra }).success,
      false,
    );
});
test('Ratings parent is an immutable appearance, never a Profile guest/avatar parent', () => {
  const parent = {
    ownerKind: 'ratings',
    resourceKind: 'target_cover',
    resourceId: randomUUID(),
    contentVersion: 1,
  };
  assert.deepEqual(ratingsMediaParentSchema.parse(parent), parent);
  for (const patch of [
    { ownerKind: 'profile' },
    { resourceKind: 'avatar' },
    { contentVersion: 2 },
    { audience: 'profile-public' },
  ])
    assert.equal(
      ratingsMediaParentSchema.safeParse({ ...parent, ...patch }).success,
      false,
    );
});
test('Ratings historical media recovery exposes no current descriptor or business receipt', () => {
  const historical = {
    protocol: 'ratings-target-media-v1',
    editScopeId: randomUUID(),
    intentId: randomUUID(),
    requestId: randomUUID(),
    requestHash: 'a'.repeat(64),
    serverNow: 1,
    status: 'bound_history',
    assetId: randomUUID(),
    bindingId: randomUUID(),
    appearanceId: randomUUID(),
    targetId: randomUUID(),
    attachmentState: 'detached',
  };
  assert.equal(ratingsMediaStatusSchema.safeParse(historical).success, true);
  assert.equal(
    ratingsMediaStatusSchema.safeParse({
      ...historical,
      url: 'https://invalid.test',
    }).success,
    false,
  );
  assert.equal(
    ratingsMediaDescriptorSchema.safeParse(historical).success,
    false,
  );
});
