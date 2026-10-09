import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ratingSubscriptionUpdatesFixture } from '../support/rating-subscription-updates-fixture.js';
import { withCommunityScopeWriter } from '../support/community-scope-fixtures.js';
import { RatingUpdatesWorker } from '../../src/notifications/ratings/worker.js';
import { DatabaseService } from '../../src/database/database.js';
import { APP_CONFIG } from '../../src/config/config.js';
import type { RuntimeConfig } from '../../src/config/config.js';
import { RatingsUpdatesSourceFacade } from '../../src/ratings/updates-source/facade.js';
import { RatingUpdatesProjectionFacade } from '../../src/ratings/updates-source/projection.js';
import { RatingUpdatesRepository } from '../../src/notifications/ratings/repository.js';
test(
  'subscription fanout: real fixed-event three-page history, per-recipient transactions and root/reply sources',
  { timeout: 240000 },
  async (t) => {
    const f = await ratingSubscriptionUpdatesFixture();
    t.after(() => f.close());
    const producer = await f.actor(),
      churn = await f.actor();
    const c = await f.catalog(producer, { regionId: f.scope.home.regionId }),
      target = c.targets[0]!;
    // Exactly 121 ended epochs consume raw slots, even though none may receive.
    for (let i = 0; i < 121; i++) {
      await f.subscribe(churn, c, target);
      await f.subscribe(churn, c, target, false);
    }
    await f.subscribe(producer, c, target);
    const recipients = [];
    for (let i = 0; i < 8; i++) {
      const actor = await f.actor();
      await f.subscribe(actor, c, target);
      recipients.push(actor);
    }
    const root = await f.publish(producer, c, target),
      eventId = await f.event(producer, root.input.clientRequestId);
    const source = (
      await f.pool.query(
        'SELECT * FROM whaleu_ratings.subscription_fanout_sources WHERE event_id=$1',
        [eventId],
      )
    ).rows[0]!;
    assert.equal(source.captured_coverage, 'complete');
    const before = await f.snapshot();
    const dry = await f
      .worker()
      .run({ eventIds: [eventId], maxPages: 3, maxRecipients: 20 });
    assert.equal(dry.wouldMaterialize, 8);
    assert.equal(dry.processed, 0);
    assert.deepEqual(await f.snapshot(), before);
    const first = await f.worker().run({
      mode: 'apply',
      eventIds: [eventId],
      maxPages: 1,
      maxRecipients: 1,
    });
    assert.equal(first.pages, 1);
    assert.equal(first.processed, 0);
    assert.equal(first.materialized, 0);
    assert.equal(first.partial, 1);
    assert.equal(
      (
        await f.pool.query(
          'SELECT raw_count FROM whaleu_notifications.rating_subscription_fanout_pages WHERE event_id=$1',
          [eventId],
        )
      ).rows[0]!.raw_count,
      50,
    );
    const second = await f.worker().run({
      mode: 'apply',
      eventIds: [eventId],
      maxPages: 1,
      maxRecipients: 1,
    });
    assert.equal(second.materialized, 0);
    assert.equal(second.partial, 1);
    const third = await f.worker().run({
      mode: 'apply',
      eventIds: [eventId],
      maxPages: 1,
      maxRecipients: 3,
    });
    assert.equal(third.materialized, 3);
    assert.equal(third.partial, 1);
    assert.equal((await f.notices(eventId)).length, 3);
    const final = await f.worker().run({
      mode: 'apply',
      eventIds: [eventId],
      maxPages: 1,
      maxRecipients: 20,
    });
    assert.equal(final.materialized, 5);
    assert.equal(final.processed, 1);
    assert.equal(final.failed, 0, JSON.stringify(final));
    assert.equal((await f.notices(eventId)).length, 8);
    assert.equal((await f.processing(eventId)).length, 8);
    assert.equal(
      (await f.worker().run({ mode: 'apply', eventIds: [eventId] }))
        .alreadyProcessed,
      1,
    );
    const pages = (
      await f.pool.query(
        'SELECT page_number,raw_count,scan_finished FROM whaleu_notifications.rating_subscription_fanout_pages WHERE event_id=$1 ORDER BY page_number',
        [eventId],
      )
    ).rows;
    assert.deepEqual(pages, [
      { page_number: 1, raw_count: 50, scan_finished: false },
      { page_number: 2, raw_count: 50, scan_finished: false },
      { page_number: 3, raw_count: 30, scan_finished: true },
    ]);
    const firstRecipient = recipients[0]!;
    assert.equal((await f.get(firstRecipient)).body.items[0].activity, 'root');
    assert.equal((await f.get(producer)).body.items.length, 0);
    // A direct root author can independently receive the subscription notice too.
    const reply = await f.publishReply(firstRecipient, c, target, root),
      replyEvent = await f.event(firstRecipient, reply.input.clientRequestId);
    const sub = await f.worker().run({
      mode: 'apply',
      eventIds: [replyEvent],
      maxPages: 3,
      maxRecipients: 20,
    });
    assert.equal(sub.materialized, 8);
    assert.equal(sub.processed, 1);
    const directWorker = new RatingUpdatesWorker(
      f.app.get(DatabaseService),
      {
        ...f.app.get<RuntimeConfig>(APP_CONFIG),
        RATINGS_UPDATES_PROCESSING: 'manual',
      },
      f.app.get(RatingsUpdatesSourceFacade),
      f.app.get(RatingUpdatesProjectionFacade),
      f.app.get(RatingUpdatesRepository),
    );
    assert.equal(
      (await directWorker.run({ mode: 'apply', eventIds: [replyEvent] }))
        .materialized,
      1,
    );
    assert.equal(
      (await f.notices(replyEvent)).filter(
        (n) => n.recipient_account_id === producer.accountId,
      ).length,
      1,
    );
    const projection = (await f.get(producer)).body.items[0];
    assert.equal(projection.activity, 'reply');
    assert.equal(projection.target.replyId, reply.id);
    const direct = (
      await f.pool.query(
        'SELECT id,read_at FROM whaleu_notifications.rating_notices WHERE event_id=$1 AND recipient_account_id=$2',
        [replyEvent, producer.accountId],
      )
    ).rows[0]!;
    await f.read(producer, projection.noticeId);
    assert.equal(
      (
        await f.pool.query(
          'SELECT read_at FROM whaleu_notifications.rating_notices WHERE id=$1',
          [direct.id],
        )
      ).rows[0]!.read_at,
      null,
    );
    await t.test(
      'raw cursor forgery and completed page mutation are rejected',
      async () => {
        await assert.rejects(
          withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              'UPDATE whaleu_notifications.rating_subscription_fanout_jobs SET cursor_order=0 WHERE event_id=$1',
              [eventId],
            ),
          ),
        );
        await assert.rejects(
          withCommunityScopeWriter(f.pool, (tx) =>
            tx.query(
              "UPDATE whaleu_notifications.rating_subscription_fanout_pages SET raw_count=0,raw_epoch_ids='{}' WHERE event_id=$1 AND page_number=1",
              [eventId],
            ),
          ),
        );
      },
    );
  },
);
test('unknown subscription coverage is captured but cannot be completed as an empty audience', async (t) => {
  const f = await ratingSubscriptionUpdatesFixture();
  t.after(() => f.close());
  const a = await f.actor(),
    c = await f.catalog(a, { baseline: false }),
    target = c.targets[0]!;
  const root = await f.publish(a, c, target),
    event = await f.event(a, root.input.clientRequestId);
  const before = await f.snapshot();
  const result = await f.worker().run({ mode: 'apply', eventIds: [event] });
  assert.equal(result.blocked, 1);
  assert.equal(result.processed, 0);
  assert.equal(result.retryable, 1);
  assert.deepEqual(await f.snapshot(), before);
  await assert.rejects(
    withCommunityScopeWriter(f.pool, (tx) =>
      tx.query(
        'INSERT INTO whaleu_notifications.rating_subscription_event_receipts(event_id) VALUES($1)',
        [event],
      ),
    ),
  );
  assert.equal(
    (
      await f.pool.query(
        'SELECT 1 FROM whaleu_notifications.rating_subscription_fanout_pages WHERE event_id=$1',
        [event],
      )
    ).rowCount,
    0,
  );
});
