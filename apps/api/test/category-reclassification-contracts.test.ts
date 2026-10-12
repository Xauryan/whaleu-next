import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  reclassificationCategorySchema,
  reclassificationCommandSchema,
  reclassificationReceiptSchema,
  reclassificationRecoverySchema,
} from '../src/community/category-reclassification/contracts.js';

const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const postId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const command = {
  clientRequestId: requestId,
  postId,
  expectedRevision: 0,
  targetCategory: 'scenery',
};

test('only nine candidate categories, with no acceptance implied by parsing', () => {
  assert.equal(reclassificationCategorySchema.options.length, 9);
  for (const targetCategory of reclassificationCategorySchema.options)
    assert.ok(
      reclassificationCommandSchema.safeParse({ ...command, targetCategory })
        .success,
    );
  for (const targetCategory of [
    'feedback',
    'trading',
    'carpool',
    'rental',
    5,
    6,
    9,
    71,
    72,
  ])
    assert.equal(
      reclassificationCommandSchema.safeParse({ ...command, targetCategory })
        .success,
      false,
    );
});

test('indexed profile membership requires every supported move to remain non-trading', () => {
  const expected = [
    'discussion',
    'confession',
    'companions',
    'pets',
    'internships',
    'scenery',
    'dorms',
    'research',
    'deep_sea',
  ];
  assert.deepEqual([...reclassificationCategorySchema.options], expected);
  // Both indexed profile scans use immutable category for posts/trade membership.
  for (const original of expected)
    for (const target of expected)
      assert.equal(original === 'trading', target === 'trading');
});

test('strict command rejects authority, scope, policy and original-category injection', () => {
  for (const key of [
    'actorId',
    'regionId',
    'spaceId',
    'grantId',
    'policyId',
    'originalCategory',
    'currentCategory',
  ])
    assert.equal(
      reclassificationCommandSchema.safeParse({ ...command, [key]: postId })
        .success,
      false,
    );
  for (const expectedRevision of [-1, 0.5, 2147483647, Number.NaN])
    assert.equal(
      reclassificationCommandSchema.safeParse({ ...command, expectedRevision })
        .success,
      false,
    );
  assert.ok(
    reclassificationCommandSchema.safeParse({
      ...command,
      expectedRevision: 2147483646,
    }).success,
  );
  assert.equal(
    reclassificationCommandSchema.safeParse({
      ...command,
      clientRequestId: 'unknown',
    }).success,
    false,
  );
  assert.equal(
    reclassificationCommandSchema.safeParse({ ...command, postId: 'unknown' })
      .success,
    false,
  );
});

test('receipts separate a recorded no-op from a newly applied event and contain no content', () => {
  const base = {
    requestId,
    postId,
    expectedRevision: 0,
    targetCategory: 'scenery',
    recordedAt: '2026-10-12T12:00:00.000Z',
  };
  const unchanged = {
    ...base,
    outcome: 'unchanged',
    revision: 0,
    eventId: null,
  };
  assert.ok(reclassificationReceiptSchema.safeParse(unchanged).success);
  assert.equal(
    reclassificationReceiptSchema.safeParse({
      ...unchanged,
      outcome: 'applied',
    }).success,
    false,
  );
  assert.ok(
    reclassificationReceiptSchema.safeParse({
      ...base,
      outcome: 'applied',
      revision: 1,
      eventId: requestId,
    }).success,
  );
  for (const key of ['text', 'authorId', 'anonymousAuthorId', 'canRead'])
    assert.equal(
      reclassificationReceiptSchema.safeParse({ ...unchanged, [key]: postId })
        .success,
      false,
    );
  assert.ok(
    reclassificationRecoverySchema.safeParse({ state: 'not_recorded' }).success,
  );
  assert.equal(
    reclassificationRecoverySchema.safeParse({
      state: 'not_recorded',
      canReplaceKey: true,
    }).success,
    false,
  );
});

test('receipt cannot invent an event at revision zero or hide an existing overlay', () => {
  const base = {
    requestId,
    postId,
    expectedRevision: 2,
    targetCategory: 'pets',
    recordedAt: '2026-10-12T12:00:00.000Z',
  };
  assert.equal(
    reclassificationReceiptSchema.safeParse({
      ...base,
      outcome: 'applied',
      revision: 4,
      eventId: requestId,
    }).success,
    false,
  );
  assert.equal(
    reclassificationReceiptSchema.safeParse({
      ...base,
      outcome: 'unchanged',
      revision: 2,
      eventId: null,
    }).success,
    false,
  );
  assert.ok(
    reclassificationReceiptSchema.safeParse({
      ...base,
      outcome: 'unchanged',
      revision: 2,
      eventId: requestId,
    }).success,
  );
  assert.equal(
    reclassificationReceiptSchema.safeParse({
      ...base,
      expectedRevision: 0,
      outcome: 'unchanged',
      revision: 0,
      eventId: requestId,
    }).success,
    false,
  );
});
