import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.js';
import { IdentityModule } from '../../identity/identity.module.js';
import { DiscoveryContinuationModule } from '../../community/discovery-continuation.module.js';
import { RatingRequestThrottlingModule } from '../../request-throttling/module.js';
import { RatingUpdatesSourceModule } from '../../ratings/updates-source/module.js';
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
  controllers: [RatingUpdatesController],
  providers: [
    RatingUpdatesCursors,
    RatingUpdatesRepository,
    RatingUpdatesReadService,
    RatingUpdatesWorker,
  ],
  exports: [RatingUpdatesWorker, RatingUpdatesReadService],
})
export class RatingUpdatesModule {}
