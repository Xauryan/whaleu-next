import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  ratingRandomQuerySchema,
  ratingRandomResponseSchema,
} from '../src/ratings/random/contracts.js';
import { matchesRatingMinimum } from '../src/ratings/random/selection.js';
import type { RatingSummary } from '../src/ratings/contracts.js';
import { ApplicationError } from '../src/http/application-error.js';
const known = (scores: number[]): RatingSummary => ({
  status: 'known',
  count: scores.length,
  sum: scores.reduce((a, b) => a + b, 0),
  average: scores.length
    ? Math.round((scores.reduce((a, b) => a + b, 0) * 10) / scores.length) / 10
    : null,
  distribution: {
    '1': scores.filter((s) => s === 1).length,
    '2': scores.filter((s) => s === 2).length,
    '3': scores.filter((s) => s === 3).length,
    '4': scores.filter((s) => s === 4).length,
    '5': scores.filter((s) => s === 5).length,
  },
  revision: randomUUID(),
});
test('random query is strict and distinguishes omitted threshold and explicit native campus', () => {
  const categoryId = randomUUID(),
    campusId = randomUUID();
  assert.deepEqual(ratingRandomQuerySchema.parse({ categoryId }), {
    categoryId,
  });
  assert.deepEqual(
    ratingRandomQuerySchema.parse({
      categoryId,
      campusId,
      minimumAverage: '4.1',
    }),
    { categoryId, campusId, minimumAverage: 4.1 },
  );
  for (const minimumAverage of [
    null,
    '',
    true,
    0,
    5.1,
    ' 4',
    '4e0',
    '04',
    '4.00',
    '4.11',
    'Infinity',
    Infinity,
    NaN,
    4.11,
  ])
    assert.equal(
      ratingRandomQuerySchema.safeParse({ categoryId, minimumAverage }).success,
      false,
      String(minimumAverage),
    );
  for (const extra of [
    { regionId: randomUUID() },
    { limit: 1 },
    { cursor: 'x' },
    { accountId: randomUUID() },
    { campusId: null },
    { repeat: false },
  ])
    assert.equal(
      ratingRandomQuerySchema.safeParse({ categoryId, ...extra }).success,
      false,
    );
});
test('minimum uses exact rational score with inclusive equality, not rounded display', () => {
  const scores = known([4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 5, 5, 5]);
  assert.equal(scores.status === 'known' && scores.average, 4.2);
  assert.equal(matchesRatingMinimum(scores, 4.2), true);
  const below = known([4, 4, 4, 4, 4, 5]);
  assert.equal(below.status === 'known' && below.average, 4.2);
  assert.equal(matchesRatingMinimum(below, 4.2), false);
  assert.equal(matchesRatingMinimum(known([])), true);
  assert.equal(matchesRatingMinimum(known([]), 1), false);
  assert.equal(matchesRatingMinimum({ status: 'unavailable' }), true);
  assert.throws(
    () => matchesRatingMinimum({ status: 'unavailable' }, 1),
    (e: unknown) =>
      e instanceof ApplicationError && e.code === 'RATING_SCORE_UNAVAILABLE',
  );
});
test('random empty response has no partial/cursor or synthetic target', () => {
  const context = {
    campusId: null,
    categoryId: randomUUID(),
    minimumAverage: null,
  };
  assert.deepEqual(
    ratingRandomResponseSchema.parse({
      context,
      candidateCount: 0,
      item: null,
    }),
    { context, candidateCount: 0, item: null },
  );
  assert.equal(
    ratingRandomResponseSchema.safeParse({
      context,
      candidateCount: 1,
      item: null,
    }).success,
    false,
  );
  assert.equal(
    ratingRandomResponseSchema.safeParse({
      context,
      candidateCount: 0,
      item: null,
      nextCursor: 'x',
    }).success,
    false,
  );
});
