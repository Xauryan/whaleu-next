import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeWindowCatalog,
  decodeWindowDetail,
  decodeWindowOwnScore,
  decodeWindowPage,
  decodeWindowQuery,
  decodeWindowReceipt,
  decodeWindowSetScore,
  decodeWindowSummary,
  matchWindowReceipt,
  windowScoreChoices,
} from '../src/window-ratings/contract';
import {
  cancelled,
  canteenId,
  catalog,
  command,
  detail,
  floorId,
  id,
  otherId,
  page,
  receipt,
  scoreRevision,
  window,
} from './window-ratings-helpers';
test('all 21 signed integers including zero are valid; fractions, coercion and generic rating payloads fail', () => {
  assert.deepEqual(
    windowScoreChoices,
    Array.from({ length: 21 }, (_, i) => i - 10),
  );
  for (const score of windowScoreChoices)
    assert.equal(decodeWindowSetScore(command({ score })).score, score);
  for (const score of [-11, 11, -0.5, 0.5, NaN, Infinity, '0', null])
    assert.throws(() => decodeWindowSetScore({ ...command(), score }));
  assert.throws(() => decodeWindowSetScore({ ...command(), gradeScore: 1 }));
  assert.throws(() =>
    decodeWindowSetScore({ ...command(), expectedOwnScoreRevision: undefined }),
  );
});
test('unavailable, no score, actual zero and empty aggregate remain distinct', () => {
  assert.deepEqual(decodeWindowOwnScore({ kind: 'unavailable' }), {
    kind: 'unavailable',
  });
  assert.deepEqual(decodeWindowOwnScore({ kind: 'not_submitted' }), {
    kind: 'not_submitted',
  });
  assert.deepEqual(
    decodeWindowSummary({ kind: 'known', ratingCount: 1, mean: 0 }),
    { kind: 'known', ratingCount: 1, mean: 0 },
  );
  for (const raw of [
    { kind: 'known', ratingCount: 0, mean: 0 },
    { kind: 'known', ratingCount: 1, mean: null },
    { kind: 'unavailable', ratingCount: 0 },
  ])
    assert.throws(() => decodeWindowSummary(raw));
});
test('source canteen and raw floor mappings survive strict decoding without inventing floor numbers', () => {
  assert.deepEqual(decodeWindowCatalog(catalog()), catalog());
  assert.equal(
    decodeWindowCatalog(catalog()).canteens[0]!.floors[0]!.sourceFloorKey,
    'B1-mezzanine',
  );
  assert.deepEqual(
    decodeWindowQuery({
      canteenIds: [canteenId, canteenId],
      floorId,
      minRating: 0,
    }),
    { canteenIds: [canteenId], floorId, minRating: 0 },
  );
  for (const raw of [
    { floor: 1 },
    { canteenIds: [] },
    { canteenIds: [1] },
    { floorId: '1' },
    { minRating: 1.00001 },
    { campusId: id },
  ])
    assert.throws(() => decodeWindowQuery(raw));
  assert.throws(() =>
    decodeWindowCatalog({
      ...catalog(),
      canteens: [...catalog().canteens, ...catalog().canteens],
    }),
  );
});
test('catalog/detail snapshots reject unknown fields, duplicate ids and malformed continuation', () => {
  assert.deepEqual(decodeWindowDetail(detail()), detail());
  assert.deepEqual(decodeWindowPage(page()), page());
  for (const raw of [
    page({ items: [window(), window()] }),
    page({ scoreRevision: '0' }),
    page({ nextCursor: 'next' }),
    { ...page(), privateActor: id },
  ])
    assert.throws(() => decodeWindowPage(raw));
  assert.throws(() => decodeWindowDetail({ ...detail(), accountId: id }));
});
test('applied/noop and typed rejection match only the original operation target request and score', () => {
  for (const result of [receipt(), cancelled()])
    matchWindowReceipt(id, command(), decodeWindowReceipt(result));
  for (const result of [
    receipt(command({ score: 0 })),
    receipt(command(), otherId),
    { ...receipt(), requestId: otherId },
  ])
    assert.throws(() =>
      matchWindowReceipt(id, command(), decodeWindowReceipt(result)),
    );
  for (const result of [
    { ...receipt(), operation: 'rating.first-score.v1' },
    { ...receipt(), scoreRevision: 'bad' },
    { ...cancelled(), code: 'REQUEST_NOT_FOUND' },
  ])
    assert.throws(() => decodeWindowReceipt(result));
});

test('aggregate means preserve negative one-decimal values without client rerounding', () => {
  assert.deepEqual(
    decodeWindowSummary({ kind: 'known', ratingCount: 2, mean: -0.3 }),
    { kind: 'known', ratingCount: 2, mean: -0.3 },
  );
  assert.throws(() =>
    decodeWindowSummary({ kind: 'known', ratingCount: 2, mean: -0.25 }),
  );
});

test('noop preserves its exact existing revision and applied must create a distinct revision', () => {
  const prior = command({ expectedOwnScoreRevision: scoreRevision });
  const noop = decodeWindowReceipt({ ...receipt(), outcome: 'noop' });
  matchWindowReceipt(id, prior, noop);
  assert.throws(() => matchWindowReceipt(id, command(), noop));
  assert.throws(() =>
    matchWindowReceipt(
      id,
      command({ expectedOwnScoreRevision: otherId }),
      noop,
    ),
  );
  assert.throws(() =>
    matchWindowReceipt(id, prior, decodeWindowReceipt(receipt())),
  );
  matchWindowReceipt(id, prior, decodeWindowReceipt(receipt(prior)));
});
