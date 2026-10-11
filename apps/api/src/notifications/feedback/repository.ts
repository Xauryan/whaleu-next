import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import type { FeedbackPublicationNotice } from './contracts.js';

export interface StoredFeedbackNotice {
  id: string;
  post_id: string;
  recipient_account_id: string;
  recipient_grant_id: string;
  kind: 'feedback_created';
  created_at: Date;
  read_at: Date | null;
}
const columns =
  'id,post_id,recipient_account_id,recipient_grant_id,kind,created_at,read_at';

@Injectable()
export class FeedbackNoticesRepository {
  async owner(accountId: string, tx: PoolClient, write = false): Promise<void> {
    await tx.query(
      'INSERT INTO whaleu_notifications.feedback_notice_owners(account_id) VALUES($1) ON CONFLICT DO NOTHING',
      [accountId],
    );
    await tx.query(
      `SELECT account_id FROM whaleu_notifications.feedback_notice_owners WHERE account_id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`,
      [accountId],
    );
  }
  async rate(accountId: string, tx: PoolClient): Promise<void> {
    const result = await tx.query<{ hits: number }>(
      `INSERT INTO whaleu_notifications.feedback_notice_rate_buckets(account_id,window_start,hits)
       VALUES($1,date_trunc('minute',clock_timestamp()),1)
       ON CONFLICT(account_id) DO UPDATE SET window_start=date_trunc('minute',clock_timestamp()),
       hits=CASE WHEN whaleu_notifications.feedback_notice_rate_buckets.window_start=date_trunc('minute',clock_timestamp())
         THEN LEAST(whaleu_notifications.feedback_notice_rate_buckets.hits+1,1000000) ELSE 1 END RETURNING hits`,
      [accountId],
    );
    if (result.rows[0]!.hits > 120) throw new ApplicationError('RATE_LIMITED');
  }
  async count(accountId: string, tx: PoolClient): Promise<number> {
    return (
      await tx.query<{ count: number }>(
        'SELECT LEAST(count(*),2147483647)::integer AS count FROM whaleu_notifications.feedback_notices WHERE recipient_account_id=$1 AND read_at IS NULL',
        [accountId],
      )
    ).rows[0]!.count;
  }
  async page(
    accountId: string,
    limit: number,
    seek: { at: string; id: string } | null,
    tx: PoolClient,
  ): Promise<StoredFeedbackNotice[]> {
    return (
      await tx.query<StoredFeedbackNotice>(
        `SELECT ${columns} FROM whaleu_notifications.feedback_notices WHERE recipient_account_id=$1
       AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
       ORDER BY created_at DESC,id DESC LIMIT $4`,
        [accountId, seek?.at ?? null, seek?.id ?? null, limit + 1],
      )
    ).rows;
  }
  async own(
    accountId: string,
    noticeId: string,
    tx: PoolClient,
  ): Promise<StoredFeedbackNotice> {
    const row = (
      await tx.query<StoredFeedbackNotice>(
        `SELECT ${columns} FROM whaleu_notifications.feedback_notices WHERE id=$1 AND recipient_account_id=$2`,
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
  ): Promise<StoredFeedbackNotice> {
    const row = (
      await tx.query<StoredFeedbackNotice>(
        `UPDATE whaleu_notifications.feedback_notices SET read_at=COALESCE(read_at,date_trunc('milliseconds',clock_timestamp()))
       WHERE id=$1 AND recipient_account_id=$2 RETURNING ${columns}`,
        [noticeId, accountId],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('NOTICE_NOT_FOUND');
    return row;
  }
  async append(
    input: FeedbackPublicationNotice,
    recipientAccountId: string,
    recipientGrantId: string,
    tx: PoolClient,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO whaleu_notifications.feedback_notices(id,post_id,recipient_account_id,recipient_grant_id,kind,created_at)
       VALUES($1,$2,$3,$4,'feedback_created',$5) ON CONFLICT(post_id,recipient_account_id) DO NOTHING`,
      [
        randomUUID(),
        input.postId,
        recipientAccountId,
        recipientGrantId,
        input.occurredAt,
      ],
    );
    const row = (
      await tx.query<StoredFeedbackNotice>(
        `SELECT ${columns} FROM whaleu_notifications.feedback_notices WHERE post_id=$1 AND recipient_account_id=$2`,
        [input.postId, recipientAccountId],
      )
    ).rows[0];
    // A replacement grant never rewrites the historical recipient proof.
    if (
      !row ||
      row.kind !== 'feedback_created' ||
      row.created_at.getTime() !== input.occurredAt.getTime()
    )
      throw new ApplicationError('SYSTEM_NOTICES_UNAVAILABLE');
  }
}
