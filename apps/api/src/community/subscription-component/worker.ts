import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.js';
import type { RuntimeConfig } from '../../config/config.js';
import { DatabaseService } from '../../database/database.js';
import {
  assertLocalExperienceWorker,
  assertLocalExperienceConnection,
} from '../../experience/worker.js';
import { subscriptionWorkerSchema } from './contracts.js';
import type { SubscriptionWorkerOptions } from './contracts.js';
import { SubscriptionComponentSettlement } from './settlement.js';
export { parseSubscriptionCommand } from './contracts.js';
// Reuse the established URL, socket-peer and actual database guard unchanged.
export const assertLocalSubscriptionWorker = assertLocalExperienceWorker;
export const assertLocalSubscriptionConnection =
  assertLocalExperienceConnection;
@Injectable()
export class SubscriptionComponentWorker {
  constructor(
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(SubscriptionComponentSettlement)
    private readonly settlement: SubscriptionComponentSettlement,
  ) {}
  async run(input: Partial<SubscriptionWorkerOptions> = {}) {
    const options = subscriptionWorkerSchema.parse(input);
    assertLocalSubscriptionWorker(this.config);
    if (
      options.mode === 'apply' &&
      this.config.SUBSCRIPTION_COMPONENT_PROCESSING === 'disabled'
    )
      throw new Error('Subscription processing is disabled');
    const summary = {
      requested: options.obligationIds.length,
      applied: 0,
      alreadyCompleted: 0,
      blockedBaseline: 0,
      blockedPredecessor: 0,
      sourceUnavailable: 0,
      missing: 0,
      pending: 0,
      failed: 0,
    };
    for (const id of options.obligationIds) {
      try {
        const result = await this.database.transaction(
          async (tx) => {
            if (options.mode === 'dry-run')
              await tx.query('SET TRANSACTION READ ONLY');
            await assertLocalSubscriptionConnection(tx);
            return this.settlement.process(id, tx, options.mode === 'apply');
          },
          { isolationLevel: 'read committed' },
        );
        summary[result]++;
      } catch {
        summary.failed++;
      }
    }
    return {
      mode: options.mode,
      advisory: options.mode === 'dry-run',
      ...summary,
    };
  }
}
