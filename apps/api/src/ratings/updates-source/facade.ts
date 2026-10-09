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
  kind: 'reply';
  id: string;
  sequence: string;
  occurredAt: string;
  target: RatingUpdateTarget;
  recipients: RatingUpdateRecipient[];
}
export interface RatingLikeUpdateTarget extends Omit<
  RatingUpdateTarget,
  'replyId'
> {
  replyId: string | null;
}
export interface RatingLikeUpdateRecipient {
  accountId: string;
  reason: 'like';
}
export interface RatingLikeUpdateEvent extends Omit<
  RatingUpdateEvent,
  'kind' | 'target' | 'recipients'
> {
  kind: 'like';
  actorAccountId: string;
  target: RatingLikeUpdateTarget;
  recipients: RatingLikeUpdateRecipient[];
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
    | { status: 'ready'; event: RatingUpdateEvent | RatingLikeUpdateEvent }
  > {
    const e = (
      await tx.query<{
        id: string;
        source_version: number;
        event_kind: string;
        actor_account_id: string;
        subject_author_id: string | null;
        region_id: string | null;
        target_id: string;
        root_id: string;
        reply_id: string | null;
        sequence: string;
        occurred_at: string;
        expected_direct_notice_obligations: number;
      }>(
        `SELECT *,event_sequence::text sequence,${ratingIso('occurred_at')} occurred_at FROM whaleu_ratings.effect_events WHERE id=$1 AND ((source_version=1 AND rule_version='rating-effects-v1' AND event_kind IN ('root_created','reply_created','root_deleted','reply_deleted')) OR (source_version=2 AND rule_version='rating-likes-v1' AND event_kind IN ('content_liked','content_unliked')))`,
        [id],
      )
    ).rows[0];
    if (!e) return { status: 'missing' };
    if (!['reply_created', 'content_liked'].includes(e.event_kind))
      return { status: 'ignored', code: 'no_direct_updates' };
    const recipients = (
      await tx.query<RatingUpdateRecipient | RatingLikeUpdateRecipient>(
        'SELECT recipient_account_id "accountId",reason FROM whaleu_ratings.notice_obligations WHERE event_id=$1 ORDER BY recipient_account_id',
        [id],
      )
    ).rows;
    if (recipients.length !== e.expected_direct_notice_obligations)
      throw new Error('Rating obligations are incomplete');
    const common = {
      id,
      sequence: e.sequence,
      occurredAt: e.occurred_at,
      target: {
        regionId: e.region_id,
        targetId: e.target_id,
        rootId: e.root_id,
        replyId: e.reply_id,
      },
    };
    if (e.source_version === 2) {
      const expected = e.subject_author_id === e.actor_account_id ? 0 : 1;
      if (
        !e.subject_author_id ||
        recipients.length !== expected ||
        recipients.some(
          (r) => r.reason !== 'like' || r.accountId !== e.subject_author_id,
        )
      )
        throw new Error('Rating like obligations are incomplete');
      return {
        status: 'ready',
        event: {
          ...common,
          kind: 'like',
          actorAccountId: e.actor_account_id,
          recipients: recipients as RatingLikeUpdateRecipient[],
        },
      };
    }
    if (!e.reply_id || recipients.some((r) => r.reason === 'like'))
      throw new Error('Rating reply obligations are incomplete');
    return {
      status: 'ready',
      event: {
        ...common,
        kind: 'reply',
        target: { ...common.target, replyId: e.reply_id },
        recipients: recipients as RatingUpdateRecipient[],
      },
    };
  }
}
