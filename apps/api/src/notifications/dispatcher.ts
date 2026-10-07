import { Inject, Injectable } from '@nestjs/common';
import type {
  BeforeApplicationShutdown,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { APP_CONFIG } from '../config/config.js';
import type { RuntimeConfig } from '../config/config.js';
import { DatabaseService } from '../database/database.js';
import { CommunityUpdatesFacade } from '../community/updates.facade.js';
import { NotificationsRepository } from './repository.js';
import { UpdatesWorker } from './worker.js';
/** Default-off bounded automatic LOCAL dispatcher. The source facade supplies
 * only events published under explicit automatic configuration. Durable discovery
 * and work rows survive crashes/restarts without adopting old manual/imported
 * obligations. Pending transient failures retry with bounded exponential backoff;
 * only explicit terminal receipts settle work. No provider backlog exists. */
@Injectable()
export class UpdatesDispatcher
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private starting: Promise<void> | null = null;
  private stopping = true;
  private stoppingTask: Promise<void> | null = null;
  private generation = 0;
  constructor(
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CommunityUpdatesFacade)
    private readonly community: CommunityUpdatesFacade,
    @Inject(NotificationsRepository)
    private readonly repository: NotificationsRepository,
    @Inject(UpdatesWorker) private readonly worker: UpdatesWorker,
  ) {}
  async onApplicationBootstrap() {
    if (this.config.COMMUNITY_UPDATES_PROCESSING === 'automatic')
      await this.start();
  }
  async start(): Promise<void> {
    if (this.stoppingTask) {
      await this.stoppingTask;
      return this.start();
    }
    if (this.config.COMMUNITY_UPDATES_PROCESSING !== 'automatic') return;
    if (this.starting) return this.starting;
    if (!this.stopping) return;
    this.stopping = false;
    const generation = ++this.generation;
    this.starting = this.database
      .transaction((tx) => this.repository.discoveryCursor(tx))
      .then(() => {
        if (!this.stopping && generation === this.generation) this.schedule();
      })
      .catch((error: unknown) => {
        if (generation === this.generation) this.stopping = true;
        throw error;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }
  private schedule() {
    if (this.stopping) return;
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopping || generation !== this.generation) return;
      this.inflight = this.cycle()
        .catch(() => {
          /* No terminal receipt: next bounded tick retries. */
        })
        .finally(() => {
          this.inflight = null;
          if (generation === this.generation) this.schedule();
        });
    }, this.config.COMMUNITY_UPDATES_INTERVAL_MS);
    this.timer.unref();
  }
  private async cycle() {
    await this.database.transaction(async (tx) => {
      // One durable cursor guard serializes concurrent dispatchers. Enqueue and
      // cursor advancement commit together, so a crash cannot skip discovery.
      const after = await this.repository.discoveryCursor(tx);
      const rows = await this.community.enrolledAfter(
        after,
        this.config.COMMUNITY_UPDATES_BATCH_SIZE,
        tx,
      );
      await this.repository.enqueueAutomatic(rows, tx);
    });
    const rows = await this.database.transaction((tx) =>
      this.repository.pendingAutomatic(
        this.config.COMMUNITY_UPDATES_BATCH_SIZE,
        tx,
      ),
    );
    for (const { event_id: id } of rows) {
      if (this.stopping) break;
      try {
        const result = await this.worker.run({ mode: 'apply', eventIds: [id] });
        if (!result.retryable)
          await this.database.transaction((tx) =>
            this.repository.finishAutomatic(id, tx),
          );
      } catch {
        // Another instance may already have committed. An exact replay settles
        // that outcome; failures remain durable and do not increment unread.
        await this.database
          .transaction((tx) =>
            this.repository.retryable(id, 'local_processing_failed', tx),
          )
          .catch(() => undefined);
      }
    }
  }
  async stop() {
    if (this.stoppingTask) return this.stoppingTask;
    this.stopping = true;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stoppingTask = (async () => {
      await this.starting?.catch(() => undefined);
      await this.inflight;
    })().finally(() => {
      this.stoppingTask = null;
    });
    return this.stoppingTask;
  }
  async beforeApplicationShutdown() {
    await this.stop();
  }
}
