import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.js';
import { CommunitySubscriptionComponentModule } from '../subscription-component/module.js';
import { CommunityLikeComponentModule } from '../like-component/module.js';
import { CommunityCommentComponentModule } from '../comment-component/module.js';
import { HotScoreEvaluator } from './evaluator.js';
import { HotScoreRepository } from './repository.js';
import { HotScoreStorage } from './storage.js';
import { HotScoreMaterializer } from './materializer.js';
import { HotFeedProcessing } from './processing.js';
/** No lifecycle hooks or timers; the guarded local CLI service remains separate. */
@Module({
  imports: [
    DatabaseModule,
    CommunitySubscriptionComponentModule,
    CommunityLikeComponentModule,
    CommunityCommentComponentModule,
  ],
  providers: [
    HotScoreEvaluator,
    HotScoreRepository,
    HotScoreStorage,
    HotScoreMaterializer,
    HotFeedProcessing,
  ],
  exports: [
    HotScoreRepository,
    HotScoreStorage,
    HotScoreMaterializer,
    HotFeedProcessing,
  ],
})
export class HotFeedProcessingModule {}
