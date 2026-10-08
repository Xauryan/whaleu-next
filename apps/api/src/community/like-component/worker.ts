import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.js';
import type { RuntimeConfig } from '../../config/config.js';
import { DatabaseService } from '../../database/database.js';
import {
  assertLocalExperienceWorker,
  assertLocalExperienceConnection,
} from '../../experience/worker.js';
import { likeWorkerSchema } from './contracts.js';
import type { LikeWorkerOptions } from './contracts.js';
import { LikeComponentSettlement } from './settlement.js';
export { parseLikeCommand } from './contracts.js';
// Reuse the established URL, socket-peer and actual database guard unchanged.
export const assertLocalLikeWorker = assertLocalExperienceWorker;
export const assertLocalLikeConnection = assertLocalExperienceConnection;
@Injectable()
export class LikeComponentWorker {
  constructor(
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(LikeComponentSettlement)
    private readonly settlement: LikeComponentSettlement,
  ) {}
  async run(input: Partial<LikeWorkerOptions> = {}) {
    const options = likeWorkerSchema.parse(input);
    assertLocalLikeWorker(this.config);
    if (
      options.mode === 'apply' &&
      this.config.LIKE_COMPONENT_PROCESSING === 'disabled'
    )
      throw new Error('Like processing is disabled');
    const summary = {
      requested: options.sourceIds.length,
      applied: 0,
      alreadyCompleted: 0,
      blockedBaseline: 0,
      blockedPredecessor: 0,
      sourceUnavailable: 0,
      missing: 0,
      pending: 0,
      failed: 0,
    };
    for (const id of options.sourceIds) {
      try {
        const result = await this.database.transaction(
          async (tx) => {
            if (options.mode === 'dry-run')
              await tx.query('SET TRANSACTION READ ONLY');
            await assertLocalLikeConnection(tx);
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
