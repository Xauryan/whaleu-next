import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import type { SocialSource } from '../../community/social-source/contracts.js';
import { socialKind } from './contracts.js';
import type { SocialCategory } from './contracts.js';
const instant = (name: string) =>
  `to_char(${name} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const columns = `id,source_id,recipient_account_id,kind,ordinal::text,${instant('created_at')} created_at,${instant('read_at')} read_at`;
export interface StoredSocialNotice {
  id: string;
  source_id: string;
  recipient_account_id: string;
  kind: SocialSource['kind'];
  ordinal: string;
  created_at: string;
  read_at: string | null;
}
export interface SocialSeek {
  beforeAt: string;
  beforeOrdinal: string;
}
export const socialDedupeKey = (source: SocialSource) =>
  createHash('sha256')
    .update(
      [
        'social-lifetime-v1',
        source.recipientAccountId,
        source.actorAccountId,
        source.kind,
        source.resourceKind,
        source.resourceId,
      ].join(':'),
    )
    .digest('hex');
@Injectable()
export class SocialUpdatesRepository {
  async owner(account: string, tx: PoolClient, write = false) {
    // The caller already owns its account fence. Never recreate an owner for a
    // cooling/erasing/completed recipient, including on a read-only endpoint.
    const accountState = (
      await tx.query<{ lifecycle: string }>(
        'SELECT lifecycle FROM whaleu_identity.accounts WHERE id=$1 FOR SHARE NOWAIT',
        [account],
      )
    ).rows[0];
    if (accountState?.lifecycle !== 'active')
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    await tx.query(
      'INSERT INTO whaleu_notifications.owners(account_id) VALUES($1) ON CONFLICT DO NOTHING',
      [account],
    );
    await tx.query(
      `SELECT account_id FROM whaleu_notifications.owners WHERE account_id=$1 FOR ${write ? 'UPDATE' : 'SHARE'} NOWAIT`,
      [account],
    );
  }
  async head(
    account: string,
    category: SocialCategory,
    tx: PoolClient,
  ): Promise<string> {
    return (
      (
        await tx.query<{ ordinal: string }>(
          'SELECT ordinal::text FROM whaleu_notifications.social_notices WHERE recipient_account_id=$1 AND kind=$2 ORDER BY social_notices.ordinal DESC LIMIT 1',
          [account, socialKind(category)],
        )
      ).rows[0]?.ordinal ?? '0'
    );
  }
  async page(
    account: string,
    category: SocialCategory,
    limit: number,
    before: SocialSeek | null,
    tx: PoolClient,
  ): Promise<StoredSocialNotice[]> {
    return (
      await tx.query<StoredSocialNotice>(
        `SELECT ${columns} FROM whaleu_notifications.social_notices WHERE recipient_account_id=$1 AND kind=$2 ${before === null ? '' : 'AND (created_at,ordinal)<($3::timestamptz,$4::bigint)'} ORDER BY social_notices.created_at DESC,social_notices.ordinal DESC LIMIT ${before === null ? '$3' : '$5'}`,
        before === null
          ? [account, socialKind(category), limit + 1]
          : [
              account,
              socialKind(category),
              before.beforeAt,
              before.beforeOrdinal,
              limit + 1,
            ],
      )
    ).rows;
  }
  async own(
    account: string,
    id: string,
    category: SocialCategory,
    tx: PoolClient,
  ): Promise<StoredSocialNotice> {
    const row = (
      await tx.query<StoredSocialNotice>(
        `SELECT ${columns} FROM whaleu_notifications.social_notices WHERE recipient_account_id=$1 AND id=$2 AND kind=$3`,
        [account, id, socialKind(category)],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('NOTICE_NOT_FOUND');
    return row;
  }
  async unread(
    account: string,
    category: SocialCategory,
    limit: number,
    tx: PoolClient,
    exclude: string | null = null,
  ): Promise<StoredSocialNotice[]> {
    return (
      await tx.query<StoredSocialNotice>(
        `SELECT ${columns} FROM whaleu_notifications.social_notices WHERE recipient_account_id=$1 AND kind=$2 AND read_at IS NULL AND ($4::uuid IS NULL OR id<>$4) ORDER BY social_notices.ordinal DESC LIMIT $3`,
        [account, socialKind(category), limit, exclude],
      )
    ).rows;
  }
  async pending(
    account: string,
    category: SocialCategory,
    tx: PoolClient,
  ): Promise<boolean> {
    return !!(
      await tx.query(
        "SELECT 1 FROM whaleu_notifications.social_work WHERE recipient_account_id=$1 AND kind=$2 AND state='pending' LIMIT 1",
        [account, socialKind(category)],
      )
    ).rowCount;
  }
  async markRead(
    account: string,
    id: string,
    category: SocialCategory,
    tx: PoolClient,
  ): Promise<StoredSocialNotice> {
    const row = await this.own(account, id, category, tx);
    if (row.read_at !== null) return row;
    const updated = (
      await tx.query<StoredSocialNotice>(
        `UPDATE whaleu_notifications.social_notices SET read_at=clock_timestamp() WHERE id=$1 AND recipient_account_id=$2 AND kind=$3 AND read_at IS NULL RETURNING ${columns}`,
        [id, account, socialKind(category)],
      )
    ).rows[0];
    if (!updated) throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return updated;
  }
  async receipt(sourceId: string, tx: PoolClient) {
    return (
      (
        await tx.query<{
          outcome: 'materialized' | 'existing' | 'account_deleted';
          notice_id: string | null;
        }>(
          'SELECT outcome,notice_id FROM whaleu_notifications.social_receipts WHERE source_id=$1',
          [sourceId],
        )
      ).rows[0] ?? null
    );
  }
  async workState(sourceId: string, tx: PoolClient) {
    return (
      (
        await tx.query<{ state: 'pending' | 'completed' }>(
          'SELECT state FROM whaleu_notifications.social_work WHERE source_id=$1',
          [sourceId],
        )
      ).rows[0]?.state ?? null
    );
  }
  async existing(source: SocialSource, tx: PoolClient) {
    return (
      (
        await tx.query<{ id: string }>(
          'SELECT id FROM whaleu_notifications.social_notices WHERE recipient_account_id=$1 AND kind=$2 AND dedupe_key=$3',
          [source.recipientAccountId, source.kind, socialDedupeKey(source)],
        )
      ).rows[0]?.id ?? null
    );
  }
  async settle(source: SocialSource, tx: PoolClient) {
    // Existing lifetime notice always wins, even when the re-event is now hidden.
    let noticeId = await this.existing(source, tx);
    const outcome: 'materialized' | 'existing' = noticeId
      ? 'existing'
      : 'materialized';
    if (outcome === 'materialized') {
      noticeId = randomUUID();
      await tx.query(
        'INSERT INTO whaleu_notifications.social_notices(id,source_id,recipient_account_id,kind,dedupe_key,created_at) VALUES($1,$2,$3,$4,$5,$6)',
        [
          noticeId,
          source.id,
          source.recipientAccountId,
          source.kind,
          socialDedupeKey(source),
          source.occurredAt,
        ],
      );
    }
    await tx.query(
      'INSERT INTO whaleu_notifications.social_receipts(source_id,recipient_account_id,kind,outcome,notice_id) VALUES($1,$2,$3,$4,$5)',
      [source.id, source.recipientAccountId, source.kind, outcome, noticeId],
    );
    const done = await tx.query(
      "UPDATE whaleu_notifications.social_work SET state='completed' WHERE source_id=$1 AND state='pending'",
      [source.id],
    );
    if (done.rowCount !== 1)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    return outcome;
  }
  async work(limit: number, tx: PoolClient) {
    return (
      await tx.query<{ source_id: string }>(
        "SELECT source_id FROM whaleu_notifications.social_work WHERE state='pending' AND automatic_eligible AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at,enrolled_at,source_id LIMIT $1",
        [limit],
      )
    ).rows;
  }
  async retry(id: string, tx: PoolClient) {
    await tx.query(
      "UPDATE whaleu_notifications.social_work SET attempts=least(attempts+1,2147483647),next_attempt_at=clock_timestamp()+make_interval(secs=>least(60,5*power(2,least(attempts,4)))::integer) WHERE source_id=$1 AND state='pending'",
      [id],
    );
  }
}
