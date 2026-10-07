import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import type { PostJuryRemovalNotice } from './contracts.js';

export interface StoredSystemNotice {
  id: string;
  decision_id: string;
  recipient_account_id: string;
  kind: 'post_jury_removed';
  keep_votes: number;
  remove_votes: number;
  created_at: Date;
  read_at: Date | null;
}

@Injectable()
export class SystemNoticesRepository {
  async owner(accountId: string, tx: PoolClient, write = false) {
    await tx.query(
      'INSERT INTO whaleu_notifications.system_notice_owners(account_id) VALUES($1) ON CONFLICT DO NOTHING',
      [accountId],
    );
    await tx.query(
      `SELECT account_id FROM whaleu_notifications.system_notice_owners WHERE account_id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`,
      [accountId],
    );
  }
  async rate(accountId: string, tx: PoolClient) {
    // One row per account, overwritten each minute: no growing window history.
    const result = await tx.query<{ hits: number }>(
      `INSERT INTO whaleu_notifications.system_notice_rate_buckets(account_id,window_start,hits)
       VALUES($1,date_trunc('minute',clock_timestamp()),1)
       ON CONFLICT(account_id) DO UPDATE SET window_start=date_trunc('minute',clock_timestamp()),
       hits=CASE WHEN whaleu_notifications.system_notice_rate_buckets.window_start=date_trunc('minute',clock_timestamp())
         THEN LEAST(whaleu_notifications.system_notice_rate_buckets.hits+1,1000000) ELSE 1 END RETURNING hits`,
      [accountId],
    );
    if (result.rows[0]!.hits > 120) throw new ApplicationError('RATE_LIMITED');
  }
  async count(accountId: string, tx: PoolClient): Promise<number> {
    return (
      await tx.query<{ count: number }>(
        'SELECT LEAST(count(*),2147483647)::integer AS count FROM whaleu_notifications.system_notices WHERE recipient_account_id=$1 AND read_at IS NULL',
        [accountId],
      )
    ).rows[0]!.count;
  }
  async page(
    accountId: string,
    limit: number,
    seek: { at: string; id: string } | null,
    tx: PoolClient,
  ): Promise<StoredSystemNotice[]> {
    return (
      await tx.query<StoredSystemNotice>(
        `SELECT id,decision_id,recipient_account_id,kind,keep_votes,remove_votes,created_at,read_at
       FROM whaleu_notifications.system_notices WHERE recipient_account_id=$1
       AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::uuid))
       ORDER BY created_at DESC,id DESC LIMIT $4`,
        [accountId, seek?.at ?? null, seek?.id ?? null, limit + 1],
      )
    ).rows;
  }
  async markRead(
    accountId: string,
    noticeId: string,
    tx: PoolClient,
  ): Promise<StoredSystemNotice> {
    // The owner UPDATE lock serializes read changes and appends. COALESCE keeps
    // the first read timestamp stable on retries, including concurrent retries.
    const row = (
      await tx.query<StoredSystemNotice>(
        `UPDATE whaleu_notifications.system_notices
       SET read_at=COALESCE(read_at,date_trunc('milliseconds',clock_timestamp()))
       WHERE id=$1 AND recipient_account_id=$2
       RETURNING id,decision_id,recipient_account_id,kind,keep_votes,remove_votes,created_at,read_at`,
        [noticeId, accountId],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('NOTICE_NOT_FOUND');
    return row;
  }
  async append(input: PostJuryRemovalNotice, tx: PoolClient): Promise<void> {
    await tx.query(
      `INSERT INTO whaleu_notifications.system_notices(id,decision_id,recipient_account_id,kind,keep_votes,remove_votes,created_at)
       VALUES($1,$2,$3,'post_jury_removed',$4,$5,$6)
       ON CONFLICT(decision_id,recipient_account_id) DO NOTHING`,
      [
        randomUUID(),
        input.decisionId,
        input.ownerAccountId,
        input.keepVotes,
        input.removeVotes,
        input.occurredAt,
      ],
    );
    const row = (
      await tx.query<StoredSystemNotice>(
        `SELECT id,decision_id,recipient_account_id,kind,keep_votes,remove_votes,created_at,read_at
       FROM whaleu_notifications.system_notices WHERE decision_id=$1 AND recipient_account_id=$2`,
        [input.decisionId, input.ownerAccountId],
      )
    ).rows[0];
    if (
      !row ||
      row.kind !== 'post_jury_removed' ||
      row.keep_votes !== input.keepVotes ||
      row.remove_votes !== input.removeVotes ||
      row.created_at.getTime() !== input.occurredAt.getTime()
    ) {
      // Idempotent replay may not silently replace or reinterpret immutable data.
      throw new ApplicationError('SYSTEM_NOTICES_UNAVAILABLE');
    }
  }
}
