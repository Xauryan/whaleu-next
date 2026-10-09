import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import type { RatingNoticeEvent, RatingNoticeRecipient } from './contracts.js';
import type {
  RatingLikeNoticeEvent,
  RatingLikeNoticeRecipient,
} from './like-contracts.js';

/** SQL timestamps stay strings: Date would irreversibly truncate microseconds. */
export interface StoredRatingNotice {
  id: string;
  event_id: string;
  recipient_account_id: string;
  kind: 'reply';
  reason: 'direct_root' | 'direct_reply';
  region_id: string | null;
  target_id: string;
  root_id: string;
  reply_id: string;
  ordinal: string;
  created_at: string;
  read_at: string | null;
}
export interface StoredRatingLikeNotice extends Omit<
  StoredRatingNotice,
  'kind' | 'reason' | 'reply_id'
> {
  kind: 'like';
  reason: 'like';
  reply_id: string | null;
  like_actor_account_id: string;
}
type NoticeKind = 'reply' | 'like';
type StoredNotice<K extends NoticeKind> = K extends 'like'
  ? StoredRatingLikeNotice
  : StoredRatingNotice;
const instant = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const columns = `id,event_id,recipient_account_id,kind,reason,region_id,target_id,root_id,reply_id,like_actor_account_id,ordinal::text,
  ${instant('created_at')} AS created_at,${instant('read_at')} AS read_at`;
