import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { APP_CONFIG } from '../config/config.js';
import type { RuntimeConfig } from '../config/config.js';
import { DatabaseService } from '../database/database.js';
import { CommunityExperienceSourceFacade } from '../community/experience-source/facade.js';
import { ExperienceRepository } from './repository.js';
import { ExperienceSettlementService } from './settlement.js';
import { lockExperienceOwner } from './ingress.js';
const ids = z
  .array(z.uuid().transform((x) => x.toLowerCase()))
  .max(50)
  .default([])
  .refine((x) => new Set(x).size === x.length);
export const experienceWorkerSchema = z
  .strictObject({
    mode: z.enum(['dry-run', 'apply']).default('dry-run'),
    unitIds: ids,
    groupIds: ids,
  })
  .refine((x) => x.unitIds.length + x.groupIds.length <= 50)
  .refine(
    (x) => x.mode !== 'apply' || x.unitIds.length + x.groupIds.length > 0,
  );
export type ExperienceWorkerOptions = z.infer<typeof experienceWorkerSchema>;
export function assertLocalExperienceWorker(config: RuntimeConfig) {
  const url = new URL(config.DATABASE_URL);
  if (
    config.NODE_ENV === 'production' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !['/whaleu_dev', '/whaleu_test'].includes(url.pathname)
  )
    throw new Error(
      'Experience processing requires a disposable local database',
    );
}
export async function assertLocalExperienceConnection(tx: PoolClient) {
  const peer = (
    tx as PoolClient & { connection?: { stream?: { remoteAddress?: string } } }
  ).connection?.stream?.remoteAddress;
  if (
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(tx.host) ||
    !peer ||
    !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)
  )
    throw new Error(
      'Experience processing requires an actual loopback connection',
    );
  const name = (
    await tx.query<{ name: string }>('SELECT current_database() AS name')
  ).rows[0]!.name;
  if (!['whaleu_dev', 'whaleu_test'].includes(name))
    throw new Error('Experience processing requires a disposable database');
}
export function parseExperienceCommand(
  args: readonly string[],
): ExperienceWorkerOptions {
  const remaining = [...args];
  let mode: 'dry-run' | 'apply' = 'dry-run';
  if (remaining[0] === 'dry-run' || remaining[0] === 'apply')
    mode = remaining.shift() as 'dry-run' | 'apply';
  const unitIds: string[] = [],
    groupIds: string[] = [];
  for (const arg of remaining) {
    const match = /^--(unit|group)-id=(.+)$/.exec(arg);
    if (!match) throw new Error('Invalid experience arguments');
    (match[1] === 'unit' ? unitIds : groupIds).push(match[2]!);
  }
  if (mode === 'apply' && !unitIds.length && !groupIds.length)
    throw new Error(
      'Apply requires explicitly selected reward units or groups',
    );
  return experienceWorkerSchema.parse({ mode, unitIds, groupIds });
}
export type UnitResult =
  | 'settled'
  | 'completed'
  | 'blockedBaseline'
  | 'blockedPredecessor'
  | 'pending'
  | 'missing'
  | 'sourceUnavailable';
