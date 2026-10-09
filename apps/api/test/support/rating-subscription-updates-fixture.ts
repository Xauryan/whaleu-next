import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { ratingDiscussionFixture } from './rating-discussion-fixture.js';
import { APP_CONFIG } from '../../src/config/config.js';
import type { RuntimeConfig } from '../../src/config/config.js';
import { DatabaseService } from '../../src/database/database.js';
import { RatingSubscriptionsService } from '../../src/ratings/subscriptions/service.js';
import { RatingsSubscriptionUpdatesSourceFacade } from '../../src/ratings/updates-source/subscription-facade.js';
import { RatingSubscriptionUpdatesProjectionFacade } from '../../src/ratings/updates-source/subscription-projection.js';
import { RatingSubscriptionUpdatesRepository } from '../../src/notifications/ratings/subscription-repository.js';
import { RatingSubscriptionUpdatesWorker } from '../../src/notifications/ratings/subscription-worker.js';
export async function ratingSubscriptionUpdatesFixture() {
  const f = await ratingDiscussionFixture();
  type Actor = Awaited<ReturnType<typeof f.actor>>;
  type Catalog = Awaited<ReturnType<typeof f.catalog>>;
  type Target = Catalog['targets'][number];
  const config = {
    ...f.app.get<RuntimeConfig>(APP_CONFIG),
    RATINGS_UPDATES_PROCESSING: 'manual' as const,
  };
  const source = f.app.get(RatingsSubscriptionUpdatesSourceFacade),
    projection = f.app.get(RatingSubscriptionUpdatesProjectionFacade),
    records = f.app.get(RatingSubscriptionUpdatesRepository),
    service = f.app.get(RatingSubscriptionsService);
  const worker = () =>
    new RatingSubscriptionUpdatesWorker(
      f.app.get(DatabaseService),
      config,
      source,
      projection,
      records,
    );
  const subscribe = async (
    actor: Actor,
    catalog: Catalog,
    target: Target,
    subscribed = true,
  ) => {
    const current = await service.state(
      actor.accessToken,
      target.id,
      catalog.regionId,
    );
    assert.equal(current.status, 'known');
    if (current.status !== 'known')
      throw Error('Independent native subscription baseline required');
    const input = {
      clientRequestId: randomUUID(),
      regionId: catalog.regionId,
      expectedTargetRevision: target.revision,
      expectedSubscriptionRevision: current.revision,
      subscribed,
    };
    const result = await service.set(actor.accessToken, target.id, input);
    assert.equal(
      result.outcome,
      current.subscribed === subscribed ? 'noop' : 'applied',
      JSON.stringify(result),
    );
    return { input, result };
  };
  const event = async (actor: Actor, requestId: string) => {
    const e = (
      await f.pool.query<{ id: string }>(
        'SELECT id FROM whaleu_ratings.effect_events WHERE actor_account_id=$1 AND request_id=$2',
        [actor.accountId, requestId],
      )
    ).rows[0];
    assert.ok(e);
    return e.id;
  };
  const get = (actor: Actor, path = '') =>
    f.auth(
      request(f.http).get(`/v1/me/ratings/subscription-updates${path}`),
      actor,
    );
  const read = (actor: Actor, id: string) =>
    f
      .auth(
        request(f.http).put(`/v1/me/ratings/subscription-updates/${id}/read`),
        actor,
      )
      .send({});
  const processing = async (id: string) =>
    (
      await f.pool.query(
        'SELECT recipient_account_id,epoch_id,outcome,code,notice_id FROM whaleu_notifications.rating_subscription_processing_receipts WHERE event_id=$1 ORDER BY recipient_account_id',
        [id],
      )
    ).rows;
  const notices = async (id: string) =>
    (
      await f.pool.query(
        'SELECT * FROM whaleu_notifications.rating_subscription_notices WHERE event_id=$1 ORDER BY recipient_account_id',
        [id],
      )
    ).rows;
  const waitRetry = async (id: string) => {
    const row = (
      await f.pool.query<{ wait: number }>(
        `SELECT greatest(0,extract(epoch FROM max(next_attempt_at)-clock_timestamp())*1000)::double precision AS wait FROM whaleu_notifications.rating_subscription_recipient_work WHERE event_id=$1`,
        [id],
      )
    ).rows[0];
    await new Promise((resolve) =>
      setTimeout(resolve, Math.ceil(row?.wait ?? 0) + 25),
    );
  };
  return {
    ...f,
    source,
    projection,
    records,
    worker,
    subscribe,
    event,
    get,
    read,
    processing,
    notices,
    waitRetry,
  };
}
