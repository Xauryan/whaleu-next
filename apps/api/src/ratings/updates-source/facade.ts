import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ratingIso } from '../repository.js';
export interface RatingUpdateTarget {
  regionId: string | null;
  targetId: string;
  rootId: string;
  replyId: string;
}
export interface RatingUpdateRecipient {
  accountId: string;
  reason: 'direct_root' | 'direct_reply';
}
export interface RatingUpdateEvent {
  id: string;
  sequence: string;
  occurredAt: string;
  target: RatingUpdateTarget;
  recipients: RatingUpdateRecipient[];
}
/** Only immutable, exact-set obligations captured with the content transaction. */
@Injectable()
export class RatingsUpdatesSourceFacade {
  async event(
    id: string,
    tx: PoolClient,
  ): Promise<
    | { status: 'missing' }
    | { status: 'ignored'; code: 'no_direct_updates' }
    | { status: 'ready'; event: RatingUpdateEvent }
  > {
    const e = (
      await tx.query<{
        id: string;
        event_kind: string;
        region_id: string | null;
        target_id: string;
        root_id: string;
        reply_id: string | null;
        sequence: string;
        occurred_at: string;
        expected_direct_notice_obligations: number;
      }>(
        `SELECT *,event_sequence::text sequence,${ratingIso('occurred_at')} occurred_at FROM whaleu_ratings.effect_events WHERE id=$1 AND source_version=1 AND rule_version='rating-effects-v1'`,
        [id],
      )
    ).rows[0];
    if (!e) return { status: 'missing' };
    if (e.event_kind !== 'reply_created')
      return { status: 'ignored', code: 'no_direct_updates' };
    const recipients = (
      await tx.query<RatingUpdateRecipient>(
        'SELECT recipient_account_id "accountId",reason FROM whaleu_ratings.notice_obligations WHERE event_id=$1 ORDER BY recipient_account_id',
        [id],
      )
    ).rows;
    if (
      !e.reply_id ||
      recipients.length !== e.expected_direct_notice_obligations
    )
      throw new Error('Rating obligations are incomplete');
    return {
      status: 'ready',
      event: {
        id,
        sequence: e.sequence,
        occurredAt: e.occurred_at,
        target: {
          regionId: e.region_id,
          targetId: e.target_id,
          rootId: e.root_id,
          replyId: e.reply_id,
        },
        recipients,
      },
    };
  }
}
