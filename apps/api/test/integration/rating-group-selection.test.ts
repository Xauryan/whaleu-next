import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createPromotionFixture,
  admitPromotion,
} from './support/rating-group-promotion.js';
import { RatingGroupWorker } from '../../src/notifications/rating-group/worker.js';
import { RatingGroupPromotionService } from '../../src/ratings/group-promotion/service.js';
import { RatingGroupRepository } from '../../src/notifications/rating-group/repository.js';
test(
  'actual 10000 current receivers plus 100000 historical revisions snapshot completely with bounded restart enumeration',
  { timeout: 360000 },
  async (t) => {
    const f = await createPromotionFixture({
      receivers: 10000,
      auxiliaryReceivers: false,
    });
    t.after(() => f.close());
    await f.pool.query(
      `INSERT INTO whaleu_ratings.promotion_enrollment_history(revision,program_id,stable_destination_id,registry_revision,action,evidence_ref,recorded_at) SELECT gen_random_uuid(),$1,r.id,gen_random_uuid(),CASE WHEN h%2=0 THEN 'revoke' ELSE 'enroll' END,'synthetic:old-history',clock_timestamp()-interval '1 day'+h*interval '1 second' FROM whaleu_ratings.promotion_receivers r CROSS JOIN generate_series(1,10) h`,
      [f.programId],
    );
    const before = performance.now(),
      c = await admitPromotion(f),
      elapsed = performance.now() - before;
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_ratings.promotion_campaign_recipients WHERE campaign_id=$1',
          [c.status.campaignId],
        )
      ).rows[0].n,
      10000,
    );
    assert.ok(elapsed < 3000, `HTTP+admission took ${elapsed}ms`);
    const first = await f.worker.maintain();
    assert.equal(first.processed, 128);
    const restarted = new RatingGroupWorker(
      f.app.get(RatingGroupPromotionService),
      f.app.get(RatingGroupRepository),
    );
    let total = first.processed;
    while (total < 10000) {
      await f.pool.query(
        'UPDATE whaleu_ratings.promotion_campaigns SET next_maintenance_at=clock_timestamp() WHERE id=$1',
        [c.status.campaignId],
      );
      const result = await restarted.maintain();
      assert.ok(result.processed > 0 && result.processed <= 128);
      total += result.processed;
    }
    assert.equal(total, 10000);
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(DISTINCT original_key)::int n FROM whaleu_notifications.rating_group_effects WHERE campaign_id=$1',
          [c.status.campaignId],
        )
      ).rows[0].n,
      10000,
    );
    assert.equal(
      (
        await f.pool.query(
          'SELECT count(*)::int n FROM whaleu_ratings.promotion_enrollment_history',
        )
      ).rows[0].n,
      110000,
    );
    const plan = (
      await f.pool.query(
        `EXPLAIN (FORMAT JSON) SELECT stable_destination_id FROM whaleu_ratings.promotion_program_members_current WHERE program_id=$1 AND stable_destination_id>$2 ORDER BY stable_destination_id LIMIT 128`,
        [f.programId, randomUUID()],
      )
    ).rows;
    assert.match(JSON.stringify(plan), /Index/);
    assert.doesNotMatch(JSON.stringify(plan), /enrollment_history/);
    await assert.rejects(
      () => f.enroll(10000, 1),
      (error) => String(error).includes('quota exceeded'),
    );
  },
);
test(
  'test mode snapshots one enrolled test receiver and no normal group',
  { timeout: 240000 },
  async (t) => {
    const f = await createPromotionFixture({ receivers: 129 });
    t.after(() => f.close());
    const c = await admitPromotion(f, { mode: 'test' });
    const rows = (
      await f.pool.query(
        'SELECT stable_destination_id,audience_kind FROM whaleu_ratings.promotion_campaign_recipients WHERE campaign_id=$1',
        [c.status.campaignId],
      )
    ).rows;
    assert.deepEqual(rows, [
      { stable_destination_id: f.testDestinationId, audience_kind: 'test' },
    ]);
  },
);
