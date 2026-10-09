import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { z } from 'zod';
import {
  prepareRatingTargetEditSchema,
  ratingTargetEditContextSchema,
  ratingTargetEditPreparationSchema,
  ratingTargetEditReceiptSchema,
} from '../src/ratings/management/target-edit/contracts.js';
import { ratingTargetEditIntentHash } from '../src/ratings/management/target-edit/requests.js';
import { RatingsAccessService } from '../src/ratings/access.js';
const targetId = randomUUID(),
  revision = randomUUID(),
  definitionRevision = randomUUID(),
  categoryId = randomUUID(),
  categoryRevision = randomUUID(),
  catalogRevision = randomUUID();
const intent = () =>
  prepareRatingTargetEditSchema.parse({
    clientRequestId: randomUUID(),
    targetId,
    regionId: null,
    expectedTargetRevision: revision,
    expectedDefinitionRevision: definitionRevision,
    expectedContentVersion: 1,
    categoryId,
    expectedCategoryRevision: categoryRevision,
    expectedCatalogRevision: catalogRevision,
    name: 'Original text',
    description: '',
    assetIds: [],
  });
test('M2B exact intent binds lifecycle, definition, version, catalog and immutable scope without authority extras', () => {
  const original = intent();
  assert.deepEqual(prepareRatingTargetEditSchema.parse(original), original);
  for (const key of [
    'creatorId',
    'admin',
    'sourceId',
    'campusId',
    'afterRevision',
    'definitionRevision',
    'contextRevision',
  ])
    assert.throws(() =>
      prepareRatingTargetEditSchema.parse({ ...original, [key]: randomUUID() }),
    );
  for (const expectedContentVersion of [0, 1.5, 2147483647])
    assert.throws(() =>
      prepareRatingTargetEditSchema.parse({
        ...original,
        expectedContentVersion,
      }),
    );
  assert.throws(() =>
    prepareRatingTargetEditSchema.parse({
      ...original,
      assetIds: [randomUUID()],
    }),
  );
  const first = ratingTargetEditIntentHash(original);
  for (const patch of [
    { name: 'Changed text' },
    { description: 'Changed description' },
    { expectedContentVersion: 2 },
    { regionId: randomUUID() },
    { expectedDefinitionRevision: randomUUID() },
    { expectedTargetRevision: randomUUID() },
  ])
    assert.notEqual(
      ratingTargetEditIntentHash({ ...original, ...patch }),
      first,
    );
  assert.equal(ratingTargetEditIntentHash({ ...original }), first);
});
test('M2B current context is exact while preparation and historical receipts never include target text', () => {
  const current = {
    targetId,
    revision,
    definitionRevision,
    contentVersion: 1,
    regionId: null,
    categoryId,
    categoryRevision,
    catalogRevision,
    name: 'Visible current text',
    description: '',
  };
  assert.deepEqual(ratingTargetEditContextSchema.parse(current), current);
  for (const noncanonical of [
    { name: ' Untrimmed context ' },
    { description: 'Not\r\ncanonical' },
  ])
    assert.equal(
      ratingTargetEditContextSchema.safeParse({ ...current, ...noncanonical })
        .success,
      false,
      'Current response text is canonical, not silently normalized input',
    );
  assert.doesNotThrow(() => z.toJSONSchema(ratingTargetEditContextSchema));
  for (const field of [
    'creatorId',
    'review',
    'history',
    'sourceId',
    'originCampusId',
  ])
    assert.throws(() =>
      ratingTargetEditContextSchema.parse({ ...current, [field]: null }),
    );
  const prepared = {
    requestId: randomUUID(),
    targetId,
    revision: randomUUID(),
    definitionRevision: randomUUID(),
    contentVersion: 2,
    contextRevision: 'a'.repeat(43),
  };
  assert.deepEqual(ratingTargetEditPreparationSchema.parse(prepared), prepared);
  assert.throws(() =>
    ratingTargetEditPreparationSchema.parse({ ...prepared, name: 'Private' }),
  );
  const receipt = {
    requestId: prepared.requestId,
    operation: 'edit_target',
    outcome: 'applied',
    targetId,
    revision: prepared.revision,
    definitionRevision: prepared.definitionRevision,
    contentVersion: 2,
    occurredAt: '2026-01-01T00:00:00.123456Z',
  };
  assert.deepEqual(ratingTargetEditReceiptSchema.parse(receipt), receipt);
  for (const extra of [
    { name: 'Private' },
    { envelope: {} },
    { creatorId: randomUUID() },
    { contextRevision: prepared.contextRevision },
  ])
    assert.throws(() =>
      ratingTargetEditReceiptSchema.parse({ ...receipt, ...extra }),
    );
  for (const code of [
    'RATING_UNAVAILABLE',
    'CONTENT_REVIEW_UNAVAILABLE',
    'SAFETY_UNAVAILABLE',
    'VERIFICATION_UNAVAILABLE',
    'REQUEST_NOT_FOUND',
  ])
    assert.throws(() =>
      ratingTargetEditReceiptSchema.parse({
        requestId: prepared.requestId,
        operation: 'edit_target',
        outcome: 'rejected',
        code,
      }),
    );
});
function accessFixture(
  affiliation: 'verified' | 'unverified' | 'unavailable',
  administrator: boolean,
) {
  let roleReads = 0,
    ordinaryReads = 0;
  const service = new RatingsAccessService(
    { activeAccount: async () => true } as never,
    {
      phone: async () => ({ status: 'verified', fingerprint: 'phone' }),
      affiliation: async () => ({
        status: affiliation,
        fingerprint: 'affiliation',
      }),
    } as never,
    {
      scope: async () => {
        roleReads++;
        return administrator ? { kind: 'global' } : { kind: 'ordinary' };
      },
    } as never,
    {
      ordinary: async () => {
        ordinaryReads++;
        return { fingerprint: 'ordinary' };
      },
    } as never,
    {
      requireAllowed: async () => undefined,
      requireEditAllowed: async () => undefined,
      requireDeletionAllowed: async () => undefined,
      navigation: async () => 'safety',
    } as never,
  );
  const tx = { query: async () => ({ rows: [] }) } as never;
  return { service, tx, roles: () => roleReads, ordinary: () => ordinaryReads };
}
test('M2B a creator administrator cannot substitute managed grants for ordinary affiliation, while M2A cleanup remains independent', async () => {
  const regionId = randomUUID(),
    actor = randomUUID();
  for (const affiliation of [
    'verified',
    'unverified',
    'unavailable',
  ] as const) {
    for (const administrator of [false, true]) {
      const f = accessFixture(affiliation, administrator);
      if (affiliation === 'verified')
        assert.equal(
          (await f.service.resolveOwnerEditAccount(actor, regionId, f.tx))
            .regionId,
          regionId,
        );
      else
        await assert.rejects(
          () => f.service.resolveOwnerEditAccount(actor, regionId, f.tx),
          (error: unknown) =>
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            error.code ===
              (affiliation === 'unverified'
                ? 'AFFILIATION_VERIFICATION_REQUIRED'
                : 'VERIFICATION_UNAVAILABLE'),
        );
      assert.equal(f.roles(), 0);
      assert.equal(f.ordinary(), affiliation === 'verified' ? 1 : 0);
      await f.service.requireDeletionActor(actor, f.tx);
      assert.equal(
        f.roles(),
        0,
        'Hidden cleanup never inherits editing role/affiliation gates',
      );
    }
  }
  const global = accessFixture('unavailable', true);
  assert.equal(
    (await global.service.resolveOwnerEditAccount(actor, null, global.tx))
      .regionId,
    null,
  );
  assert.equal(global.roles(), 0);
  assert.equal(global.ordinary(), 0);
});
