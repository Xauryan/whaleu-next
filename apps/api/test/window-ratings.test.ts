import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  windowSetScoreSchema,
  windowQuerySchema,
  windowOwnSchema,
  windowSummarySchema,
  windowReceiptSchema,
} from '../src/ratings/windows/contracts.js';
import { windowIntentHash } from '../src/ratings/windows/service.js';
const command = {
  clientRequestId: randomUUID(),
  expectedCatalogRevision: randomUUID(),
  expectedWindowRevision: randomUUID(),
  expectedOwnScoreRevision: null,
  score: 0,
};
test('all 21 signed integers including zero, strict number only and explicit nullable own CAS revision', () => {
  for (let score = -10; score <= 10; score++)
    assert.equal(
      windowSetScoreSchema.parse({ ...command, score }).score,
      score,
    );
  for (const score of [
    -11,
    11,
    -0.5,
    0.5,
    NaN,
    Infinity,
    -Infinity,
    '0',
    null,
    undefined,
    true,
    {},
    [],
  ])
    assert.equal(
      windowSetScoreSchema.safeParse({ ...command, score }).success,
      false,
      String(score),
    );
  for (const patch of [
    { user_id: randomUUID() },
    { expectedOwnScoreRevision: undefined },
    { expectedOwnScoreRevision: 0 },
    { expectedOwnScoreRevision: 'null' },
  ])
    assert.equal(
      windowSetScoreSchema.safeParse({ ...command, ...patch }).success,
      false,
    );
});
test('distinct recorded zero, known-empty and unknown window score population', () => {
  assert.ok(
    windowOwnSchema.safeParse({
      kind: 'recorded',
      score: 0,
      revision: randomUUID(),
      recordedAt: new Date().toISOString(),
    }).success,
  );
  for (const state of [{ kind: 'not_submitted' }, { kind: 'unavailable' }])
    assert.ok(windowOwnSchema.safeParse(state).success);
  for (const state of [
    { kind: 'known', ratingCount: 1, mean: 0 },
    { kind: 'known', ratingCount: 0, mean: null },
    { kind: 'unavailable' },
  ])
    assert.ok(windowSummarySchema.safeParse(state).success);
  for (const state of [
    { kind: 'known', ratingCount: 0, mean: 0 },
    { kind: 'known', ratingCount: 1, mean: null },
    { kind: 'unavailable', mean: 0 },
  ])
    assert.equal(windowSummarySchema.safeParse(state).success, false);
});
test('canteen filters canonicalize while zero/negative minimum remain represented without generic rating conversion', () => {
  const id = randomUUID();
  assert.deepEqual(
    windowQuerySchema.parse({ canteenIds: id + ',' + id }).canteenIds,
    [id],
  );
  for (const minRating of ['-10', '0', '0.1', '10'])
    assert.ok(windowQuerySchema.safeParse({ minRating }).success);
  for (const q of [
    { minRating: '11' },
    { minRating: 'NaN' },
    { canteenIds: '' },
    { limit: '51' },
    { sort: 'time' },
    { schoolId: '1' },
  ])
    assert.equal(windowQuerySchema.safeParse(q).success, false);
});
test('own revision and zero sign payload participate in original intent; typed noop and cancel receipts', () => {
  const actor = randomUUID(),
    id = randomUUID(),
    hash = windowIntentHash(actor, id, command);
  for (const q of [
    { ...command, score: 1 },
    { ...command, expectedOwnScoreRevision: randomUUID() },
    { ...command, clientRequestId: randomUUID() },
  ])
    assert.notEqual(windowIntentHash(actor, id, q), hash);
  assert.notEqual(windowIntentHash(randomUUID(), id, command), hash);
  assert.ok(
    windowReceiptSchema.safeParse({
      requestId: command.clientRequestId,
      operation: 'window.score.set.v1',
      windowId: id,
      outcome: 'noop',
      score: 0,
      scoreRevision: randomUUID(),
      recordedAt: new Date().toISOString(),
    }).success,
  );
  assert.ok(
    windowReceiptSchema.safeParse({
      requestId: command.clientRequestId,
      operation: 'window.score.set.v1',
      windowId: id,
      outcome: 'rejected',
      code: 'WINDOW_SCORE_CANCELLED',
    }).success,
  );
});
