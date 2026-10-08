import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../../database/database.js';
import { ApplicationError } from '../../http/application-error.js';
import { VIEW_LIMITS } from './contracts.js';
export interface ViewCleanupResult {
  epochs: number;
  receipts: number;
  detailWindows: number;
  quotas: number;
  lagging: boolean;
}
@Injectable()
export class ViewComponentCleanup {
  private automaticRequired = false;
  private ready = false;
  private lastSuccess = 0;
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}
  requireSuccessfulSweep(): void {
    this.automaticRequired = true;
    this.ready = false;
  }
  async lagging(tx: PoolClient): Promise<boolean> {
    return (
      (
        await tx.query<{ lagging: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM whaleu_post_hotness.view_reporting_epochs
       WHERE expires_at < clock_timestamp()-interval '120 seconds')
       OR EXISTS(SELECT 1 FROM whaleu_post_hotness.view_detail_cooldowns
       WHERE next_allowed_at < clock_timestamp()-interval '120 seconds') AS lagging`,
        )
      ).rows[0]?.lagging ?? true
    );
  }
  async assertAdmission(tx: PoolClient): Promise<void> {
    if (
      this.automaticRequired &&
      (!this.ready ||
        performance.now() - this.lastSuccess > VIEW_LIMITS.cleanupLagMs)
    )
      throw new ApplicationError('VIEW_REPORTING_UNAVAILABLE');
    if (await this.lagging(tx))
      throw new ApplicationError('VIEW_REPORTING_UNAVAILABLE');
  }
  async run(): Promise<ViewCleanupResult> {
    const result: ViewCleanupResult = {
      epochs: 0,
      receipts: 0,
      detailWindows: 0,
      quotas: 0,
      lagging: false,
    };
    const until = performance.now() + 2000;
    try {
      for (let round = 0; round < 16 && performance.now() < until; round++) {
        const chunk = await this.database.transaction(
          async (tx) => {
            await tx.query("SET LOCAL transaction_timeout='5s'");
            await tx.query("SET LOCAL statement_timeout='2s'");
            await tx.query("SET LOCAL lock_timeout='100ms'");
            const counts = { epochs: 0, receipts: 0, detailWindows: 0 };
            const epoch = (
              await tx.query<{ id: string }>(
                `SELECT id FROM whaleu_post_hotness.view_reporting_epochs
             WHERE expires_at<=clock_timestamp() ORDER BY expires_at,id LIMIT 1 FOR UPDATE SKIP LOCKED`,
              )
            ).rows[0];
            if (epoch) {
              // Reserve one deletion slot for the parent. Recheck the epoch after
              // its lock; partial receipt cleanup never makes an old epoch live.
              counts.receipts =
                (
                  await tx.query(
                    `DELETE FROM whaleu_post_hotness.view_report_receipts r
               WHERE (epoch_id,batch_id) IN (SELECT epoch_id,batch_id FROM whaleu_post_hotness.view_report_receipts
                WHERE epoch_id=$1 ORDER BY batch_id LIMIT $2)
               AND EXISTS(SELECT 1 FROM whaleu_post_hotness.view_reporting_epochs e
                WHERE e.id=r.epoch_id AND e.expires_at<=clock_timestamp())`,
                    [epoch.id, VIEW_LIMITS.cleanupRows - 1],
                  )
                ).rowCount ?? 0;
              counts.epochs =
                (
                  await tx.query(
                    `DELETE FROM whaleu_post_hotness.view_reporting_epochs e WHERE id=$1 AND expires_at<=clock_timestamp()
               AND NOT EXISTS(SELECT 1 FROM whaleu_post_hotness.view_report_receipts r WHERE r.epoch_id=e.id)`,
                    [epoch.id],
                  )
                ).rowCount ?? 0;
            }
            const remaining =
              VIEW_LIMITS.cleanupRows - counts.receipts - counts.epochs;
            if (remaining > 0)
              counts.detailWindows =
                (
                  await tx.query(
                    `WITH candidates AS (SELECT account_id,post_id FROM whaleu_post_hotness.view_detail_cooldowns
             WHERE next_allowed_at<=clock_timestamp() ORDER BY next_allowed_at,account_id,post_id
             LIMIT $1 FOR UPDATE SKIP LOCKED)
             DELETE FROM whaleu_post_hotness.view_detail_cooldowns d USING candidates c
             WHERE d.account_id=c.account_id AND d.post_id=c.post_id AND d.next_allowed_at<=clock_timestamp()`,
                    [remaining],
                  )
                ).rowCount ?? 0;
            return counts;
          },
          { isolationLevel: 'read committed' },
        );
        result.epochs += chunk.epochs;
        result.receipts += chunk.receipts;
        result.detailWindows += chunk.detailWindows;
        if (chunk.epochs + chunk.receipts + chunk.detailWindows === 0) break;
      }
      result.lagging = await this.database.transaction(
        (tx) => this.lagging(tx),
        { isolationLevel: 'read committed' },
      );
      this.ready = !result.lagging;
      this.lastSuccess = performance.now();
      return result;
    } catch (error) {
      this.ready = false;
      throw error;
    }
  }
}
