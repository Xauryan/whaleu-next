import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import type { PostJuryRemovalNotice, SystemNoticeKind } from './contracts.js';
import type { SystemNoticesSeek } from './cursor.js';

interface StoredSystemNoticeBase {
  id: string;
  recipient_account_id: string;
  created_at: Date;
  read_at: Date | null;
}
export interface StoredPostJuryRemovalNotice extends StoredSystemNoticeBase {
  decision_id: string;
  kind: 'post_jury_removed';
  keep_votes: number;
  remove_votes: number;
}
export interface StoredProfileNicknameResetNotice extends StoredSystemNoticeBase {
  event_id: string;
  kind: 'profile_nickname_reset';
  nickname: string;
}
export interface StoredProfileCustomAvatarClearedNotice extends StoredSystemNoticeBase {
  event_id: string;
  kind: 'profile_custom_avatar_cleared';
}
export interface StoredAdminPostRemovedNotice extends StoredSystemNoticeBase {
  event_id: string;
  kind: 'admin_post_removed';
}
export type StoredSystemNotice =
  | StoredPostJuryRemovalNotice
  | StoredProfileNicknameResetNotice
  | StoredProfileCustomAvatarClearedNotice
  | StoredAdminPostRemovedNotice;

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
        `SELECT LEAST(sum(unread_count),2147483647)::integer AS count FROM (
          SELECT count(*) AS unread_count FROM whaleu_notifications.system_notices
          WHERE recipient_account_id=$1 AND read_at IS NULL
          UNION ALL
          SELECT count(*) AS unread_count FROM whaleu_notifications.profile_moderation_notices
          WHERE recipient_account_id=$1 AND read_at IS NULL
          UNION ALL
          SELECT count(*) AS unread_count FROM whaleu_notifications.profile_avatar_moderation_notices
          WHERE recipient_account_id=$1 AND read_at IS NULL
          UNION ALL
          SELECT count(*) AS unread_count FROM whaleu_notifications.admin_post_removal_notices
          WHERE recipient_account_id=$1 AND read_at IS NULL
        ) notices`,
        [accountId],
      )
    ).rows[0]!.count;
  }
  async page(
    accountId: string,
    limit: number,
    seek: SystemNoticesSeek | null,
    tx: PoolClient,
  ): Promise<StoredSystemNotice[]> {
    return (
      await tx.query<StoredSystemNotice>(
        `SELECT * FROM (
          (SELECT id,decision_id,NULL::uuid AS event_id,recipient_account_id,kind,
            keep_votes,remove_votes,NULL::text AS nickname,created_at,read_at
          FROM whaleu_notifications.system_notices WHERE recipient_account_id=$1
          AND ($2::timestamptz IS NULL OR (created_at,id,kind COLLATE "C")<($2::timestamptz,$3::uuid,$4::text COLLATE "C"))
          ORDER BY created_at DESC,id DESC,kind COLLATE "C" DESC LIMIT $5)
          UNION ALL
          (SELECT id,NULL::uuid AS decision_id,event_id,recipient_account_id,kind,
            NULL::integer AS keep_votes,NULL::integer AS remove_votes,nickname,created_at,read_at
          FROM whaleu_notifications.profile_moderation_notices WHERE recipient_account_id=$1
          AND ($2::timestamptz IS NULL OR (created_at,id,kind COLLATE "C")<($2::timestamptz,$3::uuid,$4::text COLLATE "C"))
          ORDER BY created_at DESC,id DESC,kind COLLATE "C" DESC LIMIT $5)
          UNION ALL
          (SELECT id,NULL::uuid AS decision_id,event_id,recipient_account_id,kind,
            NULL::integer AS keep_votes,NULL::integer AS remove_votes,NULL::text AS nickname,created_at,read_at
          FROM whaleu_notifications.profile_avatar_moderation_notices WHERE recipient_account_id=$1
          AND ($2::timestamptz IS NULL OR (created_at,id,kind COLLATE "C")<($2::timestamptz,$3::uuid,$4::text COLLATE "C"))
          ORDER BY created_at DESC,id DESC,kind COLLATE "C" DESC LIMIT $5)
          UNION ALL
          (SELECT id,NULL::uuid AS decision_id,event_id,recipient_account_id,kind,
            NULL::integer AS keep_votes,NULL::integer AS remove_votes,NULL::text AS nickname,created_at,read_at
          FROM whaleu_notifications.admin_post_removal_notices WHERE recipient_account_id=$1
          AND ($2::timestamptz IS NULL OR (created_at,id,kind COLLATE "C")<($2::timestamptz,$3::uuid,$4::text COLLATE "C"))
          ORDER BY created_at DESC,id DESC,kind COLLATE "C" DESC LIMIT $5)
        ) notices ORDER BY created_at DESC,id DESC,kind COLLATE "C" DESC LIMIT $5`,
        [
          accountId,
          seek?.at ?? null,
          seek?.id ?? null,
          seek?.kind ?? null,
          limit + 1,
        ],
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
    // The mandatory cross-table registry makes this UUID route unambiguous even
    // for deliberately colliding IDs, without relying on random UUID chance.
    const identity = (
      await tx.query<{ kind: SystemNoticeKind }>(
        `SELECT kind FROM whaleu_notifications.system_notice_ids
         WHERE id=$1 AND recipient_account_id=$2`,
        [noticeId, accountId],
      )
    ).rows[0];
    if (!identity) throw new ApplicationError('NOTICE_NOT_FOUND');
    let statement: string;
    if (identity.kind === 'post_jury_removed') {
      statement = `UPDATE whaleu_notifications.system_notices
       SET read_at=COALESCE(read_at,date_trunc('milliseconds',clock_timestamp()))
       WHERE id=$1 AND recipient_account_id=$2
       RETURNING id,decision_id,recipient_account_id,kind,keep_votes,remove_votes,created_at,read_at`;
    } else if (identity.kind === 'profile_nickname_reset') {
      statement = `UPDATE whaleu_notifications.profile_moderation_notices
       SET read_at=COALESCE(read_at,date_trunc('milliseconds',clock_timestamp()))
       WHERE id=$1 AND recipient_account_id=$2
       RETURNING id,event_id,recipient_account_id,kind,nickname,created_at,read_at`;
    } else if (identity.kind === 'profile_custom_avatar_cleared') {
      statement = `UPDATE whaleu_notifications.profile_avatar_moderation_notices
       SET read_at=COALESCE(read_at,date_trunc('milliseconds',clock_timestamp()))
       WHERE id=$1 AND recipient_account_id=$2
       RETURNING id,event_id,recipient_account_id,kind,created_at,read_at`;
    } else if (identity.kind === 'admin_post_removed') {
      statement = `UPDATE whaleu_notifications.admin_post_removal_notices
       SET read_at=COALESCE(read_at,date_trunc('milliseconds',clock_timestamp()))
       WHERE id=$1 AND recipient_account_id=$2
       RETURNING id,event_id,recipient_account_id,kind,created_at,read_at`;
    } else {
      throw new ApplicationError('SYSTEM_NOTICES_UNAVAILABLE');
    }
    const row = (
      await tx.query<StoredSystemNotice>(statement, [noticeId, accountId])
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
      await tx.query<StoredPostJuryRemovalNotice>(
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
