import { Inject, Injectable } from '@nestjs/common';
import type {
  BeforeApplicationShutdown,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { APP_CONFIG } from '../config/config.js';
import type { RuntimeConfig } from '../config/config.js';
import { ExperienceWorker, assertLocalExperienceWorker } from './worker.js';
/** Explicit local opt-in. Durable units are discovered directly; no historical scan or cursor. */
@Injectable()
export class ExperienceDispatcher
  implements BeforeApplicationShutdown, OnApplicationBootstrap
{
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private stopping = true;
  private generation = 0;
  private stoppingTask: Promise<void> | null = null;
  constructor(
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(ExperienceWorker) private readonly worker: ExperienceWorker,
  ) {}
  async onApplicationBootstrap() {
    await this.start();
  }
  async start(): Promise<void> {
    if (this.stoppingTask) {
      await this.stoppingTask;
      return this.start();
    }
    if (this.config.EXPERIENCE_PROCESSING !== 'automatic' || !this.stopping)
      return;
    assertLocalExperienceWorker(this.config);
    this.stopping = false;
    this.generation++;
    this.schedule();
  }
  private schedule() {
    if (this.stopping) return;
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopping || generation !== this.generation) return;
      this.inflight = this.cycle()
        .catch(() => undefined)
        .finally(() => {
          this.inflight = null;
          if (generation === this.generation) this.schedule();
        });
    }, this.config.EXPERIENCE_INTERVAL_MS);
    this.timer.unref();
  }
  private async cycle() {
    const attempted = new Set<string>();
    while (
      !this.stopping &&
      attempted.size < this.config.EXPERIENCE_BATCH_SIZE
    ) {
      // Each frontier contains at most one head per owner. Finish this round
      // before refreshing, so an independent owner gets a turn before a hot
      // owner advances again. The remaining budget is shared across all rounds.
      const frontier = (await this.worker.due([...attempted])).filter(
        (id) => !attempted.has(id),
      );
      if (!frontier.length) break;
      for (const unitId of frontier) {
        if (
          this.stopping ||
          attempted.size >= this.config.EXPERIENCE_BATCH_SIZE
        )
          break;
        if (attempted.has(unitId)) continue;
        // Even an unavailable source or a failed retry write gets at most one
        // attempt this cycle, without admitting that owner's later units.
        attempted.add(unitId);
        try {
          await this.worker.run({ mode: 'apply', unitIds: [unitId] });
        } catch {
          await this.worker
            .retry(unitId, 'local_processing_failed')
            .catch(() => undefined);
        }
      }
    }
  }
  async stop(): Promise<void> {
    if (this.stoppingTask) return this.stoppingTask;
    this.stopping = true;
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.stoppingTask = Promise.resolve(this.inflight)
      .then(() => undefined)
      .finally(() => {
        this.stoppingTask = null;
      });
    return this.stoppingTask;
  }
  async beforeApplicationShutdown() {
    await this.stop();
  }
}
