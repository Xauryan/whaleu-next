import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.js';
import { IdentityModule } from '../../identity/identity.module.js';
import { CommunityModule } from '../../community/community.module.js';
import { DiscoveryContinuationModule } from '../../community/discovery-continuation.module.js';
import { SocialUpdatesController } from './controller.js';
import { SocialUpdatesRepository } from './repository.js';
import { SocialUpdatesReadService } from './read.service.js';
import { SocialUpdatesCursors } from './cursor.js';
import { SocialUpdatesWorker } from './worker.js';
import { SocialUpdatesDispatcher } from './dispatcher.js';
@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    CommunityModule,
    DiscoveryContinuationModule,
  ],
  controllers: [SocialUpdatesController],
  providers: [
    SocialUpdatesRepository,
    SocialUpdatesReadService,
    SocialUpdatesCursors,
    SocialUpdatesWorker,
    SocialUpdatesDispatcher,
  ],
  exports: [
    SocialUpdatesReadService,
    SocialUpdatesWorker,
    SocialUpdatesDispatcher,
  ],
})
export class SocialUpdatesModule {}
