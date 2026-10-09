import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as c from '../src/ratings/subscriptions/contracts.js';
import { ratingTargetSchema } from '../src/ratings/contracts.js';
const id = randomUUID();
const state = {
  status: 'known',
  targetId: id,
  subscribed: false,
  count: 0,
  revision: randomUUID(),
  allowedActions: { setSubscription: true },
};
const command = {
  clientRequestId: randomUUID(),
  regionId: null,
  expectedTargetRevision: randomUUID(),
  expectedSubscriptionRevision: state.revision,
  subscribed: true,
};
test('subscription desired state has target-only exact input and independent CAS', () => {
  assert.ok(c.setRatingSubscriptionSchema.safeParse(command).success);
  for (const [key, value] of Object.entries({
    targetId: id,
    rootId: id,
    authorMode: 'anonymous',
    count: 1,
    actorAccountId: id,
    points: 1,
    expectedLikeRevision: id,
  })) {
    assert.equal(
      c.setRatingSubscriptionSchema.safeParse({ ...command, [key]: value })
        .success,
      false,
    );
  }
  assert.equal(
    c.setRatingSubscriptionSchema.safeParse({
      ...command,
      subscribed: undefined,
    }).success,
    false,
  );
});
test('known zero and unavailable are disjoint strict schemas', () => {
  assert.ok(c.ratingSubscriptionStateSchema.safeParse(state).success);
  assert.ok(
    c.ratingSubscriptionStateSchema.safeParse({ status: 'unavailable' })
      .success,
  );
  for (const value of [
    { status: 'unavailable', count: 0 },
    { status: 'unavailable', subscribed: false },
    { ...state, count: -1 },
    { ...state, revision: null },
    { ...state, allowedActions: { setSubscription: false } },
    { ...state, actorAccountId: id },
  ])
    assert.equal(
      c.ratingSubscriptionStateSchema.safeParse(value).success,
      false,
    );
});
test('single-scope card query requires one to twenty distinct target revisions', () => {
  const items = Array.from({ length: 20 }, () => ({
    targetId: randomUUID(),
    expectedTargetRevision: randomUUID(),
  }));
  assert.ok(
    c.ratingSubscriptionQuerySchema.safeParse({
      regionId: null,
      targets: items,
    }).success,
  );
  for (const targets of [
    [],
    [...items, items[0]!],
    [items[0]!, items[0]!],
    [{ targetId: id }],
  ])
    assert.equal(
      c.ratingSubscriptionQuerySchema.safeParse({ regionId: null, targets })
        .success,
      false,
    );
  assert.equal(
    c.ratingSubscriptionQuerySchema.safeParse({
      regionId: null,
      targets: [{ ...items[0], regionId: randomUUID() }],
    }).success,
    false,
  );
});
test('batch response cannot cross target ids or duplicate items', () => {
  assert.ok(
    c.ratingSubscriptionQueryResponseSchema.safeParse({
      items: [{ targetId: id, state }],
    }).success,
  );
  assert.equal(
    c.ratingSubscriptionQueryResponseSchema.safeParse({
      items: [{ targetId: randomUUID(), state }],
    }).success,
    false,
  );
  assert.equal(
    c.ratingSubscriptionQueryResponseSchema.safeParse({
      items: [
        { targetId: id, state },
        { targetId: id, state: { status: 'unavailable' } },
      ],
    }).success,
    false,
  );
});
test('minimal subscription receipt never carries current count author or content', () => {
  const value = {
    requestId: command.clientRequestId,
    operation: 'set_target_subscription',
    outcome: 'applied',
    targetId: id,
    subscribed: true,
    revision: randomUUID(),
    occurredAt: '2026-10-09T00:00:00.123456Z',
  };
  assert.ok(c.ratingSubscriptionReceiptSchema.safeParse(value).success);
  assert.ok(
    c.ratingSubscriptionReceiptSchema.safeParse({ ...value, outcome: 'noop' })
      .success,
  );
  for (const extra of [
    { count: 1 },
    { actorAccountId: id },
    { body: 'private' },
    { rootId: id },
    { epochId: id },
    { occurredAt: '2026-10-09T00:00:00.1234567Z' },
    { operation: 'set_comment_like' },
  ])
    assert.equal(
      c.ratingSubscriptionReceiptSchema.safeParse({ ...value, ...extra })
        .success,
      false,
    );
});
test('rejected subscription receipt keeps only request operation outcome and code', () => {
  const value = {
    requestId: id,
    operation: 'set_target_subscription',
    outcome: 'rejected',
    code: 'RATING_REVISION_CONFLICT',
  };
  assert.ok(c.ratingSubscriptionReceiptSchema.safeParse(value).success);
  assert.equal(
    c.ratingSubscriptionReceiptSchema.safeParse({ ...value, subscribed: false })
      .success,
    false,
  );
  assert.equal(
    c.ratingSubscriptionReceiptSchema.safeParse({
      ...value,
      code: 'RATING_UNAVAILABLE',
    }).success,
    false,
  );
});
test('subscription state is not a widening or alias of target DTO', () => {
  assert.equal(ratingTargetSchema.safeParse(state).success, false);
});