@Injectable()
export class RatingUpdatesRepository {
  async owner(accountId: string, tx: PoolClient, write = false): Promise<void> {
    await tx.query(
      'INSERT INTO whaleu_notifications.owners(account_id) VALUES($1) ON CONFLICT DO NOTHING',
      [accountId],
    );
    await tx.query(
      `SELECT account_id FROM whaleu_notifications.owners WHERE account_id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`,
      [accountId],
    );
  }
  async page<K extends NoticeKind = 'reply'>(
    accountId: string,
    limit: number,
    before: string | null,
    tx: PoolClient,
    kind: K = 'reply' as K,
  ): Promise<StoredNotice<K>[]> {
    return (
      await tx.query<StoredNotice<K>>(
        `SELECT ${columns} FROM whaleu_notifications.rating_notices n WHERE n.recipient_account_id=$1 AND n.kind=$4
       AND ($2::bigint IS NULL OR n.ordinal<$2::bigint) ORDER BY n.ordinal DESC LIMIT $3`,
        [accountId, before, limit + 1, kind],
      )
    ).rows;
  }
  async own<K extends NoticeKind = 'reply'>(
    accountId: string,
    noticeId: string,
    tx: PoolClient,
    kind: K = 'reply' as K,
  ): Promise<StoredNotice<K>> {
    const row = (
      await tx.query<StoredNotice<K>>(
        `SELECT ${columns} FROM whaleu_notifications.rating_notices WHERE id=$1 AND recipient_account_id=$2 AND kind=$3`,
        [noticeId, accountId, kind],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('NOTICE_NOT_FOUND');
    return row;
  }
  async states(
    accountId: string,
    ids: readonly string[],
    tx: PoolClient,
    kind: NoticeKind = 'reply',
  ): Promise<Map<string, string | null>> {
    if (!ids.length) return new Map();
    const rows = (
      await tx.query<{ id: string; read_at: string | null }>(
        `SELECT id,${instant('read_at')} AS read_at FROM whaleu_notifications.rating_notices
       WHERE recipient_account_id=$1 AND id=ANY($2::uuid[]) AND kind=$3`,
        [accountId, ids, kind],
      )
    ).rows;
    if (rows.length !== ids.length)
      throw new ApplicationError('RATING_UNAVAILABLE');
    return new Map(rows.map((row) => [row.id, row.read_at]));
  }
  async count(
    accountId: string,
    tx: PoolClient,
    kind: NoticeKind = 'reply',
  ): Promise<number> {
    return (
      await tx.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM whaleu_notifications.rating_notices WHERE recipient_account_id=$1 AND read_at IS NULL AND kind=$2',
        [accountId, kind],
      )
    ).rows[0]!.count;
  }
  async markRead<K extends NoticeKind = 'reply'>(
    accountId: string,
    noticeId: string,
    tx: PoolClient,
    kind: K = 'reply' as K,
  ): Promise<StoredNotice<K>> {
    const row = await this.own(accountId, noticeId, tx, kind);
    if (row.read_at !== null) return row;
    const updated = (
      await tx.query<StoredNotice<K>>(
        `UPDATE whaleu_notifications.rating_notices SET read_at=clock_timestamp()
       WHERE id=$1 AND recipient_account_id=$2 AND kind=$3 AND read_at IS NULL RETURNING ${columns}`,
        [noticeId, accountId, kind],
      )
    ).rows[0];
    if (!updated) throw new ApplicationError('RATING_UNAVAILABLE');
    return updated;
  }
  async eventReceipt(eventId: string, tx: PoolClient) {
    return (
      (
        await tx.query<{
          outcome: 'processed' | 'ignored';
          code: string | null;
        }>(
          'SELECT outcome,code FROM whaleu_notifications.rating_event_receipts WHERE event_id=$1',
          [eventId],
        )
      ).rows[0] ?? null
    );
  }
  async settleEvent(
    eventId: string,
    outcome: 'processed' | 'ignored',
    code: string | null,
    tx: PoolClient,
  ): Promise<void> {
    await tx.query(
      'INSERT INTO whaleu_notifications.rating_event_receipts(event_id,outcome,code) VALUES($1,$2,$3)',
      [eventId, outcome, code],
    );
  }
  async settleRecipient(
    eventId: string,
    recipient: RatingNoticeRecipient | RatingLikeNoticeRecipient,
    outcome: 'materialized' | 'existing' | 'suppressed',
    code: string | null,
    tx: PoolClient,
    noticeId: string | null = null,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO whaleu_notifications.rating_processing_receipts(event_id,recipient_account_id,reason,outcome,code,notice_id)
      VALUES($1,$2,$3,$4,$5,$6)`,
      [eventId, recipient.accountId, recipient.reason, outcome, code, noticeId],
    );
  }
  async materialize(
    event: RatingNoticeEvent,
    recipient: RatingNoticeRecipient,
    tx: PoolClient,
  ): Promise<void> {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_notifications.rating_notices
      (id,event_id,recipient_account_id,kind,reason,region_id,target_id,root_id,reply_id,occurred_at,event_sequence)
      VALUES($1,$2,$3,'reply',$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        event.id,
        recipient.accountId,
        recipient.reason,
        event.target.regionId,
        event.target.targetId,
        event.target.rootId,
        event.target.replyId,
        event.occurredAt,
        event.sequence,
      ],
    );
    await this.settleRecipient(
      event.id,
      recipient,
      'materialized',
      null,
      tx,
      id,
    );
  }
  async existingLike(
    event: RatingLikeNoticeEvent,
    recipient: RatingLikeNoticeRecipient,
    tx: PoolClient,
  ): Promise<string | null> {
    const values = [
      recipient.accountId,
      event.actorAccountId,
      event.target.targetId,
      event.target.rootId,
    ];
    if (event.target.replyId !== null) values.push(event.target.replyId);
    return (
      (
        await tx.query<{ id: string }>(
          `SELECT id FROM whaleu_notifications.rating_notices WHERE kind='like' AND recipient_account_id=$1 AND like_actor_account_id=$2 AND target_id=$3 AND root_id=$4 AND ${event.target.replyId === null ? 'reply_id IS NULL' : 'reply_id=$5'}`,
          values,
        )
      ).rows[0]?.id ?? null
    );
  }
  async materializeLike(
    event: RatingLikeNoticeEvent,
    recipient: RatingLikeNoticeRecipient,
    tx: PoolClient,
  ): Promise<'materialized' | 'existing'> {
    // Caller holds the recipient owner after completing every source projection.
    const existing = await this.existingLike(event, recipient, tx);
    if (existing) {
      await this.settleRecipient(
        event.id,
        recipient,
        'existing',
        null,
        tx,
        existing,
      );
      return 'existing';
    }
    const id = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_notifications.rating_notices (id,event_id,recipient_account_id,kind,reason,region_id,target_id,root_id,reply_id,like_actor_account_id,occurred_at,event_sequence) VALUES($1,$2,$3,'like','like',$4,$5,$6,$7,$8,$9,$10)`,
      [
        id,
        event.id,
        recipient.accountId,
        event.target.regionId,
        event.target.targetId,
        event.target.rootId,
        event.target.replyId,
        event.actorAccountId,
        event.occurredAt,
        event.sequence,
      ],
    );
    await this.settleRecipient(
      event.id,
      recipient,
      'materialized',
      null,
      tx,
      id,
    );
    return 'materialized';
  }
  async retryable(
    eventId: string,
    code: string,
    tx: PoolClient,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO whaleu_notifications.rating_retry_attempts(event_id,attempts,code,last_attempt_at,next_attempt_at)
      VALUES($1,1,$2,clock_timestamp(),clock_timestamp()+interval '5 seconds') ON CONFLICT(event_id) DO UPDATE SET
      attempts=least(whaleu_notifications.rating_retry_attempts.attempts+1,2147483647),code=excluded.code,last_attempt_at=clock_timestamp(),
      next_attempt_at=clock_timestamp()+make_interval(secs=>least(60,5*power(2,least(4,whaleu_notifications.rating_retry_attempts.attempts)))::integer)`,
      [eventId, code],
    );
  }
}
