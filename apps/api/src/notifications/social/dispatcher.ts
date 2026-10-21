import { Inject, Injectable } from '@nestjs/common';
import type {
  BeforeApplicationShutdown,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.js';
import type { RuntimeConfig } from '../../config/config.js';
import { DatabaseService } from '../../database/database.js';
import { SocialUpdatesRepository } from './repository.js';
import {
  SocialUpdatesWorker,
  assertLocalSocialWorker,
  assertLocalSocialConnection,
} from './worker.js';
/** Existing explicit automatic local mode, fresh-only work and bounded ticks.
 * Startup does not adopt manual/imported sources; no external delivery exists. */
@Injectable()
export class SocialUpdatesDispatcher
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private stopped = true;
  private starting: Promise<void> | null = null;
  private generation = 0;
  constructor(
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SocialUpdatesRepository)
    private readonly records: SocialUpdatesRepository,
    @Inject(SocialUpdatesWorker) private readonly worker: SocialUpdatesWorker,
  ) {}
  async onApplicationBootstrap() {
    if (this.config.COMMUNITY_UPDATES_PROCESSING !== 'automatic') return;
    assertLocalSocialWorker(this.config);
    if (this.starting) return this.starting;
    const generation = ++this.generation;
    this.starting = this.database
      .transaction(assertLocalSocialConnection, {
        isolationLevel: 'read committed',
      })
      .then(() => {
        if (generation !== this.generation) return;
        this.stopped = false;
        this.schedule();
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }
  private schedule() {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped) return;
      this.inflight = this.cycle()
        .catch(() => undefined)
        .finally(() => {
          this.inflight = null;
          this.schedule();
        });
    }, this.config.COMMUNITY_UPDATES_INTERVAL_MS);
    this.timer.unref();
  }
  /** Real bounded cycle shared by scheduled execution and deterministic local tests. */
  async cycle() {
    assertLocalSocialWorker(this.config);
    if (this.config.COMMUNITY_UPDATES_PROCESSING !== 'automatic') return;
    const rows = await this.database.transaction(
      async (tx) => {
        await assertLocalSocialConnection(tx);
        return this.records.work(
          Math.min(50, this.config.COMMUNITY_UPDATES_BATCH_SIZE),
          tx,
        );
      },
      { isolationLevel: 'read committed' },
    );
    for (const row of rows)
      await this.worker.run({ mode: 'apply', sourceIds: [row.source_id] });
  }
  async beforeApplicationShutdown() {
    this.stopped = true;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.starting?.catch(() => undefined);
    await this.inflight;
  }
}
