import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { APP_CONFIG } from '../../config/config.js';
import type { RuntimeConfig } from '../../config/config.js';
import { DatabaseService } from '../../database/database.js';
import {
  ratingIdSchema,
  ratingPublicIdSchema,
  ratingTimeSchema,
} from '../../ratings/contracts.js';
import { ratingOrdinalSchema } from '../../ratings/cursor.js';
import { RatingsUpdatesSourceFacade } from '../../ratings/updates-source/facade.js';
import { RatingUpdatesProjectionFacade } from '../../ratings/updates-source/projection.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import {
  ratingNoticeLocatorSchema,
  ratingNoticePreviewSchema,
  ratingNoticeReasonSchema,
} from './contracts.js';
import {
  ratingLikeNoticeActorSchema,
  ratingLikeNoticeLocatorSchema,
  ratingLikeNoticePreviewSchema,
} from './like-contracts.js';
import type { RatingLikeNoticeRecipient } from './like-contracts.js';
import type { RatingNoticeRecipient } from './contracts.js';
import { RatingUpdatesRepository } from './repository.js';

export const ratingUpdatesWorkerSchema = z
  .strictObject({
    mode: z.enum(['dry-run', 'apply']).default('dry-run'),
    eventIds: z
      .array(ratingIdSchema)
      .max(50)
      .default([])
      .refine((ids) => new Set(ids).size === ids.length),
  })
  .refine((options) => options.mode !== 'apply' || options.eventIds.length > 0);
export type RatingUpdatesWorkerOptions = z.infer<
  typeof ratingUpdatesWorkerSchema
>;
const replyEventSchema = z.strictObject({
  kind: z.literal('reply').default('reply'),
  id: ratingPublicIdSchema,
  sequence: ratingOrdinalSchema,
  occurredAt: ratingTimeSchema,
  target: ratingNoticeLocatorSchema,
  recipients: z
    .array(
      z.strictObject({
        accountId: ratingPublicIdSchema,
        reason: ratingNoticeReasonSchema,
      }),
    )
    .max(2)
    .refine(
      (recipients) =>
        new Set(recipients.map((recipient) => recipient.accountId)).size ===
        recipients.length,
    ),
});
const likeEventSchema = z
  .strictObject({
    kind: z.literal('like'),
    id: ratingPublicIdSchema,
    sequence: ratingOrdinalSchema,
    occurredAt: ratingTimeSchema,
    actorAccountId: ratingPublicIdSchema,
    target: ratingLikeNoticeLocatorSchema,
    recipients: z
      .array(
        z.strictObject({
          accountId: ratingPublicIdSchema,
          reason: z.literal('like'),
        }),
      )
      .max(1),
  })
  .refine((event) =>
    event.recipients.every(
      (recipient) => recipient.accountId !== event.actorAccountId,
    ),
  );
