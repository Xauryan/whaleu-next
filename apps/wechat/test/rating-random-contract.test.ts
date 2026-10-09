import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeRatingRandomQuery,
  decodeRatingRandomResult,
  decodeRatingRandomRoute,
  matchRatingRandomResult,
} from '../src/ratings/random-contract';
import {
  categoryId,
  emptySummary,
  otherId,
  regionId,
  revision,
  summary,
  target,
} from './ratings-helpers';
import { randomResult } from './rating-random-helpers';

test('random query and route are exact; optional omission is global, never null, inferred region or identity', () => {
  assert.deepEqual(decodeRatingRandomQuery({ categoryId }), { categoryId });
  for (const minimumAverage of [1, 1.1, 2.3, 4.9, 5])
    assert.deepEqual(
      decodeRatingRandomQuery({
        categoryId,
        campusId: otherId,
        minimumAverage,
      }),
      { categoryId, campusId: otherId, minimumAverage },
    );
  for (const query of [
    {},
    null,
    [],
    { categoryId: 'bad' },
    { categoryId, campusId: null },
    { categoryId, campusId: undefined },
    { categoryId, regionId },
    { categoryId, accountId: otherId },
    { categoryId, limit: 20 },
    ...[0, 0.9, 5.1, 4.11, NaN, Infinity, '4', null, undefined].map(
      (minimumAverage) => ({ categoryId, minimumAverage }),
    ),
  ])
    assert.throws(() => decodeRatingRandomQuery(query));
  assert.deepEqual(decodeRatingRandomRoute({ categoryId }), { categoryId });
  for (const route of [
    {},
    { categoryId, regionId },
    { categoryId, campusId: otherId },
    { categoryId, minimumAverage: '3' },
  ])
    assert.throws(() => decodeRatingRandomRoute(route));
});

test('strict random envelope accepts known zero and unknown only without threshold; preserves descendant categories', () => {
  for (const score of [
    emptySummary(),
    { status: 'unavailable' } as const,
    summary(4),
  ]) {
    const result = decodeRatingRandomResult(
      randomResult(undefined, {
        item: {
          regionId: null,
          target: target({
            categoryId: otherId,
            allowedActions: {
              ...target().allowedActions,
              setScore: score.status === 'known',
            },
          }),
          summary: score,
        },
      }),
    );
    assert.deepEqual(result.item?.summary, score);
    assert.equal(result.item?.target.categoryId, otherId);
    assert.ok(Object.isFrozen(result));
    assert.ok(Object.isFrozen(result.context));
    assert.ok(Object.isFrozen(result.item));
  }
  assert.equal(
    decodeRatingRandomResult(
      randomResult(undefined, { candidateCount: 0, item: null }),
    ).item,
    null,
  );
});

test('random exact result rejects private extras, unsafe sizes, inconsistent nullability and noncanonical target/summary', () => {
  const base = randomResult();
  for (const value of [
    { ...base, cursor: 'secret' },
    { ...base, context: { ...base.context, regionId } },
    { ...base, context: { ...base.context, campusId: undefined } },
    { ...base, context: { ...base.context, minimumAverage: 3.45 } },
    ...[-1, 0, Number.MAX_SAFE_INTEGER + 1, 0.5, NaN, '1'].map(
      (candidateCount) => ({ ...base, candidateCount }),
    ),
    { ...base, item: null },
    { ...base, item: { ...base.item, regionId } },
    { ...base, item: { ...base.item, privateAccountId: otherId } },
    {
      ...base,
      item: { ...base.item, target: { ...target(), privateId: otherId } },
    },
    { ...base, item: { ...base.item, summary: { ...summary(), average: 0 } } },
    { ...base, item: { ...base.item, summary: { status: 'unavailable' } } },
    {
      ...base,
      item: {
        ...base.item,
        target: target({
          allowedActions: { ...target().allowedActions, setScore: false },
        }),
      },
    },
  ])
    assert.throws(() => decodeRatingRandomResult(value));
  for (const candidateCount of [128, 1001, 2048, Number.MAX_SAFE_INTEGER])
    assert.equal(
      decodeRatingRandomResult({ ...base, candidateCount }).candidateCount,
      candidateCount,
    );
});

test('threshold verifies raw weighted score, not rounded presentation; unknown and zero fail closed', () => {
  const raw = {
    status: 'known' as const,
    count: 21,
    sum: 83,
    average: 4,
    distribution: { '1': 0, '2': 0, '3': 1, '4': 20, '5': 0 },
    revision,
  };
  const result = randomResult(
    { categoryId, campusId: otherId, minimumAverage: 4 },
    { item: { regionId, target: target(), summary: raw } },
  );
  for (const score of [
    raw,
    emptySummary(),
    { status: 'unavailable' } as const,
    summary(3),
  ])
    assert.throws(() =>
      decodeRatingRandomResult({
        ...result,
        item: { ...result.item, summary: score },
      }),
    );
  assert.equal(
    decodeRatingRandomResult(
      randomResult(
        { categoryId, campusId: otherId, minimumAverage: 3.9 },
        { item: result.item },
      ),
    ).item?.regionId,
    regionId,
  );
  assert.equal(
    decodeRatingRandomResult(randomResult({ categoryId, minimumAverage: 5 }))
      .candidateCount,
    100,
  );
});

test('response context is tied to all request coordinates including omitted campus and threshold', () => {
  const query = { categoryId, campusId: otherId, minimumAverage: 4.2 };
  assert.doesNotThrow(() =>
    matchRatingRandomResult(query, randomResult(query)),
  );
  for (const context of [
    { ...randomResult(query).context, categoryId: otherId },
    { ...randomResult(query).context, campusId: null },
    { ...randomResult(query).context, campusId: regionId },
    { ...randomResult(query).context, minimumAverage: null },
    { ...randomResult(query).context, minimumAverage: 4.3 },
  ])
    assert.throws(() =>
      matchRatingRandomResult(query, randomResult(query, { context })),
    );
});
