import assert from 'node:assert/strict';
import { test } from 'node:test';
import request from 'supertest';
import { ratingSubscriptionUpdatesFixture } from '../support/rating-subscription-updates-fixture.js';
import { approveRating } from '../support/rating-runtime-fixture.js';
test('subscription source capture cannot omit root/reply companion, stream or initial job', async (t) => {
  const f = await ratingSubscriptionUpdatesFixture();
  t.after(() => f.close());
  const a = await f.actor(),
    c = await f.catalog(a),
    target = c.targets[0]!,
    root = await f.publish(a, c, target);
  for (const subject of ['root', 'reply'] as const)
    for (const [schema, table] of [
      ['whaleu_ratings', 'subscription_fanout_sources'],
      ['whaleu_ratings', 'subscription_stream_entries'],
      ['whaleu_notifications', 'rating_subscription_fanout_jobs'],
    ] as const) {
      await t.test(
        `${subject} ${table} suppression aborts publication and receipt`,
        async () => {
          const body =
            subject === 'root'
              ? f.body(c, target)
              : f.replyBody(c, target, root);
          await approveRating(
            f.pool,
            subject === 'root'
              ? f.envelope(a, c, target, body as ReturnType<typeof f.body>)
              : f.replyEnvelope(
                  a,
                  c,
                  target,
                  root,
                  body as ReturnType<typeof f.replyBody>,
                ),
          );
          await f.pool.query(
            'CREATE FUNCTION whaleu_ratings.synthetic_subscription_capture_omit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$',
          );
          await f.pool.query(
            `CREATE TRIGGER a_synthetic_subscription_capture_omit BEFORE INSERT ON ${schema}.${table} FOR EACH ROW EXECUTE FUNCTION whaleu_ratings.synthetic_subscription_capture_omit()`,
          );
          try {
            const response = await f
              .auth(
                request(f.http).post(
                  subject === 'root'
                    ? `/v1/ratings/targets/${target.id}/comments`
                    : `/v1/ratings/comments/${root.id}/replies`,
                ),
                a,
              )
              .send(body);
            assert.ok(response.status >= 500, JSON.stringify(response.body));
          } finally {
            await f.pool.query(
              `DROP TRIGGER a_synthetic_subscription_capture_omit ON ${schema}.${table}`,
            );
            await f.pool.query(
              'DROP FUNCTION whaleu_ratings.synthetic_subscription_capture_omit()',
            );
          }
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_ratings.requests WHERE account_id=$1 AND request_id=$2',
                [a.accountId, body.clientRequestId],
              )
            ).rowCount,
            0,
          );
          assert.equal(
            (
              await f.pool.query(
                'SELECT 1 FROM whaleu_ratings.effect_events WHERE actor_account_id=$1 AND request_id=$2',
                [a.accountId, body.clientRequestId],
              )
            ).rowCount,
            0,
          );
        },
      );
    }
});
