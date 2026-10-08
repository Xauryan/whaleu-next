import { Inject, Injectable, Module } from '@nestjs/common';
import type {
  BeforeApplicationShutdown,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { APP_CONFIG } from '../../config/config.js';
import type { RuntimeConfig } from '../../config/config.js';
import { AppLogger } from '../../observability/logger.js';
import { HotFeedProcessing } from './processing.js';
import { HotFeedProcessingModule } from './runtime-module.js';
export const HOT_FEED_INTERVAL_MS = 5000;
@Injectable()
export class HotFeedRunner
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private inflight: Promise<void> | null = null;
  private stopping = false;
  constructor(
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(HotFeedProcessing) private readonly processing: HotFeedProcessing,
    @Inject(AppLogger) private readonly logger: AppLogger,
  ) {}
  async onApplicationBootstrap(): Promise<void> {
    await this.tick();
  }
  @Interval('hot-feed-processing', HOT_FEED_INTERVAL_MS)
  async tick(): Promise<void> {
    if (this.config.HOT_FEED_PROCESSING !== 'automatic' || this.stopping)
      return;
    if (this.inflight) return this.inflight;
    this.inflight = this.run().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }
  private async run(): Promise<void> {
    try {
      const summary = await this.processing.cycle(() => this.stopping);
      this.logger.structured.info({ event: 'hot_feed_cycle', ...summary });
    } catch {
      this.logger.structured.warn({ event: 'hot_feed_cycle_failed' });
    }
  }
  async beforeApplicationShutdown(): Promise<void> {
    this.stopping = true;
    await this.inflight;
  }
}
/** Only AppModule's explicit HTTP-runtime branch imports this lifecycle owner. */
@Module({
  imports: [HotFeedProcessingModule],
  providers: [HotFeedRunner],
  exports: [HotFeedRunner],
})
export class HotFeedRunnerModule {}
