import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { APP_CONFIG } from '../../config/config.js';
import type { RuntimeConfig } from '../../config/config.js';
import { DatabaseService } from '../../database/database.js';
import { ratingIdSchema } from '../../ratings/contracts.js';
import { RatingsSubscriptionUpdatesSourceFacade } from '../../ratings/updates-source/subscription-facade.js';
import { RatingSubscriptionUpdatesProjectionFacade } from '../../ratings/updates-source/subscription-projection.js';
import type {
  RatingSubscriptionSource,
  RatingSubscriptionEpoch,
} from '../../ratings/updates-source/subscription-contracts.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { ratingSubscriptionNoticePreviewSchema } from './subscription-contracts.js';
import { RatingSubscriptionUpdatesRepository } from './subscription-repository.js';
import type {
  RatingSubscriptionJob,
  RatingSubscriptionWork,
} from './subscription-repository.js';
import {
  assertLocalRatingUpdatesWorker,
  assertLocalRatingUpdatesConnection,
} from './worker.js';
export const ratingSubscriptionWorkerSchema = z
  .strictObject({
    mode: z.enum(['dry-run', 'apply']).default('dry-run'),
    eventIds: z
      .array(ratingIdSchema)
      .max(50)
      .default([])
      .refine((ids) => new Set(ids).size === ids.length),
    maxPages: z.number().int().min(1).max(20).default(2),
    maxRecipients: z.number().int().min(1).max(1000).default(50),
  })
  .refine((o) => o.mode !== 'apply' || o.eventIds.length > 0);
export type RatingSubscriptionWorkerOptions = z.infer<
  typeof ratingSubscriptionWorkerSchema
