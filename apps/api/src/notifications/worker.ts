import { lockSafetyPolicy } from '../safety/locks.js';
import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../config/config.js';
import type { RuntimeConfig } from '../config/config.js';
import { DatabaseService } from '../database/database.js';
import { CommunityUpdatesFacade } from '../community/updates.facade.js';
import { NotificationsRepository } from './repository.js';
import { workerOptionsSchema } from './worker-options.js';
import type { WorkerOptions } from './worker-options.js';
export interface WorkerResult {
  requested: number;
  processed: number;
  alreadyProcessed: number;
  missing: number;
  ignored: number;
  unavailable: number;
  retryable: number;
  materialized: number;
  suppressed: number;
  externalUnavailable: number;
}
/** Reusable local-database-only materializer; environment/host guard belongs to
 * the CLI. No SDK, network adapter, provider consent or external queue exists. */
@Injectable()
export class UpdatesWorker {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(CommunityUpdatesFacade)
    private readonly community: CommunityUpdatesFacade,
    @Inject(NotificationsRepository)
    private readonly repository: NotificationsRepository,
  ) {}
  async run(
    input: Partial<WorkerOptions> = {},
  ): Promise<
    WorkerResult & { mode: WorkerOptions['mode']; retryableEventIds: string[] }
  > {
    const options = workerOptionsSchema.parse(input);
    if (
      options.mode === 'apply' &&
      this.config.COMMUNITY_UPDATES_PROCESSING === 'disabled'
    )
      throw new Error('Local Updates processing is disabled');
    const result: WorkerResult = {
      requested: options.eventIds.length,
      processed: 0,
      alreadyProcessed: 0,
      missing: 0,
      ignored: 0,
      unavailable: 0,
      retryable: 0,
      materialized: 0,
      suppressed: 0,
      externalUnavailable: 0,
    };
    const retryableEventIds: string[] = [];
    for (const eventId of options.eventIds) {
      const one = await this.database.transaction(
        async (tx): Promise<Omit<WorkerResult, 'requested'>> => {
          await lockSafetyPolicy(tx);
          const counts = {
            processed: 0,
            alreadyProcessed: 0,
            missing: 0,
            ignored: 0,
            unavailable: 0,
            retryable: 0,
            materialized: 0,
            suppressed: 0,
            externalUnavailable: 0,
          };
          await tx.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
            [`community-in-app:${eventId}`],
          );
          if (await this.repository.eventReceipt(eventId, tx))
            return { ...counts, alreadyProcessed: 1 };
          const source = await this.community.event(eventId, tx);
          if (source.status !== 'ready') {
            counts[source.status] = 1;
            if (source.status !== 'missing' && options.mode === 'apply')
              await this.repository.settleEvent(
                eventId,
                source.status,
                source.code,
                tx,
              );
            return counts;
          }
          // Finish all authority/serialization checks before mutating. A temporarily
          // unavailable local gate leaves the entire event retryable, without a
          // partial notice set or immutable successful/terminal receipts.
          const decisions = [];
          for (const recipient of source.event.recipients)
            decisions.push({
              recipient,
              decision: await this.community.eligible(
                source.event.target,
                recipient,
                tx,
                source.event.sequence,
              ),
            });
          const unavailable = decisions.find(
            (x) => x.decision.outcome === 'unavailable',
          );
          if (unavailable && unavailable.decision.outcome !== 'eligible') {
            if (options.mode === 'apply')
              await this.repository.retryable(
                eventId,
                unavailable.decision.code,
                tx,
              );
            return { ...counts, retryable: 1 };
          }
          for (const { recipient, decision } of decisions) {
            if (decision.outcome === 'eligible') {
              counts.materialized++;
              if (options.mode === 'apply') {
                await this.repository.owner(recipient.accountId, tx, true);
                await this.repository.materialize(source.event, recipient, tx);
              }
            } else {
              counts[decision.outcome]++;
              if (options.mode === 'apply')
                await this.repository.settleRecipient(
                  eventId,
                  recipient,
                  'in_app',
                  decision.outcome,
                  decision.code,
                  tx,
                );
            }
            const externalOutcome =
              decision.outcome !== 'eligible'
                ? decision.outcome
                : decision.externalEnabled
                  ? 'unavailable'
                  : 'suppressed';
            const externalCode =
              decision.outcome !== 'eligible'
                ? decision.code
                : decision.externalEnabled
                  ? 'external_unavailable'
                  : 'external_updates_disabled';
            if (externalOutcome === 'unavailable') counts.externalUnavailable++;
            if (options.mode === 'apply')
              await this.repository.settleRecipient(
                eventId,
                recipient,
                'external',
                externalOutcome,
                externalCode,
                tx,
              );
          }
          counts.processed = 1;
          if (options.mode === 'apply')
            await this.repository.settleEvent(eventId, 'processed', null, tx);
          return counts;
        },
      );
      if (one.retryable) retryableEventIds.push(eventId);
      for (const key of Object.keys(one) as (keyof typeof one)[])
        result[key] += one[key];
    }
    return { mode: options.mode, ...result, retryableEventIds };
  }
}