const eventSchema = z.union([replyEventSchema, likeEventSchema]);
export function assertLocalRatingUpdatesWorker(config: RuntimeConfig): void {
  const url = new URL(config.DATABASE_URL);
  if (
    config.NODE_ENV === 'production' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    !['/whaleu_dev', '/whaleu_test'].includes(url.pathname)
  )
    throw new Error('Rating updates require a disposable local database');
}
export async function assertLocalRatingUpdatesConnection(
  tx: PoolClient,
): Promise<void> {
  const peer = (
    tx as PoolClient & { connection?: { stream?: { remoteAddress?: string } } }
  ).connection?.stream?.remoteAddress;
  if (
    !['localhost', '127.0.0.1', '::1', '[::1]'].includes(tx.host) ||
    !peer ||
    !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(peer)
  )
    throw new Error('Rating updates require an actual loopback connection');
  const name = (
    await tx.query<{ name: string }>('SELECT current_database() AS name')
  ).rows[0]?.name;
  if (!name || !['whaleu_dev', 'whaleu_test'].includes(name))
    throw new Error('Rating updates require a disposable database');
}
export function parseRatingUpdatesCommand(
  args: readonly string[],
): RatingUpdatesWorkerOptions {
  const remaining = [...args];
  let mode: 'dry-run' | 'apply' = 'dry-run';
  if (remaining[0] === 'dry-run' || remaining[0] === 'apply')
    mode = remaining.shift() as typeof mode;
  const eventIds = remaining.map((arg) => {
    const match = /^--event-id=(.+)$/.exec(arg);
    if (!match) throw new Error('Invalid rating updates arguments');
    return match[1]!;
  });
  return ratingUpdatesWorkerSchema.parse({ mode, eventIds });
}
const emptyCounts = () => ({
  processed: 0,
  alreadyProcessed: 0,
  missing: 0,
  ignored: 0,
  retryable: 0,
  materialized: 0,
  existing: 0,
  suppressed: 0,
  failed: 0,
});
type EventCounts = ReturnType<typeof emptyCounts>;
async function lockEvent(eventId: string, tx: PoolClient): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    `rating-in-app:${eventId}`,
  ]);
}
/** Explicit local materialization only. No dispatcher, provider, or external work. */
@Injectable()
export class RatingUpdatesWorker {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(RatingsUpdatesSourceFacade)
    private readonly source: RatingsUpdatesSourceFacade,
    @Inject(RatingUpdatesProjectionFacade)
    private readonly projection: RatingUpdatesProjectionFacade,
    @Inject(RatingUpdatesRepository)
    private readonly records: RatingUpdatesRepository,
  ) {}
  async run(input: Partial<RatingUpdatesWorkerOptions> = {}) {
    const options = ratingUpdatesWorkerSchema.parse(input);
    assertLocalRatingUpdatesWorker(this.config);
    if (
      options.mode === 'apply' &&
      this.config.RATINGS_UPDATES_PROCESSING !== 'manual'
    )
      throw new Error('Rating updates processing is disabled');
    // Verify the actual connection even for an empty selection, before any work.
    await this.database.transaction(assertLocalRatingUpdatesConnection, {
      isolationLevel: 'read committed',
    });
    const result = { requested: options.eventIds.length, ...emptyCounts() };
    const retryableEventIds: string[] = [];
    for (const eventId of options.eventIds) {
      let counts: EventCounts;
      try {
        counts = await this.database.transaction(
          async (tx) => {
            await assertLocalRatingUpdatesConnection(tx);
            await lockSafetyPolicy(tx);
            await lockEvent(eventId, tx);
            const counts = emptyCounts();
            if (await this.records.eventReceipt(eventId, tx))
              return { ...counts, alreadyProcessed: 1 };
            const source = await this.source.event(eventId, tx);
            if (source.status === 'missing') return { ...counts, missing: 1 };
            if (source.status === 'ignored') {
              if (options.mode === 'apply')
                await this.records.settleEvent(
                  eventId,
                  'ignored',
                  source.code,
                  tx,
                );
              return { ...counts, ignored: 1 };
            }
            const event = eventSchema.parse(source.event);
            if (event.id !== eventId)
              throw new Error('Mismatched rating update event');
            const recipients = [...event.recipients].sort((a, b) =>
              a.accountId.localeCompare(b.accountId),
            );
            const decisions = [];
            // Resolve every recipient's current authority and complete parent chain
            // before acquiring ANY notification owner. A failure rolls back all.
            for (const recipient of recipients) {
              const decision =
                event.kind === 'like'
                  ? await this.projection.eligibleLike(
                      event.target,
                      recipient as RatingLikeNoticeRecipient,
                      event.actorAccountId,
                      tx,
                      event.id,
                    )
                  : await this.projection.eligible(
                      event.target,
                      recipient as RatingNoticeRecipient,
                      tx,
                      event.id,
                    );
              if (decision.outcome === 'eligible' && event.kind === 'like') {
                ratingLikeNoticePreviewSchema.parse(decision.preview);
                if (!('actor' in decision))
                  throw new Error('Missing rating like actor');
                ratingLikeNoticeActorSchema.parse(decision.actor);
              } else if (decision.outcome === 'eligible') {
                const preview = ratingNoticePreviewSchema.parse(
                  decision.preview,
                );
                if (
                  preview.author.mode === 'anonymous' &&
                  preview.author.targetId !== event.target.targetId
                )
                  throw new Error('Mismatched rating preview');
              }
              decisions.push({ recipient, decision });
            }
            const unavailable = decisions.find(
              ({ decision }) => decision.outcome === 'unavailable',
            );
            if (unavailable && unavailable.decision.outcome === 'unavailable') {
              if (options.mode === 'apply')
                await this.records.retryable(
                  eventId,
                  unavailable.decision.code,
                  tx,
                );
              return { ...counts, retryable: 1 };
            }
            if (options.mode === 'apply')
              for (const recipient of recipients)
                await this.records.owner(recipient.accountId, tx, true);
            for (const { recipient, decision } of decisions) {
              if (decision.outcome === 'eligible') {
                if (event.kind === 'like') {
                  const likeRecipient = recipient as RatingLikeNoticeRecipient;
                  const outcome =
                    options.mode === 'apply'
                      ? await this.records.materializeLike(
                          event,
                          likeRecipient,
                          tx,
                        )
                      : (await this.records.existingLike(
                            event,
                            likeRecipient,
                            tx,
                          ))
                        ? 'existing'
                        : 'materialized';
                  counts[outcome]++;
                } else {
                  counts.materialized++;
                  if (options.mode === 'apply')
                    await this.records.materialize(
                      event,
                      recipient as RatingNoticeRecipient,
                      tx,
                    );
                }
              } else if (decision.outcome === 'suppressed') {
                counts.suppressed++;
                if (options.mode === 'apply')
                  await this.records.settleRecipient(
                    eventId,
                    recipient,
                    'suppressed',
                    decision.code,
                    tx,
                  );
              }
            }
            if (options.mode === 'apply')
              await this.records.settleEvent(eventId, 'processed', null, tx);
            return { ...counts, processed: 1 };
          },
          { isolationLevel: 'read committed' },
        );
      } catch {
        counts = { ...emptyCounts(), failed: 1, retryable: 1 };
        if (options.mode === 'apply') {
          // Separate transaction after rollback; the event guard prevents racing
          // a concurrent successful worker into a stale retry write.
          await this.database
            .transaction(
              async (tx) => {
                await assertLocalRatingUpdatesConnection(tx);
                await lockSafetyPolicy(tx);
                await lockEvent(eventId, tx);
                if (!(await this.records.eventReceipt(eventId, tx)))
                  await this.records.retryable(
                    eventId,
                    'processing_unavailable',
                    tx,
                  );
              },
              { isolationLevel: 'read committed' },
            )
            .catch(() => undefined);
        }
      }
      if (counts.retryable) retryableEventIds.push(eventId);
      for (const key of Object.keys(counts) as (keyof EventCounts)[])
        result[key] += counts[key];
    }
    return { mode: options.mode, ...result, retryableEventIds };
  }
}
