import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { APP_CONFIG } from '../../config/config.js';
import type { RuntimeConfig } from '../../config/config.js';
import { ApplicationError } from '../../http/application-error.js';
import type { ReportTarget } from './contracts.js';
export interface ReportCase {
  id: string;
  kind: ReportTarget['kind'];
  target_id: string;
  post_id: string;
  root_id: string | null;
  reply_id: string | null;
  owner_account_id: string;
  content_digest: string;
  report_count: number;
  effective_weight: number;
  state: 'open' | 'jury' | 'kept' | 'removed' | 'superseded';
}
export interface PostJury {
  id: string;
  case_id: string;
  post_id: string;
  content_digest: string;
  created_at: Date;
  deadline: Date;
  state: 'pending' | 'kept' | 'removed' | 'superseded';
  decision_id: string | null;
}
@Injectable()
export class ReportsRepository {
  constructor(@Inject(APP_CONFIG) private readonly config: RuntimeConfig) {}
  async case(target: ReportTarget, tx: PoolClient, write = false) {
    return (
      (
        await tx.query<ReportCase>(
          `SELECT * FROM whaleu_safety.report_cases WHERE kind=$1 AND target_id=$2 FOR ${write ? 'UPDATE' : 'SHARE'}`,
          [target.kind, target.id],
        )
      ).rows[0] ?? null
    );
  }
  async jury(postId: string, tx: PoolClient, write = false) {
    return (
      (
        await tx.query<PostJury>(
          `SELECT * FROM whaleu_safety.post_juries WHERE post_id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`,
          [postId],
        )
      ).rows[0] ?? null
    );
  }
  async ballots(juryId: string, actor: string | null, tx: PoolClient) {
    const row = (
      await tx.query<{
        keep: number;
        remove: number;
        own: 'keep' | 'remove' | null;
      }>(
        `SELECT count(*) FILTER(WHERE vote='keep')::integer AS keep,count(*) FILTER(WHERE vote='remove')::integer AS remove,max(vote) FILTER(WHERE account_id=$2) AS own FROM whaleu_safety.jury_ballots WHERE jury_id=$1`,
        [juryId, actor],
      )
    ).rows[0]!;
    return row;
  }
  async reported(caseId: string, actor: string, tx: PoolClient) {
    return !!(
      await tx.query(
        'SELECT 1 FROM whaleu_safety.reports WHERE case_id=$1 AND account_id=$2',
        [caseId, actor],
      )
    ).rowCount;
  }
  async rate(
    actor: string,
    action: 'report' | 'vote' | 'read',
    tx: PoolClient,
  ) {
    const cap =
      action === 'report'
        ? this.config.SAFETY_REPORTS_PER_MINUTE
        : action === 'vote'
          ? this.config.SAFETY_VOTES_PER_MINUTE
          : this.config.SAFETY_REPORT_READS_PER_MINUTE;
    const row = (
      await tx.query<{ hits: number }>(
        `INSERT INTO whaleu_safety.report_rate_buckets(account_id,action,window_start,hits) VALUES($1,$2,date_trunc('minute',clock_timestamp()),1) ON CONFLICT(account_id,action) DO UPDATE SET window_start=date_trunc('minute',clock_timestamp()),hits=CASE WHEN whaleu_safety.report_rate_buckets.window_start=date_trunc('minute',clock_timestamp()) THEN LEAST(whaleu_safety.report_rate_buckets.hits+1,1000000) ELSE 1 END RETURNING hits`,
        [actor, action],
      )
    ).rows[0]!;
    if (row.hits > cap) throw new ApplicationError('RATE_LIMITED');
  }
  async targetRate(actor: string, target: ReportTarget, tx: PoolClient) {
    const admitted = await tx.query(
      `INSERT INTO whaleu_safety.report_target_actors(kind,target_id,account_id,window_start) VALUES($1,$2,$3,date_trunc('minute',clock_timestamp())) ON CONFLICT(kind,target_id,account_id) DO UPDATE SET window_start=excluded.window_start WHERE whaleu_safety.report_target_actors.window_start<>excluded.window_start RETURNING account_id`,
      [target.kind, target.id, actor],
    );
    if (!admitted.rowCount) return;
    const row = (
      await tx.query<{ hits: number }>(
        `INSERT INTO whaleu_safety.report_target_buckets(kind,target_id,window_start,hits) VALUES($1,$2,date_trunc('minute',clock_timestamp()),1) ON CONFLICT(kind,target_id) DO UPDATE SET window_start=date_trunc('minute',clock_timestamp()),hits=CASE WHEN whaleu_safety.report_target_buckets.window_start=date_trunc('minute',clock_timestamp()) THEN LEAST(whaleu_safety.report_target_buckets.hits+1,1000000) ELSE 1 END RETURNING hits`,
        [target.kind, target.id],
      )
    ).rows[0]!;
    if (row.hits > this.config.SAFETY_TARGET_REQUESTS_PER_MINUTE)
      throw new ApplicationError('RATE_LIMITED');
  }
}
