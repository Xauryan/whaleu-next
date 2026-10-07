import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  CommunityUpdateEvent,
  CommunityUpdateRecipient,
} from '../community/updates.facade.js';
import { ApplicationError } from '../http/application-error.js';
export interface StoredNotice {
  id: string;
  event_id: string;
  recipient_account_id: string;
  kind: 'root' | 'reply';
  reason: 'direct' | 'saved';
  save_epoch_id: string | null;
  post_id: string;
  comment_id: string;
  reply_id: string | null;
  created_at: Date;
  read_at: Date | null;
}
@Injectable()
export class NotificationsRepository {
  async discoveryCursor(tx: PoolClient): Promise<string> {
    await tx.query(
      "INSERT INTO whaleu_notifications.dispatcher_state(name) VALUES('community') ON CONFLICT DO NOTHING",
    );
    return (
      await tx.query<{ discovery_cursor: string }>(
        "SELECT discovery_cursor FROM whaleu_notifications.dispatcher_state WHERE name='community' FOR UPDATE",
      )
    ).rows[0]!.discovery_cursor;
  }
  async enqueueAutomatic(
    rows: { event_id: string; enrollment_order: string }[],
    tx: PoolClient,
  ) {
    for (const row of rows)
      await tx.query(
        'INSERT INTO whaleu_notifications.automatic_work(event_id) VALUES($1) ON CONFLICT DO NOTHING',
        [row.event_id],
      );
    const last = rows.at(-1);
    if (last)
      await tx.query(
        "UPDATE whaleu_notifications.dispatcher_state SET discovery_cursor=$1 WHERE name='community'",
        [last.enrollment_order],
      );
  }
  async pendingAutomatic(limit: number, tx: PoolClient) {
    return (
      await tx.query<{ event_id: string }>(
        `SELECT work.event_id FROM whaleu_notifications.automatic_work work
      LEFT JOIN whaleu_notifications.retryable_attempts retry USING(event_id)
      WHERE work.state='pending' AND (retry.next_attempt_at IS NULL OR retry.next_attempt_at<=clock_timestamp())
      ORDER BY work.enrolled_at,work.event_id LIMIT $1`,
        [limit],
      )
    ).rows;
  }
  async finishAutomatic(eventId: string, tx: PoolClient) {
    await tx.query(
      "UPDATE whaleu_notifications.automatic_work SET state='completed',completed_at=clock_timestamp() WHERE event_id=$1 AND state='pending'",
      [eventId],
    );
  }
  async retryable(eventId: string, code: string, tx: PoolClient) {
    await tx.query(
      `INSERT INTO whaleu_notifications.retryable_attempts(event_id,attempts,code,next_attempt_at)
      VALUES($1,1,$2,clock_timestamp()+interval '5 seconds') ON CONFLICT(event_id) DO UPDATE SET
      attempts=whaleu_notifications.retryable_attempts.attempts+1,code=excluded.code,last_attempt_at=clock_timestamp(),
      next_attempt_at=clock_timestamp()+make_interval(secs=>least(60,5*power(2,least(4,whaleu_notifications.retryable_attempts.attempts)))::integer)`,
      [eventId, code],
    );
  }
  async retryDue(eventId: string, tx: PoolClient): Promise<boolean> {
    return !(
      await tx.query(
        'SELECT 1 FROM whaleu_notifications.retryable_attempts WHERE event_id=$1 AND next_attempt_at>clock_timestamp()',
        [eventId],
      )
    ).rowCount;
  }
  async owner(accountId: string, tx: PoolClient, write = false) {
    await tx.query(
      'INSERT INTO whaleu_notifications.owners(account_id) VALUES($1) ON CONFLICT DO NOTHING',
      [accountId],
    );
    await tx.query(
      `SELECT account_id FROM whaleu_notifications.owners WHERE account_id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`,
      [accountId],
    );
  }
  async count(accountId: string, tx: PoolClient): Promise<number> {
    return (
      await tx.query<{ count: number }>(
        'SELECT count(*)::integer AS count FROM whaleu_notifications.notices WHERE recipient_account_id=$1 AND read_at IS NULL',
        [accountId],
      )
    ).rows[0]!.count;
  }
  async page(
    accountId: string,
    limit: number,
    seek: { at: string; id: string } | null,
    tx: PoolClient,
  ): Promise<StoredNotice[]> {
    return (
      await tx.query<StoredNotice>(
        'SELECT * FROM whaleu_notifications.notices WHERE recipient_account_id=$1 AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid)) ORDER BY created_at DESC,id DESC LIMIT $4',
        [accountId, seek?.at ?? null, seek?.id ?? null, limit + 1],
      )
    ).rows;
  }
  async own(
    accountId: string,
    noticeId: string,
    tx: PoolClient,
  ): Promise<StoredNotice> {
    const row = (
      await tx.query<StoredNotice>(
        'SELECT * FROM whaleu_notifications.notices WHERE id=$1 AND recipient_account_id=$2',
        [noticeId, accountId],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('NOTICE_NOT_FOUND');
    return row;
  }
  async markRead(
    accountId: string,
    noticeId: string,
    tx: PoolClient,
  ): Promise<StoredNotice> {
    const row = await this.own(accountId, noticeId, tx);
    if (row.read_at) return row;
    return (
      await tx.query<StoredNotice>(
        "UPDATE whaleu_notifications.notices SET read_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=$1 AND recipient_account_id=$2 AND read_at IS NULL RETURNING *",
        [noticeId, accountId],
      )
    ).rows[0]!;
  }
  async eventReceipt(eventId: string, tx: PoolClient) {
    return (
      (
        await tx.query<{ outcome: string; code: string | null }>(
          'SELECT outcome,code FROM whaleu_notifications.event_receipts WHERE event_id=$1',
          [eventId],
        )
      ).rows[0] ?? null
    );
  }
  async settleEvent(
    eventId: string,
    outcome: 'processed' | 'ignored' | 'unavailable',
    code: string | null,
    tx: PoolClient,
  ) {
    await tx.query(
      'INSERT INTO whaleu_notifications.event_receipts(event_id,outcome,code) VALUES($1,$2,$3)',
      [eventId, outcome, code],
    );
  }
  async settleRecipient(
    eventId: string,
    recipient: CommunityUpdateRecipient,
    channel: 'in_app' | 'external',
    outcome: 'materialized' | 'suppressed' | 'unavailable',
    code: string | null,
    tx: PoolClient,
  ) {
    await tx.query(
      'INSERT INTO whaleu_notifications.processing_receipts(event_id,recipient_account_id,channel,reason,save_epoch_id,outcome,code) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [
        eventId,
        recipient.accountId,
        channel,
        recipient.reason,
        recipient.saveEpochId,
        outcome,
        code,
      ],
    );
  }
  async materialize(
    event: CommunityUpdateEvent,
    recipient: CommunityUpdateRecipient,
    tx: PoolClient,
  ) {
    await this.settleRecipient(
      event.id,
      recipient,
      'in_app',
      'materialized',
      null,
      tx,
    );
    await tx.query(
      `INSERT INTO whaleu_notifications.notices(id,event_id,recipient_account_id,kind,reason,save_epoch_id,post_id,comment_id,reply_id,occurred_at,event_sequence)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        randomUUID(),
        event.id,
        recipient.accountId,
        event.kind,
        recipient.reason,
        recipient.saveEpochId,
        event.target.postId,
        event.target.commentId,
        event.target.replyId,
        event.occurredAt,
        event.sequence,
      ],
    );
  }
}
