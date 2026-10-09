import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  setRatingScoreSchema,
  createRatingCommentSchema,
  ratingSummarySchema,
  ratingCommentSchema,
  ratingReceiptSchema,
  ratingText,
  ratingCommentPageSchema,
} from '../src/ratings/contracts.js';
const id = randomUUID(),
  score = {
    clientRequestId: randomUUID(),
    regionId: null,
    expectedTargetRevision: randomUUID(),
    expectedRevision: null,
    score: 1,
  };
test('ratings scores are independent strict integers with CAS revisions', () => {
  for (const value of [1, 2, 3, 4, 5])
    assert.equal(
      setRatingScoreSchema.parse({ ...score, score: value }).score,
      value,
    );
  for (const value of [0, 6, -1, 1.5, '1', NaN, Infinity, null])
    assert.equal(
      setRatingScoreSchema.safeParse({ ...score, score: value }).success,
      false,
    );
  for (const extra of [{ body: 'not combined' }, { accountId: id }])
    assert.equal(
      setRatingScoreSchema.safeParse({ ...score, ...extra }).success,
      false,
    );
});
test('rating text normalization preserves Unicode and validates code points', () => {
  assert.equal(ratingText(500).parse(' \r\n你好\r\n🙂\t '), '你好\n🙂');
  for (const s of ['中'.repeat(500), '🙂'.repeat(500), 'a\tb\nc'])
    assert.ok(ratingText(500).safeParse(s).success);
  for (const s of [
    '',
    ' \r\n ',
    '🙂'.repeat(501),
    'a\rb',
    'a\u007fb',
    'a\u0085b',
    'a\u0000b',
    'a\ud800b',
  ])
    assert.equal(ratingText(500).safeParse(s).success, false);
  const command = {
    clientRequestId: randomUUID(),
    regionId: null,
    expectedTargetRevision: id,
    authorMode: 'named',
    body: '内容',
    assetIds: [],
  };
  assert.ok(createRatingCommentSchema.safeParse(command).success);
  assert.equal(
    createRatingCommentSchema.safeParse({ ...command, score: 5 }).success,
    false,
  );
  assert.equal(
    createRatingCommentSchema.safeParse({ ...command, assetIds: [id] }).success,
    false,
  );
});
test('known summary proves exact buckets and unknown cannot become zero', () => {
  const zero = {
    status: 'known',
    count: 0,
    sum: 0,
    average: null,
    distribution: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
    revision: id,
  };
  assert.ok(ratingSummarySchema.safeParse(zero).success);
  assert.ok(ratingSummarySchema.safeParse({ status: 'unavailable' }).success);
  for (const bad of [
    { ...zero, count: 1 },
    { ...zero, average: 0 },
    { status: 'unavailable', count: 0 },
  ])
    assert.equal(ratingSummarySchema.safeParse(bad).success, false);
});
test('anonymous author and every page are target-bound without real identity', () => {
  const c = {
    id: randomUUID(),
    targetId: id,
    body: '文字',
    revision: randomUUID(),
    createdAt: '2026-10-08T00:00:00.123456Z',
    author: {
      mode: 'anonymous',
      targetId: id,
      personaId: randomUUID(),
      displayName: '分身',
    },
    isMine: false,
    allowedActions: { delete: false },
  };
  assert.ok(ratingCommentSchema.safeParse(c).success);
  for (const bad of [
    { ...c, author: { ...c.author, accountId: id } },
    { ...c, author: { ...c.author, targetId: randomUUID() } },
    { ...c, allowedActions: { delete: true } },
    { ...c, createdAt: '2026-10-08T00:00:00.1234567Z' },
  ])
    assert.equal(ratingCommentSchema.safeParse(bad).success, false);
  assert.equal(
    ratingCommentPageSchema.safeParse({
      context: {
        regionId: null,
        catalogRevision: randomUUID(),
        targetId: randomUUID(),
      },
      items: [c],
      nextCursor: null,
      continuation: 'end',
    }).success,
    false,
  );
});
test('minimal receipt never replays text and create has no noop', () => {
  const r = {
    requestId: randomUUID(),
    operation: 'set_score',
    outcome: 'noop',
    targetId: id,
    subjectId: id,
    revision: randomUUID(),
    occurredAt: '2026-10-08T00:00:00.123456Z',
  };
  assert.ok(ratingReceiptSchema.safeParse(r).success);
  for (const bad of [
    { ...r, subjectId: randomUUID() },
    { ...r, body: 'hidden' },
    { ...r, operation: 'create_comment' },
  ])
    assert.equal(ratingReceiptSchema.safeParse(bad).success, false);
});