>;
export function parseRatingSubscriptionCommand(
  args: readonly string[],
): RatingSubscriptionWorkerOptions {
  const rest = [...args];
  let mode: 'apply' | 'dry-run' = 'dry-run';
  if (rest[0] === 'apply' || rest[0] === 'dry-run')
    mode = rest.shift() as typeof mode;
  const eventIds: string[] = [];
  const limits: { maxPages?: number; maxRecipients?: number } = {};
  for (const arg of rest) {
    const event = /^--event-id=(.+)$/.exec(arg);
    if (event) {
      eventIds.push(event[1]!);
      continue;
    }
    const bound = /^--(max-pages|max-recipients)=([1-9][0-9]*)$/.exec(arg);
    if (!bound) throw new Error('Invalid subscription worker arguments');
    const key = bound[1] === 'max-pages' ? 'maxPages' : 'maxRecipients';
    if (limits[key] !== undefined)
      throw new Error('Duplicate subscription worker bound');
    limits[key] = Number(bound[2]);
  }
  return ratingSubscriptionWorkerSchema.parse({ mode, eventIds, ...limits });
}
const empty = () => ({
  processed: 0,
  alreadyProcessed: 0,
  missing: 0,
  blocked: 0,
  partial: 0,
  retryable: 0,
  materialized: 0,
  suppressed: 0,
  failed: 0,
  pages: 0,
  recipientSteps: 0,
  wouldMaterialize: 0,
  wouldSuppress: 0,
});
function verifyPreview(event: RatingSubscriptionSource, preview: unknown) {
  const parsed = ratingSubscriptionNoticePreviewSchema.parse(preview);
  if (
    parsed.author.mode === 'anonymous' &&
    parsed.author.targetId !== event.target.targetId
  )
    throw new Error('Mismatched subscription persona');
}
/** Manual-only. Page commits and each recipient commit are independently durable. */
@Injectable()
export class RatingSubscriptionUpdatesWorker {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(RatingsSubscriptionUpdatesSourceFacade)
    private readonly source: RatingsSubscriptionUpdatesSourceFacade,
    @Inject(RatingSubscriptionUpdatesProjectionFacade)
    private readonly projection: RatingSubscriptionUpdatesProjectionFacade,
    @Inject(RatingSubscriptionUpdatesRepository)
    private readonly records: RatingSubscriptionUpdatesRepository,
  ) {}
  private transaction<T>(
    eventId: string,
    operation: (tx: PoolClient) => Promise<T>,
  ): Promise<T> {
    return this.database.transaction(
      async (tx) => {
        await assertLocalRatingUpdatesConnection(tx);
        await lockSafetyPolicy(tx);
        await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `rating-subscription-in-app:${eventId}`,
        ]);
        return operation(tx);
      },
      { isolationLevel: 'read committed' },
    );
  }
  async run(input: Partial<RatingSubscriptionWorkerOptions> = {}) {
    const options = ratingSubscriptionWorkerSchema.parse(input);
    assertLocalRatingUpdatesWorker(this.config);
    if (
      options.mode === 'apply' &&
      this.config.RATINGS_UPDATES_PROCESSING !== 'manual'
    )
      throw new Error('Rating subscription processing is disabled');
    await this.database.transaction(assertLocalRatingUpdatesConnection, {
      isolationLevel: 'read committed',
    });
    const result = {
      mode: options.mode,
      requested: options.eventIds.length,
      ...empty(),
    };
    const remainingEventIds: string[] = [],
      retryableEventIds: string[] = [];
    let pagesLeft = options.maxPages,
      recipientsLeft = options.maxRecipients;
    for (const eventId of options.eventIds) {
      let partial = false,
        retryable = false;
      try {
        const start = await this.transaction(eventId, async (tx) => {
          const event = await this.source.event(eventId, tx);
          if (!event) return { state: 'missing' as const };
          if (await this.records.completed(eventId, tx))
            return { state: 'completed' as const };
          if (event.coverage !== 'complete')
            return { state: 'blocked' as const };
          return {
            state: 'ready' as const,
            event,
            job: await this.records.job(eventId, tx),
          };
        });
        if (start.state === 'missing') {
          result.missing++;
          continue;
        }
        if (start.state === 'completed') {
          result.alreadyProcessed++;
          continue;
        }
        if (start.state === 'blocked') {
          result.blocked++;
          partial = true;
          retryable = true;
        } else if (options.mode === 'dry-run') {
          // No owner, page, attempt, cursor or processing receipt writes, including
          // no write-and-rollback simulation. All counters are explicitly forecasts.
          const candidates: RatingSubscriptionWork[] = await this.transaction(
            eventId,
            (tx) => this.records.pending(eventId, recipientsLeft + 1, tx),
          );
          let job: RatingSubscriptionJob = { ...start.job };
          while (!job.scan_finished && pagesLeft > 0) {
            const raw = await this.transaction(eventId, async (tx) => {
              await this.source.lockTarget(start.event, tx);
              return this.source.rawPage(
                eventId,
                job.cursor_order,
                job.cursor_epoch_id,
                tx,
              );
            });
            const selected = raw.slice(0, 50),
              last = selected.at(-1);
            pagesLeft--;
            result.pages++;
            for (const epoch of selected.filter((e) => e.eligible))
              candidates.push(
                this.forecastWork(start.event, epoch, job.last_page + 1),
              );
            job = {
              ...job,
              last_page: job.last_page + 1,
              cursor_order: last?.startOrder ?? job.cursor_order,
              cursor_epoch_id: last?.epochId ?? job.cursor_epoch_id,
              scan_finished: raw.length <= 50,
            };
            if (candidates.length > recipientsLeft) break;
          }
          const selected = candidates.slice(0, recipientsLeft);
          partial = !job.scan_finished || candidates.length > selected.length;
          for (const work of selected) {
            recipientsLeft--;
            result.recipientSteps++;
            try {
              const decision = await this.transaction(eventId, (tx) =>
                this.projection.eligible(
                  start.event.target,
                  work.recipient_account_id,
                  tx,
                  work.epoch_id,
                  start.event.id,
                ),
              );
              if (decision.outcome === 'eligible') {
                verifyPreview(start.event, decision.preview);
                result.wouldMaterialize++;
              } else if (decision.outcome === 'suppressed')
                result.wouldSuppress++;
              else {
                retryable = true;
                partial = true;
              }
            } catch {
              result.failed++;
              retryable = true;
              partial = true;
            }
          }
        } else {
          while (pagesLeft > 0) {
            const appended = await this.transaction(eventId, async (tx) => {
              if (await this.records.completed(eventId, tx)) return false;
              const job = await this.records.job(eventId, tx, true);
              if (job.scan_finished) return false;
              await this.source.lockTarget(start.event, tx);
              const raw = await this.source.rawPage(
                eventId,
                job.cursor_order,
                job.cursor_epoch_id,
                tx,
              );
              await this.records.addPage(job, raw, tx);
              return true;
            });
            if (!appended) break;
            pagesLeft--;
            result.pages++;
          }
          while (recipientsLeft > 0) {
            let selected: RatingSubscriptionWork | null = null;
            try {
              const outcome = await this.transaction(eventId, async (tx) => {
                selected = await this.records.nextWork(eventId, tx);
                if (!selected) return 'none' as const;
                const decision = await this.projection.eligible(
                  start.event.target,
                  selected.recipient_account_id,
                  tx,
                  selected.epoch_id,
                  start.event.id,
                );
                if (decision.outcome === 'unavailable') {
                  await this.records.retry(selected, decision.code, tx);
                  return 'retry' as const;
                }
                if (decision.outcome === 'suppressed') {
                  await this.records.settle(
                    selected,
                    'suppressed',
                    decision.code,
                    null,
                    tx,
                  );
                  return 'suppressed' as const;
                }
                if (decision.outcome !== 'eligible')
                  throw new Error('Invalid subscription decision');
                verifyPreview(start.event, decision.preview);
                await this.records.owner(
                  selected.recipient_account_id,
                  tx,
                  true,
                );
                await this.records.materialize(start.event, selected, tx);
                return 'materialized' as const;
              });
              if (outcome === 'none') break;
              recipientsLeft--;
              result.recipientSteps++;
              if (outcome === 'retry') retryable = true;
              else result[outcome]++;
            } catch {
              result.failed++;
              retryable = true;
              const attempted = selected as RatingSubscriptionWork | null;
              if (!attempted) break;
              recipientsLeft--;
              result.recipientSteps++;
              await this.transaction(eventId, async (tx) => {
                const current = await this.records.work(
                  eventId,
                  attempted.recipient_account_id,
                  tx,
                );
                if (current && ['pending', 'retry'].includes(current.status))
                  await this.records.retry(
                    current,
                    'processing_unavailable',
                    tx,
                  );
              }).catch(() => undefined);
              // Never spin on a row whose retry persistence itself failed.
              const stillDue = await this.transaction(eventId, (tx) =>
                this.records.nextWork(eventId, tx),
              );
              if (
                stillDue?.recipient_account_id ===
                attempted.recipient_account_id
              )
                break;
            }
          }
          const terminal = await this.transaction(eventId, async (tx) => {
            if (await this.records.completed(eventId, tx))
              return { complete: true, retryable: false, existing: true };
            const complete = await this.records.finish(eventId, tx);
            return {
              complete,
              existing: false,
              retryable: complete
                ? false
                : (await this.records.status(eventId, tx)).retryable,
            };
          });
          if (terminal.complete) {
            if (terminal.existing) result.alreadyProcessed++;
            else result.processed++;
          } else partial = true;
          retryable ||= terminal.retryable;
        }
      } catch {
        result.failed++;
        partial = true;
        retryable = true;
      }
      if (partial) {
        result.partial++;
        remainingEventIds.push(eventId);
      }
      if (retryable) {
        result.retryable++;
        retryableEventIds.push(eventId);
      }
    }
    return { ...result, remainingEventIds, retryableEventIds };
  }
  private forecastWork(
    event: RatingSubscriptionSource,
    epoch: RatingSubscriptionEpoch,
    page: number,
  ): RatingSubscriptionWork {
    return {
      event_id: event.id,
      recipient_account_id: epoch.accountId,
      epoch_id: epoch.epochId,
      target_id: event.target.targetId,
      page_number: page,
      status: 'pending',
      attempts: 0,
      code: null,
    };
  }
}
