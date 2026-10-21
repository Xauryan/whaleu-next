import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  accountDeletionCapability,
  requestCommandSchema,
  cancelCommandSchema,
  intentHash,
  ownerKeys,
  INVENTORY_VERSION,
} from '../src/account-deletion/contracts.js';
import { validateCompletionEvidence } from '../src/account-deletion/completion-evidence.js';
test('strict client commands cannot name owners, account IDs, clocks or synthetic policy', () => {
  const value = {
    version: 1,
    requestId: randomUUID(),
    expectedGeneration: '0',
    consent: 'account-deletion-explicit-v1',
  };
  assert.ok(requestCommandSchema.safeParse(value).success);
  for (const key of [
    'accountId',
    'eligibleAt',
    'policy',
    'complete',
    'ownerEvidence',
  ])
    assert.equal(
      requestCommandSchema.safeParse({ ...value, [key]: 'invented' }).success,
      false,
    );
  assert.equal(
    cancelCommandSchema.safeParse({
      version: 1,
      requestId: value.requestId,
      commandId: randomUUID(),
      expectedRevision: '1',
      action: 'login',
    }).success,
    false,
  );
  assert.equal(
    intentHash(requestCommandSchema.parse(value)),
    intentHash(requestCommandSchema.parse({ ...value })),
  );
  assert.notEqual(
    intentHash(requestCommandSchema.parse(value)),
    intentHash(
      requestCommandSchema.parse({ ...value, expectedGeneration: '1' }),
    ),
  );
});
test('completion requires every exact owner, generation and inventory once', () => {
  const requestId = randomUUID(),
    evidence = ownerKeys.map((owner) => ({
      owner,
      requestId,
      generation: '1',
      inventory: INVENTORY_VERSION,
      proof: 'a'.repeat(64),
    }));
  validateCompletionEvidence(requestId, '1', evidence);
  assert.throws(() =>
    validateCompletionEvidence(requestId, '1', evidence.slice(1)),
  );
  assert.throws(() => validateCompletionEvidence(requestId, '2', evidence));
  assert.throws(() =>
    validateCompletionEvidence(requestId, '1', [
      ...evidence.slice(1),
      evidence[1]!,
    ]),
  );
  assert.throws(() => validateCompletionEvidence(randomUUID(), '1', evidence));
});
test('public capability cannot accept real accounts', () =>
  assert.equal(accountDeletionCapability().status, 'unavailable'));
