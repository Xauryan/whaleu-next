import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ratingIso } from '../repository.js';
import { ratingSubscriptionSourceSchema } from './subscription-contracts.js';
import type {
  RatingSubscriptionEpoch,
  RatingSubscriptionSource,
} from './subscription-contracts.js';
/** Companion sources are independent of the direct/like completion receipts. */
@Injectable()
export class RatingsSubscriptionUpdatesSourceFacade {
  async event(
    id: string,
    tx: PoolClient,
  ): Promise<RatingSubscriptionSource | null> {
    const row = (
      await tx.query<{
        event_id: string;
        event_sequence: string;
        occurred_at: string;
        actor_id: string;
        target_order: string;
        captured_coverage: 'complete' | 'unknown';
        region_id: string | null;
        target_id: string;
        root_id: string;
        reply_id: string | null;
      }>(
        `SELECT s.*,e.region_id,e.event_sequence::text,${ratingIso('e.occurred_at')} occurred_at
      FROM whaleu_ratings.subscription_fanout_sources s JOIN whaleu_ratings.effect_events e ON e.id=s.event_id
      WHERE s.event_id=$1 AND s.source_version=1 AND e.source_version=1
      AND e.rule_version='rating-effects-v1' AND e.event_kind IN ('root_created','reply_created')`,
        [id],
      )
    ).rows[0];
    if (!row) return null;
    return ratingSubscriptionSourceSchema.parse({
      id: row.event_id,
      sequence: row.event_sequence,
      occurredAt: row.occurred_at,
      actorAccountId: row.actor_id,
      targetOrder: row.target_order,
      coverage: row.captured_coverage,
      activity: row.reply_id === null ? 'root' : 'reply',
      target: {
        regionId: row.region_id,
        targetId: row.target_id,
        rootId: row.root_id,
        replyId: row.reply_id,
      },
    });
  }
  async lockTarget(event: RatingSubscriptionSource, tx: PoolClient) {
    const row = (
      await tx.query(
        'SELECT id FROM whaleu_ratings.targets WHERE id=$1 FOR SHARE',
        [event.target.targetId],
      )
    ).rows[0];
    if (!row) throw new Error('Subscription source target missing');
  }
  async rawPage(
    eventId: string,
    afterOrder: string | null,
    afterId: string | null,
    tx: PoolClient,
  ): Promise<RatingSubscriptionEpoch[]> {
    const rows = (
      await tx.query<RatingSubscriptionEpoch>(
        `SELECT epoch_id "epochId",account_id "accountId",start_order::text "startOrder",eligible
       FROM whaleu_ratings.subscription_fanout_raw_page($1,$2::bigint,$3::uuid)`,
        [eventId, afterOrder, afterId],
      )
    ).rows;
    if (rows.length > 51)
      throw new Error('Subscription raw page exceeded bound');
    return rows;
  }
}
