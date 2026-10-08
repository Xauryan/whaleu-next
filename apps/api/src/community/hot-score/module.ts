import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.js';
import { HotScoreEvaluator } from './evaluator.js';
import { HotScoreRepository } from './repository.js';
import { HotScoreService } from './service.js';

/** Mounted only by the explicit local CLI, never the public application graph. */
@Module({
  imports: [DatabaseModule],
  providers: [HotScoreEvaluator, HotScoreRepository, HotScoreService],
  exports: [HotScoreService],
})
export class HotScoreModule {}
