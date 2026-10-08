import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { CampusModule } from '../campus/campus.module.js';
import { SafetyPolicyModule } from '../safety/policy.module.js';
import { DiscoveryContinuationModule } from '../community/discovery-continuation.module.js';
import { AnnouncementRequestThrottlingModule } from '../request-throttling/module.js';
import {
  AnnouncementsController,
  OwnAnnouncementsController,
} from './controller.js';
import { AnnouncementsService } from './service.js';
import { AnnouncementsRepository } from './repository.js';
import { AnnouncementsAccessService } from './access.js';
import { AnnouncementsCursorRepository } from './cursor.js';
@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    CampusModule,
    SafetyPolicyModule,
    DiscoveryContinuationModule,
    AnnouncementRequestThrottlingModule,
  ],
  controllers: [AnnouncementsController, OwnAnnouncementsController],
  providers: [
    AnnouncementsService,
    AnnouncementsRepository,
    AnnouncementsAccessService,
    AnnouncementsCursorRepository,
  ],
})
export class AnnouncementsModule {}
