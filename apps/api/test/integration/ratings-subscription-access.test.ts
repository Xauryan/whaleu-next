import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import { ratingDiscussionFixture } from '../support/rating-discussion-fixture.js';
import {
  ratingSubscriptionReceiptSchema,
  ratingSubscriptionStateSchema,
} from '../../src/ratings/subscriptions/contracts.js';
test('target subscriptions: independent baseline, exact desired-state/CAS/minimal recovery and read-only batch', async (t) => {
  const f = await ratingDiscussionFixture();
  t.after(() => f.close());
  const a = await f.actor(),
    b = await f.actor();
  const c = await f.catalog(a, { count: 2 }),
    target = c.targets[0]!,
    second = c.targets[1]!;
  const path = `/v1/ratings/targets/${target.id}/subscription`;
  const get = () => f.auth(request(f.http).get(path), a);
  const known = async () => {
    const r = await get();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const s = ratingSubscriptionStateSchema.parse(r.body);
    assert.equal(s.status, 'known');
    if (s.status !== 'known')
      throw Error('native subscription baseline required');
    return s;
  };
  const initial = await known();
  assert.equal(initial.subscribed, false);
  assert.equal(initial.count, 0);
  const body = {
    clientRequestId: randomUUID(),
    regionId: null,
    expectedTargetRevision: target.revision,
    expectedSubscriptionRevision: initial.revision,
    subscribed: true,
  };
  const send = (input: Record<string, unknown>) =>
    f.auth(request(f.http).put(path), a).send(input);
  const applied = await send(body);
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  const receipt = ratingSubscriptionReceiptSchema.parse(applied.body);
  assert.equal(receipt.outcome, 'applied');
  assert.deepEqual((await send(body)).body, receipt);
  const state = await known();
  assert.equal(state.subscribed, true);
  assert.equal(state.count, 1);
  assert.deepEqual(
    (
      await f.auth(
        request(f.http).get(
          `/v1/ratings/subscription-requests/${body.clientRequestId}`,
        ),
        a,
      )
    ).body,
    receipt,
  );
  assert.equal(
    (
      await f.auth(
        request(f.http).get(
          `/v1/ratings/subscription-requests/${body.clientRequestId}`,
        ),
        b,
      )
    ).status,
    404,
  );
  const noop = await send({
    ...body,
    clientRequestId: randomUUID(),
    expectedSubscriptionRevision: state.revision,
  });
  assert.equal(noop.body.outcome, 'noop');
  assert.equal(noop.body.occurredAt, applied.body.occurredAt);
  const stale = await send({
    ...body,
    clientRequestId: randomUUID(),
    subscribed: false,
  });
  assert.equal(stale.body.code, 'RATING_REVISION_CONFLICT');
  const off = await send({
    ...body,
    clientRequestId: randomUUID(),
    expectedSubscriptionRevision: state.revision,
    subscribed: false,
  });
  assert.equal(off.body.outcome, 'applied');
  assert.equal((await known()).count, 0);
  assert.deepEqual((await send(body)).body, receipt);
  assert.equal((await known()).subscribed, false);
  const batch = await f
    .auth(request(f.http).post('/v1/ratings/subscription-states/query'), a)
    .send({
      regionId: null,
      targets: [
        { targetId: second.id, expectedTargetRevision: second.revision },
        { targetId: target.id, expectedTargetRevision: randomUUID() },
      ],
    });
  assert.equal(batch.status, 200, JSON.stringify(batch.body));
  assert.deepEqual(
    batch.body.items.map((i: { targetId: string }) => i.targetId),
    [second.id, target.id],
  );
  assert.equal(batch.body.items[0].state.status, 'known');
  assert.deepEqual(batch.body.items[1].state, { status: 'unavailable' });
  for (const extra of [
    { actorAccountId: a.accountId },
    { targetId: target.id },
    { count: 100 },
    { authorMode: 'anonymous' },
  ])
    assert.equal(
      (await send({ ...body, ...extra, clientRequestId: randomUUID() })).status,
      400,
    );
  assert.equal(
    (
      await f
        .auth(request(f.http).post('/v1/ratings/subscription-states/query'), a)
        .send({
          regionId: null,
          targets: [
            { targetId: target.id, expectedTargetRevision: target.revision },
            { targetId: target.id, expectedTargetRevision: target.revision },
          ],
        })
    ).status,
    400,
  );
  const rows = (
    await f.pool.query(
      'SELECT delta FROM whaleu_ratings.subscription_transitions ORDER BY target_order',
    )
  ).rows;
  assert.deepEqual(
    rows.map((r) => r.delta),
    [1, -1],
  );
  assert.equal(
    (await f.pool.query('SELECT 1 FROM whaleu_ratings.subscription_epochs'))
      .rowCount,
    1,
  );
  assert.equal(
    (
      await f.pool.query(
        'SELECT 1 FROM whaleu_ratings.subscription_epoch_closures',
      )
    ).rowCount,
    1,
  );
});
