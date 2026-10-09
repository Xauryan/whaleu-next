import { RatingSubscriptionUpdatesController } from './subscription-controller.js';
import { RatingSubscriptionUpdatesReadService } from './subscription-read.service.js';
import { RatingSubscriptionUpdatesRepository } from './subscription-repository.js';
import { RatingSubscriptionUpdatesCursors } from './subscription-cursor.js';
import { RatingSubscriptionUpdatesWorker } from './subscription-worker.js';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.js';
import { IdentityModule } from '../../identity/identity.module.js';
import { DiscoveryContinuationModule } from '../../community/discovery-continuation.module.js';
import { RatingRequestThrottlingModule } from '../../request-throttling/module.js';
import { RatingUpdatesSourceModule } from '../../ratings/updates-source/module.js';
import { RatingLikeUpdatesController } from './like-controller.js';
import { RatingLikeUpdatesReadService } from './like-read.service.js';
import { RatingUpdatesController } from './controller.js';
import { RatingUpdatesCursors } from './cursor.js';
import { RatingUpdatesRepository } from './repository.js';
import { RatingUpdatesReadService } from './read.service.js';
import { RatingUpdatesWorker } from './worker.js';

@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    DiscoveryContinuationModule,
    RatingRequestThrottlingModule,
    RatingUpdatesSourceModule,
  ],
  controllers: [
    RatingUpdatesController,
    RatingLikeUpdatesController,
    RatingSubscriptionUpdatesController,
  ],
  providers: [
    RatingSubscriptionUpdatesReadService,
    RatingSubscriptionUpdatesRepository,
    RatingSubscriptionUpdatesCursors,
    RatingSubscriptionUpdatesWorker,
    RatingUpdatesCursors,
    RatingUpdatesRepository,
    RatingUpdatesReadService,
    RatingLikeUpdatesReadService,
    RatingUpdatesWorker,
  ],
  exports: [
    RatingSubscriptionUpdatesReadService,
    RatingSubscriptionUpdatesWorker,
    RatingUpdatesWorker,
    RatingUpdatesReadService,
    RatingLikeUpdatesReadService,
  ],
})
export class RatingUpdatesModule {}
