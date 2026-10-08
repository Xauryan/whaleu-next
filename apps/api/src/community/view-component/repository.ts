import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import type { StoredPost } from '../community.repository.js';
import { VIEW_LIMITS } from './contracts.js';
import type { ViewReportReceipt, ViewKind } from './contracts.js';
export interface StoredViewEpoch {
  id: string;
  account_id: string;
  issued_at: Date;
  collection_until: Date;
  expires_at: Date;
  batch_count: number;
  event_count: number;
}
@Injectable()
export class ViewComponentRepository {
  async budget(tx: PoolClient): Promise<void> {
    await tx.query("SET LOCAL transaction_timeout='5s'");
    await tx.query("SET LOCAL statement_timeout='3s'");
    await tx.query("SET LOCAL lock_timeout='1s'");
  }
  async now(tx: PoolClient): Promise<Date> {
    const now = (
      await tx.query<{ now: Date }>(
        "SELECT date_trunc('milliseconds',clock_timestamp()) AS now",
      )
    ).rows[0]?.now;
    if (!now || !Number.isFinite(now.getTime()))
      throw new ApplicationError('VIEW_REPORTING_UNAVAILABLE');
    return now;
  }
  async lockOwner(actor: string, tx: PoolClient): Promise<void> {
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `whaleu:view-owner:v1:${actor}`,
    ]);
  }
  async collecting(
    actor: string,
    tx: PoolClient,
  ): Promise<StoredViewEpoch | null> {
    return (
      (
        await tx.query<StoredViewEpoch>(
          `SELECT * FROM whaleu_post_hotness.view_reporting_epochs
       WHERE account_id=$1 AND collection_until>clock_timestamp() AND expires_at>clock_timestamp()
       ORDER BY issued_at DESC,id DESC LIMIT 1 FOR UPDATE`,
          [actor],
        )
      ).rows[0] ?? null
    );
  }
  async epoch(
    actor: string,
    epochId: string,
    tx: PoolClient,
  ): Promise<StoredViewEpoch | null> {
    return (
      (
        await tx.query<StoredViewEpoch>(
          'SELECT * FROM whaleu_post_hotness.view_reporting_epochs WHERE id=$1 AND account_id=$2 FOR UPDATE',
          [epochId, actor],
        )
      ).rows[0] ?? null
    );
  }
  async capacity(
    actor: string,
    tx: PoolClient,
  ): Promise<{ epochs: number; batches: number; events: number }> {
    const row = (
      await tx.query<{ epochs: string; batches: string; events: string }>(
        `SELECT count(*)::text AS epochs,coalesce(sum(batch_count),0)::text AS batches,
       coalesce(sum(event_count),0)::text AS events FROM whaleu_post_hotness.view_reporting_epochs
       WHERE account_id=$1 AND expires_at>clock_timestamp()`,
        [actor],
      )
    ).rows[0]!;
    // These totals have strict small per-epoch caps and at most 25 live epochs.
    return {
      epochs: Number(row.epochs),
      batches: Number(row.batches),
      events: Number(row.events),
    };
  }
  async createEpoch(
    actor: string,
    now: Date,
    tx: PoolClient,
  ): Promise<StoredViewEpoch> {
    return (
      await tx.query<StoredViewEpoch>(
        `INSERT INTO whaleu_post_hotness.view_reporting_epochs(id,account_id,issued_at,collection_until,expires_at)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
        [
          randomUUID(),
          actor,
          now,
          new Date(now.getTime() + VIEW_LIMITS.collectionMs),
          new Date(now.getTime() + VIEW_LIMITS.lifetimeMs),
        ],
      )
    ).rows[0]!;
  }
  async receipt(
    epochId: string,
    batchId: string,
    tx: PoolClient,
  ): Promise<ViewReportReceipt | null> {
    const row = (
      await tx.query<{
        kind: ViewKind;
        payload_fingerprint: string;
        accepted_count: number;
      }>(
        'SELECT kind,payload_fingerprint,accepted_count FROM whaleu_post_hotness.view_report_receipts WHERE epoch_id=$1 AND batch_id=$2',
        [epochId, batchId],
      )
    ).rows[0];
    return row
      ? {
          version: 1,
          epochId,
          batchId,
          kind: row.kind,
          payloadFingerprint: row.payload_fingerprint,
          acceptedCount: row.accepted_count,
        }
      : null;
  }
  async posts(ids: string[], tx: PoolClient): Promise<StoredPost[]> {
    // All parents are acquired before child/visibility work, in one stable order.
    return (
      await tx.query<StoredPost>(
        'SELECT * FROM whaleu_community.posts WHERE id=ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [ids],
      )
    ).rows;
  }
  async known(postId: string, tx: PoolClient): Promise<boolean> {
    return (
      (
        await tx.query(
          'SELECT post_id FROM whaleu_post_hotness.view_baselines WHERE post_id=$1',
          [postId],
        )
      ).rowCount === 1
    );
  }
  async countDetail(
    actor: string,
    postId: string,
    tx: PoolClient,
  ): Promise<boolean> {
    const prior = (
      await tx.query<{ next_allowed_at: Date }>(
        'SELECT next_allowed_at FROM whaleu_post_hotness.view_detail_cooldowns WHERE account_id=$1 AND post_id=$2 FOR UPDATE',
        [actor, postId],
      )
    ).rows[0];
    // Take the decision clock after any cooldown-row wait, never beforehand.
    const now = await this.now(tx);
    if (prior && prior.next_allowed_at.getTime() > now.getTime()) return false;
    const next = new Date(now.getTime() + VIEW_LIMITS.detailMs);
    if (prior)
      await tx.query(
        'UPDATE whaleu_post_hotness.view_detail_cooldowns SET next_allowed_at=$3 WHERE account_id=$1 AND post_id=$2',
        [actor, postId, next],
      );
    else
      await tx.query(
        'INSERT INTO whaleu_post_hotness.view_detail_cooldowns(account_id,post_id,next_allowed_at) VALUES($1,$2,$3)',
        [actor, postId, next],
      );
    return true;
  }
  async increment(
    postId: string,
    delta: number,
    tx: PoolClient,
  ): Promise<void> {
    const result = await tx.query(
      'UPDATE whaleu_post_hotness.view_states SET count=count+$2::bigint WHERE post_id=$1',
      [postId, delta],
    );
    if (result.rowCount !== 1)
      throw new ApplicationError('VIEW_REPORTING_UNAVAILABLE');
  }
  async accept(
    receipt: ViewReportReceipt,
    submitted: number,
    tx: PoolClient,
  ): Promise<void> {
    await tx.query(
      'UPDATE whaleu_post_hotness.view_reporting_epochs SET batch_count=batch_count+1,event_count=event_count+$2 WHERE id=$1',
      [receipt.epochId, submitted],
    );
    await tx.query(
      `INSERT INTO whaleu_post_hotness.view_report_receipts(epoch_id,batch_id,kind,payload_fingerprint,accepted_count)
       VALUES($1,$2,$3,$4,$5)`,
      [
        receipt.epochId,
        receipt.batchId,
        receipt.kind,
        receipt.payloadFingerprint,
        receipt.acceptedCount,
      ],
    );
  }
}
