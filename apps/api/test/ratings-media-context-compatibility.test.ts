import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  ratingScopedContextSchema,
  ratingScopedIntentSchema,
  ratingScopedReceiptSchema,
} from '../src/ratings/scoped/contracts.js';
import {
  ratingTargetCoverContextSchema,
  ratingCurrentScopedCommandHash,
  ratingTargetCoverReceiptSchema,
} from '../src/ratings/scoped/target-cover-contracts.js';
import { ratingScopedRequestReceiptSchema } from '../src/ratings/scoped/request-receipt.js';
import { ratingScopedCommandHash } from '../src/ratings/scoped/protocol-registry.js';
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const token = 'a'.repeat(43),
  digest = 'b'.repeat(64);
const commandContext = {
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
const common = {
  id: id(1),
  token,
  tokenDigest: commandContext.tokenDigest,
  actorId: id(8),
  sessionGeneration: digest,
  selector: { kind: 'global' },
  purpose: 'read',
  mode: 'public',
  scopeRevision: digest,
  protocolGeneration: id(2),
  heads: [{ scopeKey: 'global', catalogRevision: id(3), headRevision: id(4) }],
  sourceDigest: digest,
  identityCampusId: null,
  issuedAt: '2026-10-10T00:00:00.000Z',
  expiresAt: '2026-10-10T00:05:00.000Z',
  capabilities: ['read'],
};

test('context 2 and context 3 remain strict independent wire contracts in both directions', () => {
  const old = { protocolVersion: 2, ...common },
    current = {
      protocolVersion: 3,
      ...common,
      capabilities: ['read', 'target_cover'],
    };
  assert.deepEqual(ratingScopedContextSchema.parse(old), old);
  assert.deepEqual(ratingTargetCoverContextSchema.parse(current), current);
  assert.equal(ratingScopedContextSchema.safeParse(current).success, false);
  assert.equal(ratingTargetCoverContextSchema.safeParse(old).success, false);
  for (const bad of [
    { protocolVersion: 3, context: old },
    { ...current, authority: {} },
    { ...current, tokenDigest: 'c'.repeat(64) },
    { ...current, expiresAt: common.issuedAt },
  ])
    assert.equal(ratingTargetCoverContextSchema.safeParse(bad).success, false);
  // Optional registration absence changes no legacy fields and cannot grant cover.
  assert.deepEqual(
    ratingScopedContextSchema.parse(JSON.parse(JSON.stringify(old))),
    old,
  );
  assert.equal(
    ratingScopedContextSchema.parse(old).capabilities.includes('target_cover'),
    false,
  );
});

test('historical command hash and receipt recovery retain a fixed v2 golden after v3 registration', () => {
  const legacy = ratingScopedIntentSchema.parse({
    protocolVersion: 2,
    operation: 'create_target_scoped',
    context: commandContext,
    payload: {
      clientRequestId: id(5),
      categoryId: id(6),
      expectedCategoryRevision: id(7),
      name: 'Legacy receipt',
      description: '',
      assetIds: [],
    },
  });
  const goldenHash =
    '490603fa73b950503d4754a180171d68ea181c8b70bd322ef9afacab4782aa90';
  assert.equal(ratingScopedCommandHash(legacy), goldenHash);
  assert.equal(ratingCurrentScopedCommandHash(legacy), goldenHash);
  const receipt = {
    protocolVersion: 2,
    requestId: id(5),
    operation: 'create_target_scoped',
    intentHash: goldenHash,
    outcome: 'applied',
    result: {
      targetId: id(11),
      revision: id(12),
      catalogRevision: id(3),
      occurredAt: '2026-10-10T00:00:00.000Z',
    },
  };
  const bytes = JSON.stringify(receipt);
  assert.equal(
    JSON.stringify(ratingScopedReceiptSchema.parse(JSON.parse(bytes))),
    bytes,
  );
  assert.equal(
    JSON.stringify(ratingScopedRequestReceiptSchema.parse(JSON.parse(bytes))),
    bytes,
  );
  assert.equal(
    ratingTargetCoverReceiptSchema.safeParse(receipt).success,
    false,
  );
  assert.equal(
    ratingScopedReceiptSchema.safeParse({ ...receipt, protocolVersion: 3 })
      .success,
    false,
  );
  for (const outcome of ['applied', 'noop', 'closed'] as const) {
    const value =
      outcome === 'closed'
        ? {
            protocolVersion: 2,
            requestId: id(5),
            operation: 'create_target_scoped',
            intentHash: goldenHash,
            outcome,
            code: 'RATING_CREATION_CANCELLED',
          }
        : { ...receipt, outcome };
    assert.deepEqual(
      ratingScopedRequestReceiptSchema.parse(value),
      ratingScopedReceiptSchema.parse(value),
    );
  }
});
