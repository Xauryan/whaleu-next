import { Inject, Injectable } from '@nestjs/common';
import { RatingGroupPromotionService } from './service.js';
@Injectable()
export class RatingPromotionRetention {
  constructor(
    @Inject(RatingGroupPromotionService)
    private readonly app: RatingGroupPromotionService,
  ) {}
  async maintain() {
    if (!this.app.runtime) return { purged: 0, expired: 0 };
    return this.app.run(async (tx) => {
      await tx.query(
        'INSERT INTO whaleu_ratings.promotion_retention_effect_cursor(singleton) VALUES(true) ON CONFLICT DO NOTHING',
      );
      const cursor = (
        await tx.query<{ last_id: string | null }>(
          'SELECT last_id FROM whaleu_ratings.promotion_retention_effect_cursor WHERE singleton FOR UPDATE',
        )
      ).rows[0]!;
      const pending = (
        await tx.query<{ id: string; expired: boolean }>(
          `WITH batch AS MATERIALIZED(SELECT id,campaign_id FROM whaleu_notifications.rating_group_effects WHERE state IN('pending','retry_wait') AND ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT 32 FOR UPDATE SKIP LOCKED) SELECT b.id,(c.cancelled_at IS NOT NULL OR c.expires_at<=clock_timestamp()) expired FROM batch b JOIN whaleu_ratings.promotion_campaigns c ON c.id=b.campaign_id ORDER BY b.id`,
          [cursor.last_id],
        )
      ).rows;
      const expired = await tx.query(
        `UPDATE whaleu_notifications.rating_group_effects SET state='suppressed_unsent',reason='cancelled_or_expired' WHERE id=ANY($1::uuid[])`,
        [pending.filter((row) => row.expired).map((row) => row.id)],
      );
      await tx.query(
        'UPDATE whaleu_ratings.promotion_retention_effect_cursor SET last_id=$1 WHERE singleton',
        [pending.at(-1)?.id ?? null],
      );
      await tx.query(
        `WITH work AS (SELECT id FROM whaleu_notifications.rating_group_effects WHERE state='dispatch_unknown' AND created_at<=clock_timestamp()-interval '24 hours' ORDER BY created_at,id LIMIT 32 FOR UPDATE SKIP LOCKED) UPDATE whaleu_notifications.rating_group_effects SET state='parked_unknown' WHERE id IN(SELECT id FROM work)`,
      );
      const purged = await tx.query<{ id: string }>(
        `WITH work AS (SELECT id FROM whaleu_ratings.promotion_campaigns WHERE expires_at+interval '24 hours'<clock_timestamp() AND payload_purged_at IS NULL ORDER BY expires_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) UPDATE whaleu_ratings.promotion_campaigns SET payload=NULL,payload_purged_at=clock_timestamp() WHERE id IN(SELECT id FROM work) RETURNING id`,
      );
      if (purged.rows.length)
        await tx.query(
          `UPDATE whaleu_notifications.rating_group_effects SET result_text=NULL WHERE campaign_id=ANY($1::uuid[]) AND stage IN('generation','shortlink')`,
          [purged.rows.map((r) => r.id)],
        );
      const old = (
        await tx.query<{ id: string }>(
          `SELECT id FROM whaleu_ratings.promotion_campaigns WHERE expires_at<clock_timestamp()-interval '180 days' ORDER BY expires_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
        )
      ).rows;
      for (const row of old)
        await tx.query(
          'INSERT INTO whaleu_ratings.promotion_retention_commands(campaign_id) VALUES($1)',
          [row.id],
        );
      await tx.query(
        'INSERT INTO whaleu_ratings.promotion_orphan_retention_commands DEFAULT VALUES',
      );
      return {
        purged: purged.rowCount ?? 0,
        expired: expired.rowCount ?? 0,
        metadataPurged: old.length,
      };
    }, 5000);
  }
}
