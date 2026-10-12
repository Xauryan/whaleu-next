import { randomUUID } from 'node:crypto';
import { Injectable, Module } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { boundedOwnerProof } from '../../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
} from '../../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../../database/transaction-deadlines.js';
export interface MajorNoticeRow {
  id: string;
  event_id: string;
  kind: 'reply' | 'like';
  major_id: string;
  comment_id: string;
  root_id: string;
  actor_id: string;
  created_at: Date;
  read_at: Date | null;
  time: string;
}
const proof: RequiredTransactionProof<string> = {
  maximumFacts: 1,
  failureCode: 'MAJOR_DISCUSSION_HISTORY_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(
      tx,
      'MAJOR_DISCUSSION_HISTORY_UNAVAILABLE',
      async (read) => {
        await read.query(
          'LOCK TABLE whaleu_notifications.major_discussion_epoch,whaleu_notifications.major_discussion_notices,whaleu_notifications.major_discussion_reads IN SHARE MODE NOWAIT',
        );
        const epoch = (
          await read.query<{ revision: string }>(
            'SELECT revision::text FROM whaleu_notifications.major_discussion_epoch WHERE singleton',
          )
        ).rows[0]?.revision;
        if (!epoch || facts.some((f) => f !== epoch))
          throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
      },
    ),
};
/** Local obligations only. No provider, rewards, or generic lifetime dedupe. */
@Injectable()
export class MajorDiscussionNoticeOwner {
  async capture(actor: string, key: string, tx: PoolClient) {
    const rows = (
      await tx.query<{
        recipient_id: string;
        kind: string;
        event_id: string;
        major_id: string;
        comment_id: string;
        root_id: string;
      }>(
        'SELECT * FROM whaleu_notifications.major_discussion_expected($1,$2)',
        [actor, key],
      )
    ).rows;
    for (const row of rows)
      await tx.query(
        'INSERT INTO whaleu_notifications.major_discussion_notices(id,recipient_id,actor_id,request_id,kind,event_id,major_id,comment_id,root_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          randomUUID(),
          row.recipient_id,
          actor,
          key,
          row.kind,
          row.event_id,
          row.major_id,
          row.comment_id,
          row.root_id,
        ],
      );
  }
  async epoch(tx: PoolClient) {
    const row = (
      await tx.query<{ revision: string }>(
        'SELECT revision::text FROM whaleu_notifications.major_discussion_epoch WHERE singleton',
      )
    ).rows[0];
    if (!row)
      throw new ApplicationError('MAJOR_DISCUSSION_HISTORY_UNAVAILABLE');
    return row.revision;
  }
  async retain(epoch: string, tx: PoolClient) {
    if ((await this.epoch(tx)) !== epoch)
      throw new ApplicationError('DISCOVERY_RESTART_REQUIRED');
    enableRequiredTransactionProof(tx, proof);
    registerRequiredTransactionFact(tx, proof, 'notice-epoch', epoch);
  }
  async list(
    actor: string,
    limit: number,
    after: { time: string; id: string } | null,
    tx: PoolClient,
  ) {
    return (
      await tx.query<MajorNoticeRow>(
        `SELECT n.*,r.read_at,(extract(epoch FROM n.created_at)*1000000)::bigint::text time FROM whaleu_notifications.major_discussion_notices n LEFT JOIN whaleu_notifications.major_discussion_reads r ON r.notice_id=n.id WHERE n.recipient_id=$1 AND($2::uuid IS NULL OR(n.created_at,n.id)<(to_timestamp($3::numeric/1000000),$2::uuid)) ORDER BY n.created_at DESC,n.id DESC LIMIT $4`,
        [actor, after?.id ?? null, after?.time ?? null, limit + 1],
      )
    ).rows;
  }
  async unread(actor: string, tx: PoolClient) {
    return Number(
      (
        await tx.query<{ count: string }>(
          'SELECT count(*)::text count FROM whaleu_notifications.major_discussion_notices n WHERE recipient_id=$1 AND NOT EXISTS(SELECT 1 FROM whaleu_notifications.major_discussion_reads r WHERE r.notice_id=n.id)',
          [actor],
        )
      ).rows[0]!.count,
    );
  }
  async find(actor: string, id: string, tx: PoolClient) {
    const row = (
      await tx.query<MajorNoticeRow>(
        `SELECT n.*,r.read_at,(extract(epoch FROM n.created_at)*1000000)::bigint::text time FROM whaleu_notifications.major_discussion_notices n LEFT JOIN whaleu_notifications.major_discussion_reads r ON r.notice_id=n.id WHERE n.recipient_id=$1 AND n.id=$2`,
        [actor, id],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('MAJOR_DISCUSSION_NOTICE_NOT_FOUND');
    return row;
  }
  async read(actor: string, session: string, id: string, tx: PoolClient) {
    await this.find(actor, id, tx);
    await tx.query(
      'INSERT INTO whaleu_notifications.major_discussion_reads(notice_id,recipient_id,session_id) VALUES($1,$2,$3) ON CONFLICT(notice_id) DO NOTHING',
      [id, actor, session],
    );
    return (await this.find(actor, id, tx)).read_at!.toISOString();
  }
}
@Module({
  providers: [MajorDiscussionNoticeOwner],
  exports: [MajorDiscussionNoticeOwner],
})
export class MajorDiscussionNoticeModule {}
