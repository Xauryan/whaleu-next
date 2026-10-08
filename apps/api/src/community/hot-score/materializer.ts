import { boundHotTransaction } from './transaction.js';
import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.js';
import { validateHotScoreSnapshot } from './contracts.js';
import { currentHotScoreCertificate } from './certificate.js';
import { HotScoreEvaluator } from './evaluator.js';
import { HotScoreRepository } from './repository.js';
import { HotScoreStorage } from './storage.js';

export type HotRefreshStatus =
  | 'current'
  | 'refreshed'
  | 'missing'
  | 'blockedCoverage'
  | 'blockedFreshness'
  | 'unavailable';
@Injectable()
export class HotScoreMaterializer {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(HotScoreRepository) private readonly records: HotScoreRepository,
    @Inject(HotScoreStorage) private readonly storage: HotScoreStorage,
    @Inject(HotScoreEvaluator) private readonly evaluator: HotScoreEvaluator,
  ) {}
  refresh(postId: string): Promise<HotRefreshStatus> {
    return this.database.transaction(
      async (tx) => {
        await boundHotTransaction(tx);
        if (!(await this.records.lockPost(postId, tx))) return 'missing';
        if (!(await this.records.coverage(postId, tx)))
          return 'blockedCoverage';
        await this.records.lockStates(postId, tx);
        const snapshot = await this.records.snapshot(postId, tx);
        if (!snapshot) return 'missing';
        const ready = validateHotScoreSnapshot(snapshot);
        if (ready.status !== 'ready') return ready.status;
        const existing = await this.storage.certificate(postId, tx);
        if (existing && currentHotScoreCertificate(existing, ready.snapshot))
          return 'current';
        await this.storage.replace(
          ready.snapshot,
          await this.evaluator.evaluate(ready.inputs, tx),
          tx,
        );
        return 'refreshed';
      },
      { isolationLevel: 'read committed' },
    );
  }
}
