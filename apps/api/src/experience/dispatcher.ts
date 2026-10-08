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
    for (const unitId of await this.worker.due()) {
      if (this.stopping) break;
      await this.worker.run({ mode: 'apply', unitIds: [unitId] });
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
