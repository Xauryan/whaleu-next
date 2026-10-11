import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  prepareCategoryIconMediaSchema,
  categoryIconMediaRequestHash,
  categoryIconMediaParentSchema,
  categoryIconMediaDescriptorSchema,
  categoryIconMediaStatusSchema,
} from '../src/media/contracts-category-icon.js';
import { prepareRatingsMediaSchema } from '../src/media/contracts-ratings.js';
import { prepareProfileMediaSchema } from '../src/media/contracts-profile.js';
import { prepareMediaV4Schema } from '../src/media/contracts-v4.js';

const prepare = () => ({
  protocol: 'ratings-category-icon-media-v1' as const,
  clientRequestId: randomUUID(),
  editScopeId: randomUUID(),
  scopeRevision: 'a'.repeat(64),
  slot: 'icon' as const,
  declaration: {
    mime: 'image/png' as const,
    bytes: 12,
    sha256: 'b'.repeat(64),
  },
});
test('Category icon upload has an independent exact canonical identity and opaque icon slot', () => {
  const actor = randomUUID(),
    input = prepare();
  assert.deepEqual(prepareCategoryIconMediaSchema.parse(input), input);
  assert.equal(
    categoryIconMediaRequestHash(actor, input),
    createHash('sha256')
      .update('whaleu-ratings-category-icon-media-prepare:v1\n')
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
      categoryIconMediaRequestHash(actor, { ...input, ...patch }),
      categoryIconMediaRequestHash(actor, input),
    );
  for (const schema of [
    prepareRatingsMediaSchema,
    prepareProfileMediaSchema,
    prepareMediaV4Schema,
  ])
    assert.equal(schema.safeParse(input).success, false);
  for (const extra of [
    { approved: true },
    { url: 'https://invalid.test' },
    { ordinal: 0 },
    { assetId: randomUUID() },
    { protocolVersion: 8 },
  ])
    assert.equal(
      prepareCategoryIconMediaSchema.safeParse({ ...input, ...extra }).success,
      false,
    );
});
test('Category icon parent is an immutable appearance, never a Profile guest/avatar parent', () => {
  const parent = {
    ownerKind: 'ratings',
    resourceKind: 'category_icon',
    resourceId: randomUUID(),
    contentVersion: 1,
  };
  assert.deepEqual(categoryIconMediaParentSchema.parse(parent), parent);
  for (const patch of [
    { ownerKind: 'profile' },
    { resourceKind: 'avatar' },
    { resourceKind: 'target_cover' },
    { targetId: randomUUID() },
    { contentVersion: 2 },
    { audience: 'profile-public' },
  ])
    assert.equal(
      categoryIconMediaParentSchema.safeParse({ ...parent, ...patch }).success,
      false,
    );
});
test('Category icon historical media recovery exposes no current descriptor or business receipt', () => {
  const historical = {
    protocol: 'ratings-category-icon-media-v1',
    editScopeId: randomUUID(),
    intentId: randomUUID(),
    requestId: randomUUID(),
    requestHash: 'a'.repeat(64),
    serverNow: 1,
    status: 'bound_history',
    assetId: randomUUID(),
    bindingId: randomUUID(),
    appearanceId: randomUUID(),
    categoryId: randomUUID(),
    attachmentState: 'detached',
  };
  assert.equal(
    categoryIconMediaStatusSchema.safeParse(historical).success,
    true,
  );
  assert.equal(
    categoryIconMediaStatusSchema.safeParse({
      ...historical,
      url: 'https://invalid.test',
    }).success,
    false,
  );
  assert.equal(
    categoryIconMediaDescriptorSchema.safeParse(historical).success,
    false,
  );
});

test('Category icon Media8 fixed request hash preserves its independent domain', () => {
  assert.equal(
    categoryIconMediaRequestHash('00000000-0000-4000-8000-000000000001', {
      protocol: 'ratings-category-icon-media-v1',
      clientRequestId: '00000000-0000-4000-8000-000000000002',
      editScopeId: '00000000-0000-4000-8000-000000000003',
      scopeRevision:
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      slot: 'icon',
      declaration: {
        mime: 'image/png',
        bytes: 12,
        sha256:
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    }),
    '9bdce7cc80fc5e3ba070bd44bec62e3dff20680bc5f521ec1770af9235df0d57',
  );
});
