import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  dishNameSchema,
  dishCommandSchema,
  dishReceiptSchema,
  dishOwnSchema,
} from '../src/ratings/windows/dishes/contracts.js';
import {
  dishIdentity,
  dishReviewDigest,
} from '../src/community/content-review/dish-review.facade.js';
import { dishIntentHash } from '../src/ratings/windows/dishes/service.js';
test('dish names preserve codepoints/bytes rather than normalizing identity or using UTF16 length', () => {
  const accepted = [
    '0',
    ' x',
    'x ',
    'é',
    'e\u0301',
    'A',
    'a',
    'Ａ',
    '🍱'.repeat(10),
    '菜'.repeat(10),
  ];
  for (const value of accepted)
    assert.equal(dishNameSchema.parse(value), value);
  assert.equal(new Set(accepted.map(dishIdentity)).size, accepted.length);
  for (const value of [
    '',
    ' ',
    '\ufeff',
    '\u3000',
    '\u0000',
    '\u0001x',
    '\u007f',
    '\u0080',
    '\ud800',
    '\udc00',
    '🍱'.repeat(11),
    '菜'.repeat(11),
    undefined,
    null,
    1,
    {},
    [],
  ])
    assert.equal(dishNameSchema.safeParse(value).success, false);
});
test('dish command intent separates actor, target, operation, CAS, source and exact name', () => {
  const actor = randomUUID(),
    window = randomUUID(),
    q = {
      clientRequestId: randomUUID(),
      expectedCatalogRevision: randomUUID(),
      expectedWindowRevision: randomUUID(),
      expectedMembershipRevision: null,
      dishName: ' Rice ',
    };
  assert.deepEqual(dishCommandSchema.parse(q), q);
  const hash = dishIntentHash(actor, window, 'window.dish.recommend.v1', q);
  assert.equal(
    hash,
    dishIntentHash(actor, window, 'window.dish.recommend.v1', { ...q }),
  );
  for (const value of [
    dishIntentHash(actor, window, 'window.dish.retract.v1', q),
    dishIntentHash(randomUUID(), window, 'window.dish.recommend.v1', q),
    dishIntentHash(actor, randomUUID(), 'window.dish.recommend.v1', q),
    dishIntentHash(actor, window, 'window.dish.recommend.v1', {
      ...q,
      dishName: 'Rice',
    }),
    dishIntentHash(actor, window, 'window.dish.recommend.v1', {
      ...q,
      expectedMembershipRevision: randomUUID(),
    }),
  ])
    assert.notEqual(value, hash);
  assert.equal(dishCommandSchema.safeParse({ ...q, score: 1 }).success, false);
});
test('dish Review binds exact public-name purpose, source and byte identity', () => {
  const e = {
    version: 1 as const,
    purpose: 'window.dish.recommend.v1' as const,
    actorId: randomUUID(),
    requestId: randomUUID(),
    windowId: randomUUID(),
    catalogRevision: randomUUID(),
    windowRevision: randomUUID(),
    dishName: 'é',
    dishIdentity: dishIdentity('é'),
  };
  const digest = dishReviewDigest(e);
  assert.equal(dishReviewDigest({ ...e }), digest);
  assert.notEqual(dishReviewDigest({ ...e, dishName: 'e\u0301' }), digest);
  assert.notEqual(
    dishReviewDigest({ ...e, dishIdentity: dishIdentity('e\u0301') }),
    digest,
  );
  assert.notEqual(dishReviewDigest({ ...e, requestId: randomUUID() }), digest);
});
test('dish receipts and own projections have no other actor or numeric score fields', () => {
  const receipt = {
    requestId: randomUUID(),
    operation: 'window.dish.recommend.v1',
    windowId: randomUUID(),
    dishIdentity: dishIdentity('Rice'),
    outcome: 'rejected',
    code: 'DISH_CANCELLED',
  };
  assert.ok(dishReceiptSchema.safeParse(receipt).success);
  for (const field of ['actorId', 'dishName', 'score', 'mean', 'author'])
    assert.equal(
      dishReceiptSchema.safeParse({ ...receipt, [field]: 'extra' }).success,
      false,
    );
  assert.deepEqual(dishOwnSchema.parse({ kind: 'unavailable' }), {
    kind: 'unavailable',
  });
  assert.equal(
    dishOwnSchema.safeParse({ kind: 'not_recommended', active: false }).success,
    false,
  );
});
