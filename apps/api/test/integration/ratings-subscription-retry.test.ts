import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ratingSubscriptionUpdatesFixture } from '../support/rating-subscription-updates-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
test(
  'subscription retry: unknown authority is durable, independent and never terminal suppression',
  { timeout: 120000 },
  async (t) => {
    const f = await ratingSubscriptionUpdatesFixture();
    t.after(() => f.close());
    const author = await f.actor(),
      known = await f.actor(),
      unknown = await f.actor(),
      c = await f.catalog(author),
      target = c.targets[0]!;
    await f.subscribe(known, c, target);
    await f.subscribe(unknown, c, target);
    const root = await f.publish(author, c, target),
      event = await f.event(author, root.input.clientRequestId);
    await f.certify(unknown.accountId, { phone: 'unavailable' });
    const first = await f.worker().run({ mode: 'apply', eventIds: [event] });
    assert.equal(first.failed, 0, JSON.stringify(first));
    assert.equal(first.materialized, 1);
    assert.equal(first.processed, 0);
    assert.equal(first.partial, 1);
    assert.equal(first.retryable, 1);
    const receipts = await f.processing(event);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0]!.recipient_account_id, known.accountId);
    assert.equal((await f.get(known)).body.unreadCount, 1);
    const retry = (
      await f.pool.query(
        'SELECT status,attempts,next_attempt_at IS NOT NULL AS backed_off FROM whaleu_notifications.rating_subscription_recipient_work WHERE event_id=$1 AND recipient_account_id=$2',
        [event, unknown.accountId],
      )
    ).rows[0]!;
    assert.deepEqual(retry, { status: 'retry', attempts: 1, backed_off: true });
    const before = await f.snapshot();
    const dry = await f.worker().run({ eventIds: [event] });
    assert.equal(dry.retryable, 1);
    assert.deepEqual(await f.snapshot(), before);
    await assert.rejects(
      withCommunityScopeWriter(f.pool, (tx) =>
        tx.query(
          'INSERT INTO whaleu_notifications.rating_subscription_event_receipts(event_id) VALUES($1)',
          [event],
        ),
      ),
    );
    await f.certify(unknown.accountId, { phone: 'verified' });
    await f.waitRetry(event);
    const recovered = await f
      .worker()
      .run({ mode: 'apply', eventIds: [event] });
    assert.equal(recovered.materialized, 1);
    assert.equal(recovered.processed, 1);
    assert.equal(recovered.failed, 0, JSON.stringify(recovered));
    assert.equal((await f.notices(event)).length, 2);
  },
);
test(
  'subscription recovery: a recipient failure after SQL notice insert rolls back only that recipient',
  { timeout: 120000 },
  async (t) => {
    const f = await ratingSubscriptionUpdatesFixture();
    t.after(() => f.close());
    const author = await f.actor(),
      a = await f.actor(),
      b = await f.actor(),
      c = await f.catalog(author),
      target = c.targets[0]!;
    await f.subscribe(a, c, target);
    await f.subscribe(b, c, target);
    const root = await f.publish(author, c, target),
      event = await f.event(author, root.input.clientRequestId);
    const original = f.records.materialize.bind(f.records);
    let faulted = false;
    const fault = t.mock.method(
      f.records,
      'materialize',
      async (...args: Parameters<typeof original>) => {
        await original(...args);
        if (args[1].recipient_account_id === a.accountId && !faulted) {
          faulted = true;
          throw Error('Synthetic interruption after notice and receipt');
        }
      },
    );
    const first = await f.worker().run({ mode: 'apply', eventIds: [event] });
    fault.mock.restore();
    assert.equal(first.failed, 1);
    assert.equal(first.materialized, 1);
    assert.equal(first.processed, 0);
    assert.equal((await f.notices(event)).length, 1);
    assert.equal((await f.processing(event)).length, 1);
    const surviving = (await f.notices(event))[0]!;
    assert.equal(surviving.recipient_account_id, b.accountId);
    await f.waitRetry(event);
    const result = await f.worker().run({ mode: 'apply', eventIds: [event] });
    assert.equal(result.materialized, 1);
    assert.equal(result.processed, 1);
    assert.equal((await f.notices(event)).length, 2);
    assert.equal(
      (await f.notices(event)).find(
        (n) => n.recipient_account_id === b.accountId,
      )!.id,
      surviving.id,
    );
  },
);
test('subscription recovery: dropped page write cannot advance cursor and retry uses same event', async (t) => {
  const f = await ratingSubscriptionUpdatesFixture();
  t.after(() => f.close());
  const a = await f.actor(),
    r = await f.actor(),
    c = await f.catalog(a),
    target = c.targets[0]!;
  await f.subscribe(r, c, target);
  const root = await f.publish(a, c, target),
    event = await f.event(a, root.input.clientRequestId);
  const original = f.records.addPage.bind(f.records);
  const fault = t.mock.method(
    f.records,
    'addPage',
    async (...args: Parameters<typeof original>) => {
      await original(...args);
      throw Error('Synthetic page transaction interruption');
    },
  );
  const first = await f.worker().run({ mode: 'apply', eventIds: [event] });
  fault.mock.restore();
  assert.equal(first.failed, 1);
  assert.equal(first.processed, 0);
  assert.equal(
    (
      await f.pool.query(
        'SELECT last_page FROM whaleu_notifications.rating_subscription_fanout_jobs WHERE event_id=$1',
        [event],
      )
    ).rows[0]!.last_page,
    0,
  );
  assert.equal(
    (
      await f.pool.query(
        'SELECT 1 FROM whaleu_notifications.rating_subscription_recipient_work WHERE event_id=$1',
        [event],
      )
    ).rowCount,
    0,
  );
  const resumed = await f.worker().run({ mode: 'apply', eventIds: [event] });
  assert.equal(resumed.materialized, 1);
  assert.equal(resumed.processed, 1);
});
test(
  'subscription final proof: expired phone fact rolls back tentative notice and remains retryable',
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
    const expiry = new Date(Date.now() + 2500);
    await f.certify(r.accountId, { expiresAt: expiry });
    const original = f.records.materialize.bind(f.records);
    let reached = false;
    const hook = t.mock.method(
      f.records,
      'materialize',
      async (...args: Parameters<typeof original>) => {
        await original(...args);
        reached = true;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, expiry.getTime() - Date.now()) + 30),
        );
      },
    );
    const result = await f.worker().run({ mode: 'apply', eventIds: [event] });
    hook.mock.restore();
    assert.equal(reached, true);
    assert.equal(result.materialized, 0);
    assert.equal(result.failed, 1);
    assert.equal(result.retryable, 1);
    assert.deepEqual(await f.notices(event), []);
    assert.deepEqual(await f.processing(event), []);
    await f.certify(r.accountId);
    await f.waitRetry(event);
    const recovered = await f
      .worker()
      .run({ mode: 'apply', eventIds: [event] });
    assert.equal(recovered.materialized, 1);
    assert.equal(recovered.processed, 1);
  },
);
test(
  'subscription final proof: grant NOWAIT conflict rolls back tentative recipient and does not suppress',
  { timeout: 120000 },
  async (t) => {
    const f = await ratingSubscriptionUpdatesFixture();
    t.after(() => f.close());
    const a = await f.actor(),
      r = await f.actor(),
      c = await f.catalog(a, { regionId: f.scope.home.regionId }),
      target = c.targets[0]!;
    await f.subscribe(r, c, target);
    const root = await f.publish(a, c, target),
      event = await f.event(a, root.input.clientRequestId);
    const blocker = await f.pool.connect(),
      original = f.records.materialize.bind(f.records);
    let locked = false;
    const hook = t.mock.method(
      f.records,
      'materialize',
      async (...args: Parameters<typeof original>) => {
        await original(...args);
        if (!locked) {
          await blocker.query('BEGIN');
          await blocker.query(
            'LOCK TABLE whaleu_authorization.role_grants IN ROW EXCLUSIVE MODE',
          );
          locked = true;
        }
      },
    );
    try {
      const result = await f.worker().run({ mode: 'apply', eventIds: [event] });
      assert.equal(locked, true);
      assert.equal(result.failed, 1);
      assert.equal(result.materialized, 0);
      assert.equal(result.retryable, 1);
      assert.equal(result.suppressed, 0);
      assert.deepEqual(await f.notices(event), []);
      assert.deepEqual(await f.processing(event), []);
    } finally {
      hook.mock.restore();
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    await f.waitRetry(event);
    const recovered = await f
      .worker()
      .run({ mode: 'apply', eventIds: [event] });
    assert.equal(recovered.materialized, 1);
    assert.equal(recovered.processed, 1);
  },
);
for (const omitted of ['completion', 'page', 'retry'] as const)
  test(
    `subscription durable acknowledgements: swallowed ${omitted} write cannot claim progress`,
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
      if (omitted === 'retry')
        await f.certify(r.accountId, { phone: 'unavailable' });
      const table =
        omitted === 'completion'
          ? 'rating_subscription_event_receipts'
          : omitted === 'page'
            ? 'rating_subscription_fanout_pages'
            : 'rating_subscription_recipient_work';
      await withCommunityScopeWriter(f.pool, async (tx) => {
        await tx.query(
          `CREATE FUNCTION whaleu_notifications.synthetic_omit_subscription_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`,
        );
        await tx.query(
          `CREATE TRIGGER zz_synthetic_omit_subscription_write BEFORE ${omitted === 'retry' ? 'UPDATE' : 'INSERT'} ON whaleu_notifications.${table} FOR EACH ROW EXECUTE FUNCTION whaleu_notifications.synthetic_omit_subscription_write()`,
        );
      });
      try {
        const result = await f
          .worker()
          .run({ mode: 'apply', eventIds: [event] });
        assert.equal(result.processed, 0);
        assert.equal(result.failed, 1, JSON.stringify(result));
        assert.equal(result.partial, 1);
        assert.equal(result.retryable, 1);
        assert.equal(
          (
            await f.pool.query(
              'SELECT 1 FROM whaleu_notifications.rating_subscription_event_receipts WHERE event_id=$1',
              [event],
            )
          ).rowCount,
          0,
        );
        if (omitted === 'completion') {
          assert.equal(result.materialized, 1);
          assert.equal((await f.notices(event)).length, 1);
          assert.equal((await f.processing(event)).length, 1);
        } else {
          assert.equal(result.materialized, 0);
          assert.deepEqual(await f.notices(event), []);
          if (omitted === 'page') {
            assert.equal(result.pages, 0);
            assert.equal(
              (
                await f.pool.query(
                  'SELECT last_page FROM whaleu_notifications.rating_subscription_fanout_jobs WHERE event_id=$1',
                  [event],
                )
              ).rows[0]!.last_page,
              0,
            );
          } else {
            assert.deepEqual(
              (
                await f.pool.query(
                  'SELECT status,attempts FROM whaleu_notifications.rating_subscription_recipient_work WHERE event_id=$1',
                  [event],
                )
              ).rows,
              [{ status: 'pending', attempts: 0 }],
            );
          }
        }
      } finally {
        await withCommunityScopeWriter(f.pool, async (tx) => {
          await tx.query(
            `DROP TRIGGER zz_synthetic_omit_subscription_write ON whaleu_notifications.${table}`,
          );
          await tx.query(
            'DROP FUNCTION whaleu_notifications.synthetic_omit_subscription_write()',
          );
        });
      }
      if (omitted === 'retry') await f.certify(r.accountId);
      const resumed = await f
        .worker()
        .run({ mode: 'apply', eventIds: [event] });
      assert.equal(resumed.processed, 1);
      assert.equal(resumed.failed, 0, JSON.stringify(resumed));
      assert.equal(resumed.materialized, omitted === 'completion' ? 0 : 1);
      assert.equal((await f.notices(event)).length, 1);
      assert.equal((await f.processing(event)).length, 1);
    },
  );
