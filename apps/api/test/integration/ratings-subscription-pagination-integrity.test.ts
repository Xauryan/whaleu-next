import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ratingSubscriptionUpdatesFixture } from '../support/rating-subscription-updates-fixture.js';
import { inTransaction } from '../../src/database/database.js';
import { lockSafetyPolicy } from '../../src/safety/locks.js';

test('subscription raw page, work, notice and receipt exact-set SQL guards reject missing causal steps', async (t) => {
  const f = await ratingSubscriptionUpdatesFixture();
  t.after(() => f.close());
  const a = await f.actor(),
    r = await f.actor(),
    other = await f.actor(),
    c = await f.catalog(a),
    target = c.targets[0]!;
  await f.subscribe(r, c, target);
  await f.subscribe(other, c, target);
  async function publication() {
    const root = await f.publish(a, c, target);
    return f.event(a, root.input.clientRequestId);
  }
  async function page(event: string, patch: 'empty' | 'skip' | 'valid') {
    return inTransaction(
      f.pool,
      async (tx) => {
        await lockSafetyPolicy(tx);
        const source = await f.source.event(event, tx);
        assert.ok(source);
        await f.source.lockTarget(source, tx);
        const job = await f.records.job(event, tx, true),
          raw = await f.source.rawPage(
            event,
            job.cursor_order,
            job.cursor_epoch_id,
            tx,
          );
        await f.records.addPage(
          patch === 'skip' ? { ...job, last_page: job.last_page + 1 } : job,
          patch === 'empty' ? [] : raw,
          tx,
        );
      },
      { isolationLevel: 'read committed' },
    );
  }
  async function fault(
    table: string,
    action: () => Promise<void>,
    condition = 'true',
  ) {
    await f.pool.query(
      'CREATE FUNCTION whaleu_notifications.synthetic_subscription_omit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$',
    );
    await f.pool.query(
      `CREATE TRIGGER a_synthetic_subscription_omit BEFORE INSERT ON whaleu_notifications.${table} FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION whaleu_notifications.synthetic_subscription_omit()`,
    );
    try {
      await action();
    } finally {
      await f.pool.query(
        `DROP TRIGGER a_synthetic_subscription_omit ON whaleu_notifications.${table}`,
      );
      await f.pool.query(
        'DROP FUNCTION whaleu_notifications.synthetic_subscription_omit()',
      );
    }
  }
  await t.test(
    'initial false empty and skipped page cannot claim scan end or advance cursor',
    async () => {
      const event = await publication();
      for (const mode of ['empty', 'skip'] as const)
        await assert.rejects(page(event, mode), /exact bounded continuation/);
      const j = (
        await f.pool.query(
          'SELECT last_page,scan_finished FROM whaleu_notifications.rating_subscription_fanout_jobs WHERE event_id=$1',
          [event],
        )
      ).rows[0];
      assert.deepEqual(j, { last_page: 0, scan_finished: false });
      await assert.rejects(
        f.pool.query(
          'INSERT INTO whaleu_notifications.rating_subscription_event_receipts(event_id) VALUES($1)',
          [event],
        ),
        /not fully settled/,
      );
    },
  );
  await t.test(
    'one omitted recipient among an otherwise exact page prevents the page and cursor commit',
    async () => {
      const event = await publication();
      await fault(
        'rating_subscription_recipient_work',
        async () => {
          await assert.rejects(page(event, 'valid'), /page work incomplete/);
        },
        `NEW.recipient_account_id='${r.accountId}'::uuid`,
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
      assert.equal(
        (
          await f.pool.query(
            'SELECT last_page FROM whaleu_notifications.rating_subscription_fanout_jobs WHERE event_id=$1',
            [event],
          )
        ).rows[0].last_page,
        0,
      );
      const replay = await f.worker().run({ mode: 'apply', eventIds: [event] });
      assert.equal(replay.processed, 1);
      assert.equal(replay.materialized, 2);
    },
  );
  for (const table of [
    'rating_subscription_notices',
    'rating_subscription_processing_receipts',
  ])
    await t.test(
      `omitted ${table} cannot leave a materialized work or completion`,
      async () => {
        const event = await publication();
        await fault(table, async () => {
          const result = await f
            .worker()
            .run({ mode: 'apply', eventIds: [event] });
          assert.equal(result.processed, 0);
          assert.equal(result.materialized, 0);
          assert.ok(result.retryable > 0);
        });
        assert.deepEqual(await f.notices(event), []);
        assert.deepEqual(await f.processing(event), []);
        assert.equal(
          (
            await f.pool.query(
              "SELECT 1 FROM whaleu_notifications.rating_subscription_recipient_work WHERE event_id=$1 AND status='retry'",
              [event],
            )
          ).rowCount,
          2,
        );
      },
    );
});