@Injectable()
export class ExperienceWorker {
  constructor(
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CommunityExperienceSourceFacade)
    private readonly source: CommunityExperienceSourceFacade,
    @Inject(ExperienceRepository)
    private readonly records: ExperienceRepository,
    @Inject(ExperienceSettlementService)
    private readonly settlement: ExperienceSettlementService,
  ) {}
  async run(input: Partial<ExperienceWorkerOptions> = {}) {
    const options = experienceWorkerSchema.parse(input);
    assertLocalExperienceWorker(this.config);
    if (
      options.mode === 'apply' &&
      this.config.EXPERIENCE_PROCESSING === 'disabled'
    )
      throw new Error('Experience processing is disabled');
    const selected = await this.database.transaction(async (tx) => {
      await assertLocalExperienceConnection(tx);
      const rows = (
        await tx.query<{ unit_id: string }>(
          'SELECT unit_id FROM whaleu_experience.work WHERE unit_id=ANY($1::uuid[]) OR group_id=ANY($2::uuid[]) ORDER BY enrollment_order,unit_id LIMIT 51',
          [options.unitIds, options.groupIds],
        )
      ).rows;
      if (rows.length > 50)
        throw new Error('Select at most fifty reward units');
      return rows.map((r) => r.unit_id);
    });
    const results = {
      requested: selected.length,
      settled: 0,
      completed: 0,
      blockedBaseline: 0,
      blockedPredecessor: 0,
      pending: 0,
      missing: options.unitIds.filter((id) => !selected.includes(id)).length,
      sourceUnavailable: 0,
      failed: 0,
    };
    for (const unit of selected) {
      try {
        const status = await this.database.transaction(async (tx) => {
          await assertLocalExperienceConnection(tx);
          const reference = await this.source.loadUnit(unit, tx);
          if (!reference) return 'sourceUnavailable' as const;
          // No source/domain/enrollment lock is acquired after this single owner guard.
          await lockExperienceOwner(tx, reference.beneficiaryId);
          const work = await this.records.work(unit, tx);
          if (!work) return 'missing' as const;
          if (work.state === 'completed') return 'completed' as const;
          const first = await this.records.first(reference.beneficiaryId, tx);
          if (first?.unit_id !== unit) return 'blockedPredecessor' as const;
          const state = await this.records.state(reference.beneficiaryId, tx);
          if (!state) {
            if (options.mode === 'apply')
              await tx.query(
                "UPDATE whaleu_experience.work SET state='blocked_baseline',error_code='baseline_unknown' WHERE unit_id=$1",
                [unit],
              );
            return 'blockedBaseline' as const;
          }
          if (options.mode === 'dry-run') return 'pending' as const;
          const applied = await this.settlement.source(reference, state, tx);
          await this.source.acknowledge(unit, applied.settlementId, tx);
          await tx.query(
            "UPDATE whaleu_experience.work SET state='completed',completed_at=clock_timestamp(),error_code=NULL WHERE unit_id=$1",
            [unit],
          );
          return 'settled' as const;
        });
        results[status]++;
        if (
          options.mode === 'apply' &&
          (status === 'blockedPredecessor' || status === 'sourceUnavailable')
        )
          await this.retry(
            unit,
            status === 'blockedPredecessor'
              ? 'blocked_predecessor'
              : 'source_unavailable',
          );
      } catch {
        results.failed++;
        if (options.mode === 'apply')
          await this.retry(unit, 'local_processing_failed').catch(
            () => undefined,
          );
      }
    }
    return results;
  }
  async retry(
    unit: string,
    code:
      'blocked_predecessor' | 'source_unavailable' | 'local_processing_failed',
  ) {
    assertLocalExperienceWorker(this.config);
    await this.database.transaction(async (tx) => {
      await assertLocalExperienceConnection(tx);
      await tx.query(
        "UPDATE whaleu_experience.work SET attempts=least(attempts+1,2147483647),error_code=$2,next_attempt_at=clock_timestamp()+make_interval(secs=>least(300,5*power(2,least(attempts,6)))::double precision) WHERE unit_id=$1 AND state<>'completed'",
        [unit, code],
      );
    });
  }
  async due(attemptedUnitIds: readonly string[] = []): Promise<string[]> {
    assertLocalExperienceWorker(this.config);
    const attempted = ids.parse(attemptedUnitIds);
    const remaining = this.config.EXPERIENCE_BATCH_SIZE - attempted.length;
    if (remaining <= 0) return [];
    return this.database.transaction(async (tx) => {
      await assertLocalExperienceConnection(tx);
      return (
        await tx.query<{ unit_id: string }>(
          // Excluded attempts still participate in the predecessor check: an
          // unresolved head must never make its successor eligible.
          "SELECT w.unit_id FROM whaleu_experience.work w WHERE w.state<>'completed' AND w.unit_id<>ALL($2::uuid[]) AND w.next_attempt_at<=clock_timestamp() AND (w.state<>'blocked_baseline' OR EXISTS(SELECT 1 FROM whaleu_experience.baselines b WHERE b.owner_id=w.beneficiary_id)) AND NOT EXISTS(SELECT 1 FROM whaleu_experience.work earlier WHERE earlier.beneficiary_id=w.beneficiary_id AND earlier.state<>'completed' AND (earlier.enrollment_order,earlier.unit_id)<(w.enrollment_order,w.unit_id)) ORDER BY w.enrollment_order,w.unit_id LIMIT $1",
          [remaining, attempted],
        )
      ).rows.map((r) => r.unit_id);
    });
  }
}
