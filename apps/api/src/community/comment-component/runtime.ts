import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG } from '../../config/config.js';
import type { RuntimeConfig } from '../../config/config.js';
import { DatabaseService } from '../../database/database.js';
import {
  assertLocalExperienceWorker,
  assertLocalExperienceConnection,
} from '../../experience/worker.js';
import { boundHotTransaction } from '../hot-score/transaction.js';
import { CommentComponentRepository } from './repository.js';
import { CommentComponentSettlement } from './settlement.js';
@Injectable()
export class CommentComponentRuntime {
  constructor(
    @Inject(APP_CONFIG) private readonly config: RuntimeConfig,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CommentComponentRepository)
    private readonly records: CommentComponentRepository,
    @Inject(CommentComponentSettlement)
    private readonly settlement: CommentComponentSettlement,
  ) {}
  processNext(postId: string, mode: 'manual_only' | 'automatic') {
    if (
      this.config.HOT_FEED_PROCESSING !== mode ||
      this.config.COMMENT_COMPONENT_PROCESSING !== mode
    )
      throw new Error('Component runtime processing is disabled');
    if (mode === 'manual_only') assertLocalExperienceWorker(this.config);
    return this.database.transaction(
      async (tx) => {
        await boundHotTransaction(tx);
        if (mode === 'manual_only') await assertLocalExperienceConnection(tx);
        // No scheduler/source claim lock. Exactly one source in this transaction.
        const id = await this.records.nextSource(postId, tx);
        return id === null
          ? ('idle' as const)
          : this.settlement.process(id, tx, true);
      },
      { isolationLevel: 'read committed' },
    );
  }
}
