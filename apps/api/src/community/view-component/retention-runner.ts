import { Inject, Injectable, Module } from '@nestjs/common';
import type {
  BeforeApplicationShutdown,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { APP_CONFIG } from '../../config/config.js';
import type { RuntimeConfig } from '../../config/config.js';
import { AppLogger } from '../../observability/logger.js';
import { PostgresRequestThrottlingModule } from '../../request-throttling/module.js';
import { PostgresThrottlerStorage } from '../../request-throttling/postgres-storage.js';
import { ViewComponentCleanup } from './cleanup.js';
import { CommunityViewComponentModule } from './module.js';

export const VIEW_RETENTION_INTERVAL_MS = 60000;

/** Registered only by the explicit HTTP application. Nest owns periodic timers;
 * the business cleanup owns bounded transactions and cross-process row locks.
 */
@Injectable()
export class ViewRetentionRunner
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private inflight: Promise<void> | null = null;
  private stopping = false;

  constructor(
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(ViewComponentCleanup)
    private readonly cleanup: ViewComponentCleanup,
    @Inject(PostgresThrottlerStorage)
    private readonly throttles: PostgresThrottlerStorage,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {
    // Even an explicitly disabled/manual HTTP runner must not admit new history
    // without a successful sweep. Browsing and live receipt replay stay separate.
    this.cleanup.requireSuccessfulSweep();
  }

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.VIEW_REPORTING_RETENTION_PROCESSING === 'automatic')
      await this.sweep();
  }

  @Interval('view-reporting-retention', VIEW_RETENTION_INTERVAL_MS)
  async scheduledSweep(): Promise<void> {
    if (this.config.VIEW_REPORTING_RETENTION_PROCESSING === 'automatic')
      await this.sweep();
  }

  sweep(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.inflight) return this.inflight;
    this.inflight = this.runSweep().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async runSweep(): Promise<void> {
    const started = performance.now();
    try {
      let requestCounters = 0;
      // No background-traffic dependency. Each transaction deletes <=256 rows;
      // finish this bounded storage work before publishing business readiness.
      for (let chunk = 0; chunk < 16 && !this.stopping; chunk++) {
        const removed = await this.throttles.cleanup();
        requestCounters += removed;
        if (removed < 256 || performance.now() - started >= 2000) break;
      }
      if (this.stopping) return;
      const result = await this.cleanup.run();
      this.logger.structured.info({
        event: 'view_retention_sweep',
        epochs: result.epochs,
        receipts: result.receipts,
        detailWindows: result.detailWindows,
        requestCounters,
        lagging: result.lagging,
        durationMs: Math.round(performance.now() - started),
      });
    } catch {
      this.cleanup.requireSuccessfulSweep();
      this.logger.structured.warn({ event: 'view_retention_failed' });
    }
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    // Nest completes every before-shutdown hook before DatabaseService's
    // onApplicationShutdown closes its pool. A late interval can do no work.
    await this.inflight;
  }
}

@Module({
  imports: [CommunityViewComponentModule, PostgresRequestThrottlingModule],
  providers: [ViewRetentionRunner],
  exports: [ViewRetentionRunner],
})
export class ViewRetentionModule {}
