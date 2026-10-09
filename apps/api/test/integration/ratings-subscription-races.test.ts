import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ratingSubscriptionUpdatesFixture } from '../support/rating-subscription-updates-fixture.js';
import { RatingSubscriptionsRepository } from '../../src/ratings/subscriptions/repository.js';
function barrier() {
  let reach!: () => void, release!: () => void;
  const reached = new Promise<void>((r) => {
      reach = r;
    }),
    held = new Promise<void>((r) => {
      release = r;
    });
  return { reach, release, reached, held };
}
async function wait(p: Promise<void>) {
  await Promise.race([
    p,
    delay(5000).then(() => {
      throw Error('Expected subscription race barrier');
    }),
  ]);
}
test('subscription epochs: event-time membership and materialization-time same-epoch prevent resurrection', async (t) => {
  const f = await ratingSubscriptionUpdatesFixture();
  t.after(() => f.close());
  const a = await f.actor(),
    r = await f.actor(),
    late = await f.actor(),
    c = await f.catalog(a),
    target = c.targets[0]!;
  await f.subscribe(r, c, target);
  const first = await f.publish(a, c, target),
    e1 = await f.event(a, first.input.clientRequestId);
  await f.subscribe(r, c, target, false);
  await f.subscribe(r, c, target);
  await f.subscribe(late, c, target);
  const old = await f.worker().run({ mode: 'apply', eventIds: [e1] });
  assert.equal(old.suppressed, 1);
  assert.equal(old.materialized, 0);
  assert.equal(old.processed, 1);
  assert.deepEqual(
    (await f.processing(e1)).map((p) => p.code),
    ['epoch_ended'],
  );
  assert.deepEqual(await f.notices(e1), []);
  const second = await f.publish(a, c, target),
    e2 = await f.event(a, second.input.clientRequestId);
  const now = await f.worker().run({ mode: 'apply', eventIds: [e2] });
  assert.equal(now.materialized, 2);
  assert.equal(now.processed, 1);
  await f.subscribe(r, c, target, false);
  assert.equal((await f.get(r)).body.items.length, 1);
  assert.equal((await f.get(r)).body.items[0].status, 'available');
  await f.subscribe(r, c, target);
  assert.equal(
    (await f.worker().run({ mode: 'apply', eventIds: [e1] })).alreadyProcessed,
    1,
  );
  assert.equal((await f.get(r)).body.items.length, 1);
});
test(
  'subscription race: materialization holds target SHARE until notice commit, then unsubscribe retains notice',
  { timeout: 120000 },
  async (t) => {
    const f = await ratingSubscriptionUpdatesFixture();
    t.after(() => f.close());
    const a = await f.actor(),
      r = await f.actor(),
      c = await f.catalog(a),
      target = c.targets[0]!;
    await f.subscribe(r, c, target);
    const root = await f.publish(a, c, target),
      event = await f.event(a, root.input.clientRequestId);
    const b = barrier(),
      original = f.records.owner.bind(f.records);
    let armed = true;
    const hook = t.mock.method(
      f.records,
      'owner',
      async (...args: Parameters<typeof original>) => {
        if (armed && args[0] === r.accountId && args[2]) {
          armed = false;
          b.reach();
          await b.held;
        }
        return original(...args);
      },
    );
    let processing: ReturnType<ReturnType<typeof f.worker>['run']> | undefined,
      ending: ReturnType<typeof f.subscribe> | undefined;
    try {
      processing = f.worker().run({ mode: 'apply', eventIds: [event] });
      await wait(b.reached);
      ending = f.subscribe(r, c, target, false);
      await f.waitForLock('whaleu_ratings.targets');
      b.release();
      const result = await processing;
      assert.equal(result.materialized, 1);
      assert.equal(result.processed, 1);
      await ending;
      assert.equal((await f.notices(event)).length, 1);
    } finally {
      b.release();
      hook.mock.restore();
      await Promise.allSettled(
        [processing, ending].filter((v) => v !== undefined),
      );
    }
    assert.equal((await f.get(r)).body.items[0].status, 'available');
  },
);
test(
  'subscription race: unsubscribe commit before worker target lock suppresses pending old epoch',
  { timeout: 120000 },
  async (t) => {
    const f = await ratingSubscriptionUpdatesFixture();
    t.after(() => f.close());
    const a = await f.actor(),
      r = await f.actor(),
      c = await f.catalog(a),
      target = c.targets[0]!;
    await f.subscribe(r, c, target);
    const root = await f.publish(a, c, target),
      event = await f.event(a, root.input.clientRequestId);
    const repo = f.app.get(RatingSubscriptionsRepository),
      original = repo.set.bind(repo),
      b = barrier();
    let armed = true;
    const hook = t.mock.method(
      repo,
      'set',
      async (...args: Parameters<typeof original>) => {
        const result = await original(...args);
        if (armed && args[1] === r.accountId && !args[4]) {
          armed = false;
          b.reach();
          await b.held;
        }
        return result;
      },
    );
    let ending: ReturnType<typeof f.subscribe> | undefined,
      processing: ReturnType<ReturnType<typeof f.worker>['run']> | undefined;
    try {
      ending = f.subscribe(r, c, target, false);
      await wait(b.reached);
      processing = f.worker().run({ mode: 'apply', eventIds: [event] });
      await f.waitForLock('whaleu_ratings.targets');
      b.release();
      await ending;
      const result = await processing;
      assert.equal(result.materialized, 0);
      assert.equal(result.suppressed, 1);
      assert.equal(result.processed, 1);
      assert.deepEqual(await f.notices(event), []);
    } finally {
      b.release();
      hook.mock.restore();
      await Promise.allSettled(
        [processing, ending].filter((v) => v !== undefined),
      );
    }
  },
);
test('subscription race: two real workers share durable page and recipient uniqueness', async (t) => {
  const f = await ratingSubscriptionUpdatesFixture();
  t.after(() => f.close());
  const a = await f.actor(),
    r = await f.actor(),
    s = await f.actor(),
    c = await f.catalog(a),
    target = c.targets[0]!;
  await f.subscribe(r, c, target);
  await f.subscribe(s, c, target);
  const root = await f.publish(a, c, target),
    event = await f.event(a, root.input.clientRequestId);
  const results = await Promise.all([
    f.worker().run({ mode: 'apply', eventIds: [event] }),
    f.worker().run({ mode: 'apply', eventIds: [event] }),
  ]);
  assert.equal(
    results.reduce((n, r) => n + r.failed, 0),
    0,
    JSON.stringify(results),
  );
  assert.equal(
    results.reduce((n, r) => n + r.materialized, 0),
    2,
  );
  assert.equal(
    results.reduce((n, r) => n + r.processed, 0),
    1,
  );
  assert.equal(
    results.reduce((n, r) => n + r.alreadyProcessed, 0),
    1,
  );
  assert.equal((await f.notices(event)).length, 2);
  assert.equal((await f.processing(event)).length, 2);
  assert.equal(
    (
      await f.pool.query(
        'SELECT 1 FROM whaleu_notifications.rating_subscription_event_receipts WHERE event_id=$1',
        [event],
      )
    ).rowCount,
    1,
  );
  assert.equal(
    (
      await f.pool.query(
        'SELECT 1 FROM whaleu_notifications.rating_subscription_fanout_pages WHERE event_id=$1',
        [event],
      )
    ).rowCount,
    1,
  );
});
