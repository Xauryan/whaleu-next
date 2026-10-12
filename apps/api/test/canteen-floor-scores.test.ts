import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  floorSetScoreSchema,
  floorSummarySchema,
  floorOwnSchema,
  floorReceiptSchema,
} from '../src/ratings/canteen-floors/contracts.js';
import { floorIntentHash } from '../src/ratings/canteen-floors/service.js';
const command = {
  clientRequestId: randomUUID(),
  expectedCatalogRevision: randomUUID(),
  expectedCanteenRevision: randomUUID(),
  score: 4.75,
};
test('floor scalar is finite JSON number 1–5, preserving arbitrary binary64 fractions without integer or half-step coercion', () => {
  for (const score of [
    1,
    5,
    1.25,
    4.75,
    1.0000000000000002,
    4.999999999999999,
    Math.PI,
    1.2345678901234567,
  ])
    assert.equal(floorSetScoreSchema.parse({ ...command, score }).score, score);
  for (const score of [
    0,
    0.5,
    5.000000000000001,
    6,
    -1,
    NaN,
    Infinity,
    -Infinity,
    '4.75',
    null,
    undefined,
    true,
    {},
    [],
  ])
    assert.equal(
      floorSetScoreSchema.safeParse({ ...command, score }).success,
      false,
      String(score),
    );
  for (const patch of [
    { expectedOwnScoreRevision: null },
    { comment: 'hi' },
    { images: [] },
    { actorId: randomUUID() },
    { floor: 1 },
  ])
    assert.equal(
      floorSetScoreSchema.safeParse({ ...command, ...patch }).success,
      false,
    );
});
test('floor aggregate record counts never imply people; exact known-empty is 0/null, own recorded survives independent unknown history', () => {
  for (const summary of [
    { kind: 'known', ratingCount: 0, mean: null },
    { kind: 'known', ratingCount: 4, mean: 3.3 },
    { kind: 'unavailable' },
  ])
    assert.ok(floorSummarySchema.safeParse(summary).success);
  for (const summary of [
    { kind: 'known', ratingCount: 0, mean: 0 },
    { kind: 'known', ratingCount: 1, mean: null },
    { kind: 'known', ratingCount: 2, mean: -3 },
    { kind: 'unavailable', ratingCount: 0 },
    { kind: 'known', ratingCount: 2, mean: 3.25 },
  ])
    assert.equal(floorSummarySchema.safeParse(summary).success, false);
  assert.ok(
    floorOwnSchema.safeParse({
      kind: 'recorded',
      score: Math.PI,
      revision: randomUUID(),
      recordedAt: new Date().toISOString(),
    }).success,
  );
});
test('floor command hashes bind actor,target,key,revisions and exact decimal; no noop or mutable replacement receipt', () => {
  const actor = randomUUID(),
    floor = randomUUID(),
    hash = floorIntentHash(actor, floor, command);
  for (const c of [
    { ...command, score: 4.750000000000001 },
    { ...command, clientRequestId: randomUUID() },
    { ...command, expectedCanteenRevision: randomUUID() },
  ])
    assert.notEqual(floorIntentHash(actor, floor, c), hash);
  const receipt = {
    requestId: command.clientRequestId,
    operation: 'floor.score.first.v1',
    floorId: floor,
    outcome: 'applied',
    score: 4.75,
    scoreRevision: randomUUID(),
    recordedAt: new Date().toISOString(),
  };
  assert.ok(floorReceiptSchema.safeParse(receipt).success);
  assert.equal(
    floorReceiptSchema.safeParse({ ...receipt, outcome: 'noop' }).success,
    false,
  );
  for (const code of [
    'FLOOR_ALREADY_RATED',
    'FLOOR_REVISION_CONFLICT',
    'FLOOR_SCORE_CANCELLED',
  ])
    assert.ok(
      floorReceiptSchema.safeParse({
        requestId: command.clientRequestId,
        operation: 'floor.score.first.v1',
        floorId: floor,
        outcome: 'rejected',
        code,
      }).success,
    );
});
