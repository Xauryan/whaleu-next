import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../src/community/content-review/contracts.js';
import { ratingScopedIntentSchema } from '../src/ratings/scoped/contracts.js';
import { ratingScopedCommandHash } from '../src/ratings/scoped/protocol-registry.js';
import {
  ratingTargetCoverIntentSchema,
  ratingTargetCoverCommandHash,
  ratingCurrentScopedIntentSchema,
  ratingTargetCoverReceiptSchema,
  ratingTargetCoverUploadScopeSchema,
} from '../src/ratings/scoped/target-cover-contracts.js';
import {
  canonicalRatingTargetCoverEnvelope,
  canonicalRatingTargetCoverDefinition,
  ratingTargetCoverApprovalDigest,
} from '../src/community/content-review/rating-target-cover-contracts.js';
import { canonicalAnyRatingTargetDefinition } from '../src/community/content-review/rating-target-definition-contracts.js';
import { canonicalRatingScopedEnvelope } from '../src/community/content-review/rating-scoped-contracts.js';
const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;
const token = 'a'.repeat(43),
  digest = 'b'.repeat(64);
const context = {
  id: id(1),
  token,
  tokenDigest: createHash('sha256').update(token).digest('hex'),
  selector: { kind: 'global' as const },
  scopeRevision: digest,
  protocolGeneration: id(2),
  catalogRevision: id(3),
  headRevision: id(4),
  sourceDigest: digest,
};
const body = {
  clientRequestId: id(5),
  categoryId: id(6),
  expectedCategoryRevision: id(7),
  name: 'Generic target',
  description: '',
};
const create = {
  protocolVersion: 3 as const,
  operation: 'create_target_scoped' as const,
  context,
  payload: {
    ...body,
    cover: { action: 'replace' as const, assetId: id(8), uploadScopeId: id(9) },
  },
};
const envelope = {
  version: 6 as const,
  purpose: 'publish_rating_target_cover_scoped' as const,
  accountId: id(10),
  clientRequestId: id(5),
  targetId: id(11),
  targetRevision: id(12),
  categoryId: id(6),
  categoryRevision: id(7),
  scope: {
    selector: { kind: 'global' as const },
    scopeKey: 'global',
    catalogRevision: id(3),
    headRevision: id(4),
    scopeRevision: digest,
    contextId: id(1),
    contextDigest: context.tokenDigest,
    protocolGeneration: id(2),
    sourceDigest: digest,
    topologySnapshotId: null,
  },
  targetOrigin: { regionId: null, originCampusId: null },
  definitionRevision: id(12),
  contentVersion: 1 as const,
  name: body.name,
  description: '',
  cover: { appearanceId: id(13), assetId: id(8), manifestDigest: digest },
};
test('target command3 is a separate exact codec and independent hash domain', () => {
  const parsed = ratingTargetCoverIntentSchema.parse(create);
  assert.equal(ratingScopedIntentSchema.safeParse(parsed).success, false);
  assert.equal(
    ratingCurrentScopedIntentSchema.parse(parsed).protocolVersion,
    3,
  );
  const expected = createHash('sha256')
    .update(
      'whaleu:rating-target-cover-command:v1\n' +
        canonicalJson({
          protocolVersion: 3,
          operation: parsed.operation,
          intent: { context: parsed.context, payload: parsed.payload },
        }),
    )
    .digest('hex');
  assert.equal(ratingTargetCoverCommandHash(parsed), expected);
  const old = ratingScopedIntentSchema.parse({
    ...create,
    protocolVersion: 2,
    payload: { ...body, assetIds: [] },
  });
  assert.notEqual(ratingScopedCommandHash(old), expected);
  assert.equal(
    ratingTargetCoverIntentSchema.safeParse({
      ...create,
      payload: { ...create.payload, assetIds: [] },
    }).success,
    false,
  );
});
test('single cover has explicit keep/replace/clear, required name and complete CAS', () => {
  assert.equal(
    ratingTargetCoverIntentSchema.safeParse({
      ...create,
      payload: { ...body, cover: { action: 'keep' } },
    }).success,
    false,
  );
  assert.equal(
    ratingTargetCoverIntentSchema.safeParse({
      ...create,
      payload: { ...create.payload, name: '' },
    }).success,
    false,
  );
  assert.equal(
    ratingTargetCoverIntentSchema.safeParse({
      ...create,
      payload: {
        ...body,
        cover: { action: 'replace', assetIds: [id(8), id(9)] },
      },
    }).success,
    false,
  );
  assert.equal(
    ratingTargetCoverIntentSchema.safeParse({
      ...create,
      payload: {
        ...body,
        cover: { action: 'clear', url: 'https://example.test/file' },
      },
    }).success,
    false,
  );
  const edit = {
    ...create,
    operation: 'edit_target_scoped',
    payload: {
      ...body,
      targetId: id(11),
      expectedTargetRevision: id(12),
      expectedDefinitionRevision: id(12),
      expectedContentVersion: 1,
      cover: { action: 'keep' },
    },
  };
  assert.equal(ratingTargetCoverIntentSchema.safeParse(edit).success, true);
  assert.equal(
    ratingTargetCoverIntentSchema.safeParse({
      ...edit,
      payload: { ...edit.payload, expectedContentVersion: undefined },
    }).success,
    false,
  );
});
test('Review6 covers the exact manifest and complete body without relabeling Review5', () => {
  const parsed = canonicalRatingTargetCoverEnvelope(envelope);
  assert.throws(() => canonicalRatingScopedEnvelope(parsed));
  const changed = canonicalRatingTargetCoverEnvelope({
    ...envelope,
    cover: { ...envelope.cover, manifestDigest: 'c'.repeat(64) },
  });
  assert.notEqual(
    ratingTargetCoverApprovalDigest(parsed),
    ratingTargetCoverApprovalDigest(changed),
  );
  assert.notEqual(
    ratingTargetCoverApprovalDigest(parsed),
    ratingTargetCoverApprovalDigest(
      canonicalRatingTargetCoverEnvelope({ ...envelope, name: 'Changed' }),
    ),
  );
  const descriptor = {
    targetId: id(11),
    contentVersion: 1,
    definitionRevision: id(12),
    appliedTargetRevision: id(12),
    envelope: parsed,
  };
  assert.deepEqual(
    canonicalAnyRatingTargetDefinition(descriptor),
    canonicalRatingTargetCoverDefinition(descriptor),
  );
  assert.throws(() =>
    canonicalAnyRatingTargetDefinition({
      ...descriptor,
      envelope: { ...parsed, version: 5 },
    }),
  );
  assert.throws(() =>
    canonicalRatingTargetCoverDefinition({
      ...descriptor,
      definitionRevision: id(15),
    }),
  );
  assert.throws(() =>
    canonicalRatingTargetCoverEnvelope({ ...envelope, assetIds: [] }),
  );
});
test('receipt is body-free, exact version and original intent hash', () => {
  const value = {
    protocolVersion: 3,
    requestId: id(5),
    operation: 'create_target_scoped',
    intentHash: ratingTargetCoverCommandHash(create),
    outcome: 'applied',
    result: {
      targetId: id(11),
      revision: id(12),
      catalogRevision: id(3),
      occurredAt: '2026-10-10T00:00:00.000Z',
    },
  };
  assert.equal(ratingTargetCoverReceiptSchema.safeParse(value).success, true);
  assert.equal(
    ratingTargetCoverReceiptSchema.safeParse({
      ...value,
      result: { ...value.result, cover: envelope.cover },
    }).success,
    false,
  );
  assert.equal(
    ratingTargetCoverReceiptSchema.safeParse({ ...value, protocolVersion: 2 })
      .success,
    false,
  );
});
test('upload scope separates upload request, final command and draft revision', () => {
  const input = {
    protocolVersion: 3,
    context,
    clientRequestId: id(21),
    commandRequestId: id(5),
    draftRevision: id(22),
    categoryId: id(6),
    expectedCategoryRevision: id(7),
    target: null,
    declaration: { mime: 'image/jpeg', bytes: 1024, sha256: digest },
  };
  assert.equal(
    ratingTargetCoverUploadScopeSchema.safeParse(input).success,
    true,
  );
  assert.equal(
    ratingTargetCoverUploadScopeSchema.safeParse({ ...input, approved: true })
      .success,
    false,
  );
  assert.equal(
    ratingTargetCoverUploadScopeSchema.safeParse({
      ...input,
      declaration: { ...input.declaration, bytes: 5 * 1024 * 1024 + 1 },
    }).success,
    false,
  );
});
