import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { APP_CONFIG } from '../../config/config.js';
import type { RuntimeConfig } from '../../config/config.js';
import { DatabaseService } from '../../database/database.js';
import {
  assertLocalExperienceWorker,
  assertLocalExperienceConnection,
} from '../../experience/worker.js';
import { SubscriptionComponentRuntime } from '../subscription-component/runtime.js';
import { LikeComponentRuntime } from '../like-component/runtime.js';
import { CommentComponentRuntime } from '../comment-component/runtime.js';
import { validateHotScoreSnapshot } from './contracts.js';
import { HotScoreMaterializer } from './materializer.js';
import { boundHotTransaction } from './transaction.js';
import { HotScoreRepository } from './repository.js';
import { HotScoreStorage } from './storage.js';

export const HOT_PROCESSING_POST_BOUND = 20;
export const HOT_PROCESSING_COMPONENT_BOUND = 50;
export const HOT_PROCESSING_CYCLE_MS = 4000;
const selectedSchema = z
  .array(z.uuid().transform((id) => id.toLowerCase()))
  .min(1)
  .max(HOT_PROCESSING_POST_BOUND)
  .refine((ids) => new Set(ids).size === ids.length);
export interface HotProcessingSummary {
  attempted: number;
  componentTransactions: number;
  current: number;
  blocked: number;
  failed: number;
}
@Injectable()
export class HotFeedProcessing {
  constructor(
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(HotScoreRepository) private readonly records: HotScoreRepository,
    @Inject(HotScoreStorage) private readonly storage: HotScoreStorage,
    @Inject(HotScoreMaterializer)
    private readonly materializer: HotScoreMaterializer,
    @Inject(SubscriptionComponentRuntime)
    private readonly subscriptions: SubscriptionComponentRuntime,
    @Inject(LikeComponentRuntime) private readonly likes: LikeComponentRuntime,
    @Inject(CommentComponentRuntime)
    private readonly comments: CommentComponentRuntime,
  ) {}
  private assertMode(mode: 'manual_only' | 'automatic'): void {
    if (
      this.config.HOT_FEED_PROCESSING !== mode ||
      [
        this.config.SUBSCRIPTION_COMPONENT_PROCESSING,
        this.config.LIKE_COMPONENT_PROCESSING,
        this.config.COMMENT_COMPONENT_PROCESSING,
      ].some((value) => value !== mode)
    )
      throw new Error('Hot feed processing is disabled or incoherent');
    if (mode === 'manual_only') assertLocalExperienceWorker(this.config);
  }
  /** Explicit, bounded operator bootstrap only for already independent native
   * baselines. It never creates baselines, infers history or runs on a read. */
  async processSelected(
    input: readonly string[],
  ): Promise<HotProcessingSummary> {
    this.assertMode('manual_only');
    const ids = selectedSchema.parse(input);
    const enrolled: string[] = [];
    for (const id of ids) {
      const accepted = await this.database.transaction(
        async (tx) => {
          await boundHotTransaction(tx);
          await assertLocalExperienceConnection(tx);
          if (
            !(await this.records.lockPost(id, tx)) ||
            !(await this.records.coverage(id, tx))
          )
            return false;
          await this.records.lockStates(id, tx);
          const snapshot = await this.records.snapshot(id, tx);
          if (!snapshot) return false;
          const result = validateHotScoreSnapshot(snapshot);
          if (result.status !== 'ready' && result.status !== 'blockedFreshness')
            return false;
          await this.storage.enroll(id, tx);
          return true;
        },
        { isolationLevel: 'read committed' },
      );
      if (accepted) enrolled.push(id);
    }
    const ordered = await this.database.transaction(
      async (tx) => {
        await boundHotTransaction(tx);
        await assertLocalExperienceConnection(tx);
        return this.storage.orderSelected(enrolled, tx);
      },
      { isolationLevel: 'read committed' },
    );
    const summary = await this.run(ordered, 'manual_only', () => false);
    return {
      ...summary,
      blocked: summary.blocked + ids.length - enrolled.length,
    };
  }
  async cycle(
    stopping: () => boolean = () => false,
  ): Promise<HotProcessingSummary> {
    this.assertMode('automatic');
    const ids = await this.database.transaction(
      async (tx) => {
        await boundHotTransaction(tx);
        return this.storage.due(tx, HOT_PROCESSING_POST_BOUND);
      },
      { isolationLevel: 'read committed' },
    );
    return this.run(ids, 'automatic', stopping);
  }
  private async run(
    ids: readonly string[],
    mode: 'manual_only' | 'automatic',
    stopping: () => boolean,
  ): Promise<HotProcessingSummary> {
    const summary: HotProcessingSummary = {
      attempted: 0,
      componentTransactions: 0,
      current: 0,
      blocked: 0,
      failed: 0,
    };
    const start = performance.now();
    const attempted = new Set<string>();
    for (const id of ids) {
      if (
        stopping() ||
        performance.now() - start >= HOT_PROCESSING_CYCLE_MS ||
        attempted.size >= HOT_PROCESSING_POST_BOUND ||
        summary.componentTransactions + 3 > HOT_PROCESSING_COMPONENT_BOUND
      )
        break;
      if (attempted.has(id)) continue;
      attempted.add(id);
      summary.attempted++;
      let result: 'current' | 'blocked' | 'failed' = 'blocked';
      try {
        let failed = false;
        // Every post gets at most one source per owner per round. A poisoned
        // owner cannot prevent other owners or unrelated posts progressing.
        for (const owner of [this.subscriptions, this.likes, this.comments]) {
          if (
            stopping() ||
            summary.componentTransactions >= HOT_PROCESSING_COMPONENT_BOUND ||
            performance.now() - start >= HOT_PROCESSING_CYCLE_MS
          )
            break;
          summary.componentTransactions++;
          try {
            const outcome = await owner.processNext(id, mode);
            if (!['idle', 'applied', 'alreadyCompleted'].includes(outcome))
              failed = true;
          } catch {
            failed = true;
          }
        }
        if (
          !stopping() &&
          performance.now() - start < HOT_PROCESSING_CYCLE_MS
        ) {
          const status = await this.materializer.refresh(id);
          result =
            status === 'current' || status === 'refreshed'
              ? 'current'
              : failed
                ? 'failed'
                : 'blocked';
        } else result = failed ? 'failed' : 'blocked';
      } catch {
        result = 'failed';
      }
      summary[result]++;
      try {
        await this.database.transaction(
          async (tx) => {
            await boundHotTransaction(tx);
            await this.storage.schedule(id, result, tx);
          },
          { isolationLevel: 'read committed' },
        );
      } catch {
        /* Committed effects replay safely; the next cycle rechecks proof. */
      }
    }
    return summary;
  }
}
