import { Inject, Injectable } from '@nestjs/common';
import type {
  OnApplicationBootstrap,
  BeforeApplicationShutdown,
} from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG } from '../../config/config.js';
import type { RuntimeConfig } from '../../config/config.js';
import { DatabaseService } from '../../database/database.js';
import { CommunityReportTargetFacade } from '../../community/report-target.facade.js';
import { lockSafetyPolicy } from '../locks.js';
import { ReportsRepository } from './repository.js';
import { JurySettlementService } from './settlement.js';
export const juryWorkerOptionsSchema = z.strictObject({
  mode: z.enum(['dry-run', 'apply']).default('dry-run'),
  juryIds: z
    .array(z.uuid().transform((x) => x.toLowerCase()))
    .max(50)
    .default([])
    .refine((ids) => new Set(ids).size === ids.length),
});
export type JuryWorkerOptions = z.infer<typeof juryWorkerOptionsSchema>;
export function assertLocalJuryWorker(config: RuntimeConfig) {
  const url = new URL(config.DATABASE_URL);
  if (
    config.NODE_ENV === 'production' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !['/whaleu_test', '/whaleu_dev'].includes(url.pathname)
  )
    throw new Error('Jury command requires a disposable local database');
}
export function parseJuryCommand(args: readonly string[]): JuryWorkerOptions {
  const rest = [...args];
  let mode: 'dry-run' | 'apply' = 'dry-run';
  if (rest[0] === 'dry-run' || rest[0] === 'apply')
    mode = rest.shift() as 'dry-run' | 'apply';
  const juryIds = rest.map((arg) => {
    const m = /^--jury-id=(.+)$/.exec(arg);
    if (!m) throw new Error('Invalid jury arguments');
    return m[1]!;
  });
  if (mode === 'apply' && !juryIds.length)
    throw new Error('Apply requires explicitly selected juries');
  return juryWorkerOptionsSchema.parse({ mode, juryIds });
}
@Injectable()
export class JuryWorker {
  constructor(
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CommunityReportTargetFacade)
    private readonly targets: CommunityReportTargetFacade,
    @Inject(ReportsRepository) private readonly records: ReportsRepository,
    @Inject(JurySettlementService)
    private readonly settlement: JurySettlementService,
  ) {}
  async run(input: Partial<JuryWorkerOptions> = {}) {
    const options = juryWorkerOptionsSchema.parse(input);
    if (
      options.mode === 'apply' &&
      this.config.SAFETY_JURY_PROCESSING === 'disabled'
    )
      throw new Error('Local jury processing is disabled');
    const result = {
      requested: options.juryIds.length,
      completed: 0,
      pending: 0,
      changed: 0,
      missing: 0,
      failed: 0,
    };
    for (const id of options.juryIds) {
      try {
        const status = await this.database.transaction(async (tx) => {
          await lockSafetyPolicy(tx);
          const reference = (
            await tx.query<{ post_id: string; content_digest: string }>(
              "SELECT j.post_id,j.content_digest FROM whaleu_safety.post_juries j JOIN whaleu_safety.jury_work w ON w.jury_id=j.id WHERE j.id=$1 AND w.provenance='native_publication'",
              [id],
            )
          ).rows[0];
          if (!reference) return 'missing' as const;
          // Discovery holds no work-row lock while waiting on content ancestors.
          await this.targets.lockForSettlement(
            { kind: 'post', id: reference.post_id },
            reference.content_digest,
            tx,
          );
          await this.records.case(
            { kind: 'post', id: reference.post_id },
            tx,
            true,
          );
          const jury = await this.records.jury(reference.post_id, tx, true);
          if (!jury || jury.id !== id) return 'missing' as const;
          if (options.mode === 'dry-run')
            return jury.state === 'pending'
              ? ('pending' as const)
              : ('completed' as const);
          return this.settlement.settle(jury, tx);
        });
        result[status]++;
        if (options.mode === 'apply' && status === 'changed')
          await this.retry(id, 'content_version_changed');
      } catch {
        result.failed++;
        if (options.mode === 'apply')
          await this.retry(id, 'local_processing_failed').catch(
            () => undefined,
          );
      }
    }
    return result;
  }
  private retry(
    id: string,
    code: 'content_version_changed' | 'local_processing_failed',
  ) {
    return this.database.transaction(async (tx) => {
      await tx.query(
        `UPDATE whaleu_safety.jury_work SET attempts=LEAST(attempts+1,2147483647),next_attempt_at=clock_timestamp()+make_interval(secs=>LEAST(60,5*power(2,LEAST(attempts,4)))::double precision),error_code=$2 WHERE jury_id=$1 AND state='pending'`,
        [id, code],
      );
    });
  }
  async due() {
    return (
      await this.database.query<{ jury_id: string }>(
        "SELECT jury_id FROM whaleu_safety.jury_work WHERE state='pending' AND provenance='native_publication' AND due_at<=clock_timestamp() AND next_attempt_at<=clock_timestamp() ORDER BY next_attempt_at,jury_id LIMIT $1",
        [this.config.SAFETY_JURY_BATCH_SIZE],
      )
    ).rows;
  }
}
@Injectable()
export class JuryDispatcher
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<void> | null = null;
  private starting: Promise<void> | null = null;
  private stoppingTask: Promise<void> | null = null;
  private stopping = true;
  private generation = 0;
  constructor(
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(JuryWorker) private readonly worker: JuryWorker,
  ) {}
  async onApplicationBootstrap() {
    await this.start();
  }
  async start(): Promise<void> {
    if (this.stoppingTask) {
      await this.stoppingTask;
      return this.start();
    }
    if (this.config.SAFETY_JURY_PROCESSING !== 'automatic') return;
    if (this.starting) return this.starting;
    if (!this.stopping) return;
    this.stopping = false;
    const generation = ++this.generation;
    this.starting = Promise.resolve()
      .then(() => {
        if (!this.stopping && generation === this.generation) this.schedule();
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
        .catch(() => undefined)
        .finally(() => {
          this.inflight = null;
          if (generation === this.generation) this.schedule();
        });
    }, this.config.SAFETY_JURY_INTERVAL_MS);
    this.timer.unref();
  }
  private async cycle() {
    const rows = await this.worker.due();
    for (const row of rows) {
      if (this.stopping) break;
      await this.worker.run({ mode: 'apply', juryIds: [row.jury_id] });
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
