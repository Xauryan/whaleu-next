import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import type {
  RatingSubscriptionEpoch,
  RatingSubscriptionSource,
} from '../../ratings/updates-source/subscription-contracts.js';
export interface StoredRatingSubscriptionNotice {
  id: string;
  event_id: string;
  recipient_account_id: string;
  epoch_id: string;
  kind: 'subscription';
  reason: 'target_subscription';
  activity: 'root' | 'reply';
  region_id: string | null;
  target_id: string;
  root_id: string;
  reply_id: string | null;
  ordinal: string;
  created_at: string;
  read_at: string | null;
}
export interface RatingSubscriptionJob {
  event_id: string;
  last_page: number;
  cursor_order: string | null;
  cursor_epoch_id: string | null;
  scan_finished: boolean;
}
export interface RatingSubscriptionWork {
  event_id: string;
  recipient_account_id: string;
  epoch_id: string;
  target_id: string;
  page_number: number;
  status: 'pending' | 'retry' | 'materialized' | 'suppressed';
  attempts: number;
  code: string | null;
}
const instant = (c: string) =>
  `to_char(${c} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const columns = `id,event_id,recipient_account_id,epoch_id,kind,reason,activity,region_id,target_id,root_id,reply_id,ordinal::text,${instant('created_at')} created_at,${instant('read_at')} read_at`;
@Injectable()
export class RatingSubscriptionUpdatesRepository {
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
  async page(
    accountId: string,
    limit: number,
    before: string | null,
    tx: PoolClient,
  ): Promise<StoredRatingSubscriptionNotice[]> {
    return (
      await tx.query<StoredRatingSubscriptionNotice>(
        `SELECT ${columns} FROM whaleu_notifications.rating_subscription_notices n WHERE n.recipient_account_id=$1 AND ($2::bigint IS NULL OR n.ordinal<$2::bigint) ORDER BY n.ordinal DESC LIMIT $3`,
        [accountId, before, limit + 1],
      )
    ).rows;
  }
  async own(
    accountId: string,
    noticeId: string,
    tx: PoolClient,
  ): Promise<StoredRatingSubscriptionNotice> {
    const row = (
      await tx.query<StoredRatingSubscriptionNotice>(
        `SELECT ${columns} FROM whaleu_notifications.rating_subscription_notices WHERE id=$1 AND recipient_account_id=$2`,
        [noticeId, accountId],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('NOTICE_NOT_FOUND');
    return row;
  }
  async states(
    accountId: string,
    ids: readonly string[],
    tx: PoolClient,
  ): Promise<Map<string, string | null>> {
    if (!ids.length) return new Map();
    const rows = (
      await tx.query<{ id: string; read_at: string | null }>(
        `SELECT id,${instant('read_at')} read_at FROM whaleu_notifications.rating_subscription_notices WHERE recipient_account_id=$1 AND id=ANY($2::uuid[])`,
        [accountId, ids],
      )
    ).rows;
    if (rows.length !== ids.length)
      throw new ApplicationError('RATING_UNAVAILABLE');
    return new Map(rows.map((r) => [r.id, r.read_at]));
  }
  async count(accountId: string, tx: PoolClient) {
    return (
      await tx.query<{ count: number }>(
        'SELECT count(*)::integer count FROM whaleu_notifications.rating_subscription_notices WHERE recipient_account_id=$1 AND read_at IS NULL',
        [accountId],
      )
    ).rows[0]!.count;
  }
  async markRead(accountId: string, noticeId: string, tx: PoolClient) {
    const row = await this.own(accountId, noticeId, tx);
    if (row.read_at !== null) return row;
    const updated = (
      await tx.query<StoredRatingSubscriptionNotice>(
        `UPDATE whaleu_notifications.rating_subscription_notices SET read_at=clock_timestamp() WHERE id=$1 AND recipient_account_id=$2 AND read_at IS NULL RETURNING ${columns}`,
        [noticeId, accountId],
      )
    ).rows[0];
    if (!updated) throw new ApplicationError('RATING_UNAVAILABLE');
    return updated;
  }
  async completed(eventId: string, tx: PoolClient): Promise<boolean> {
    return !!(
      await tx.query(
        'SELECT event_id FROM whaleu_notifications.rating_subscription_event_receipts WHERE event_id=$1',
        [eventId],
      )
    ).rows[0];
  }
  async job(
    eventId: string,
    tx: PoolClient,
    write = false,
  ): Promise<RatingSubscriptionJob> {
    const row = (
      await tx.query<RatingSubscriptionJob>(
        `SELECT event_id,last_page,cursor_order::text,cursor_epoch_id,scan_finished FROM whaleu_notifications.rating_subscription_fanout_jobs WHERE event_id=$1${write ? ' FOR UPDATE' : ''}`,
        [eventId],
      )
    ).rows[0];
    if (!row) throw new Error('Subscription job missing');
    return row;
  }
  async addPage(
    job: RatingSubscriptionJob,
    raw: readonly RatingSubscriptionEpoch[],
    tx: PoolClient,
  ) {
    if (raw.length > 51) throw new Error('Subscription raw page bound');
    const selected = raw.slice(0, 50),
      last = selected.at(-1);
    const inserted = await tx.query<{ event_id: string; page_number: number }>(
      `INSERT INTO whaleu_notifications.rating_subscription_fanout_pages(event_id,page_number,before_order,before_epoch_id,through_order,through_epoch_id,raw_epoch_ids,raw_count,scan_finished) VALUES($1,$2,$3,$4,$5,$6,$7::uuid[],$8,$9) RETURNING event_id,page_number`,
      [
        job.event_id,
        job.last_page + 1,
        job.cursor_order,
        job.cursor_epoch_id,
        last?.startOrder ?? job.cursor_order,
        last?.epochId ?? job.cursor_epoch_id,
        selected.map((r) => r.epochId),
        selected.length,
        raw.length <= 50,
      ],
    );
    if (
      inserted.rowCount !== 1 ||
      inserted.rows[0]?.event_id !== job.event_id ||
      inserted.rows[0]?.page_number !== job.last_page + 1
    )
      throw new Error('Subscription page was not persisted');
  }
  async nextWork(
    eventId: string,
    tx: PoolClient,
  ): Promise<RatingSubscriptionWork | null> {
    return (
      (
        await tx.query<RatingSubscriptionWork>(
          `SELECT * FROM whaleu_notifications.rating_subscription_recipient_work WHERE event_id=$1 AND status IN ('pending','retry') AND (next_attempt_at IS NULL OR next_attempt_at<=clock_timestamp()) ORDER BY next_attempt_at NULLS FIRST,recipient_account_id LIMIT 1`,
          [eventId],
        )
      ).rows[0] ?? null
    );
  }
  async pending(
    eventId: string,
    limit: number,
    tx: PoolClient,
  ): Promise<RatingSubscriptionWork[]> {
    return (
      await tx.query<RatingSubscriptionWork>(
        `SELECT * FROM whaleu_notifications.rating_subscription_recipient_work WHERE event_id=$1 AND status IN ('pending','retry') ORDER BY recipient_account_id LIMIT $2`,
        [eventId, limit],
      )
    ).rows;
  }
  async work(
    eventId: string,
    accountId: string,
    tx: PoolClient,
  ): Promise<RatingSubscriptionWork | null> {
    return (
      (
        await tx.query<RatingSubscriptionWork>(
          'SELECT * FROM whaleu_notifications.rating_subscription_recipient_work WHERE event_id=$1 AND recipient_account_id=$2',
          [eventId, accountId],
        )
      ).rows[0] ?? null
    );
  }
  async retry(work: RatingSubscriptionWork, code: string, tx: PoolClient) {
    const updated = await tx.query<{
      event_id: string;
      recipient_account_id: string;
      status: string;
    }>(
      `UPDATE whaleu_notifications.rating_subscription_recipient_work SET status='retry',attempts=least(attempts::bigint+1,2147483647),code=$3,next_attempt_at=clock_timestamp()+interval '5 seconds' WHERE event_id=$1 AND recipient_account_id=$2 AND status IN ('pending','retry') RETURNING event_id,recipient_account_id,status`,
      [work.event_id, work.recipient_account_id, code],
    );
    if (
      updated.rowCount !== 1 ||
      updated.rows[0]?.event_id !== work.event_id ||
      updated.rows[0]?.recipient_account_id !== work.recipient_account_id ||
      updated.rows[0]?.status !== 'retry'
    )
      throw new Error('Subscription retry was not persisted');
  }
  async settle(
    work: RatingSubscriptionWork,
    outcome: 'materialized' | 'suppressed',
    code: string | null,
    noticeId: string | null,
    tx: PoolClient,
  ) {
    await tx.query(
      `INSERT INTO whaleu_notifications.rating_subscription_processing_receipts(event_id,recipient_account_id,epoch_id,outcome,code,notice_id) VALUES($1,$2,$3,$4,$5,$6)`,
      [
        work.event_id,
        work.recipient_account_id,
        work.epoch_id,
        outcome,
        code,
        noticeId,
      ],
    );
    await tx.query(
      `UPDATE whaleu_notifications.rating_subscription_recipient_work SET status=$3,attempts=least(attempts::bigint+1,2147483647),code=$4,next_attempt_at=NULL WHERE event_id=$1 AND recipient_account_id=$2`,
      [work.event_id, work.recipient_account_id, outcome, code],
    );
  }
  async materialize(
    event: RatingSubscriptionSource,
    work: RatingSubscriptionWork,
    tx: PoolClient,
  ) {
    const id = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_notifications.rating_subscription_notices(id,event_id,recipient_account_id,epoch_id,activity,region_id,target_id,root_id,reply_id,occurred_at,event_sequence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        id,
        event.id,
        work.recipient_account_id,
        work.epoch_id,
        event.activity,
        event.target.regionId,
        event.target.targetId,
        event.target.rootId,
        event.target.replyId,
        event.occurredAt,
        event.sequence,
      ],
    );
    await this.settle(work, 'materialized', null, id, tx);
  }
  async status(
    eventId: string,
    tx: PoolClient,
  ): Promise<{ scanFinished: boolean; pending: boolean; retryable: boolean }> {
    const job = await this.job(eventId, tx);
    const row = (
      await tx.query<{ pending: boolean; retryable: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM whaleu_notifications.rating_subscription_recipient_work WHERE event_id=$1 AND status IN ('pending','retry')) pending,EXISTS(SELECT 1 FROM whaleu_notifications.rating_subscription_recipient_work WHERE event_id=$1 AND status='retry') retryable`,
        [eventId],
      )
    ).rows[0]!;
    return { scanFinished: job.scan_finished, ...row };
  }
  async finish(eventId: string, tx: PoolClient): Promise<boolean> {
    const state = await this.status(eventId, tx);
    if (!state.scanFinished || state.pending) return false;
    const inserted = await tx.query<{ event_id: string }>(
      'INSERT INTO whaleu_notifications.rating_subscription_event_receipts(event_id) VALUES($1) RETURNING event_id',
      [eventId],
    );
    if (inserted.rowCount !== 1 || inserted.rows[0]?.event_id !== eventId)
      throw new Error('Subscription completion was not persisted');
    return true;
  }
}
