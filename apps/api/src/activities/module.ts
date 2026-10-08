import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { CampusModule } from '../campus/campus.module.js';
import { VerificationModule } from '../verification/verification.module.js';
import { SafetyPolicyModule } from '../safety/policy.module.js';
import { ActivityRequestThrottlingModule } from '../request-throttling/module.js';
import { DiscoveryContinuationModule } from '../community/discovery-continuation.module.js';
import { ActivitiesController } from './controller.js';
import { ActivitiesService } from './service.js';
import { ActivitiesRepository } from './repository.js';
import { ActivityAccessService } from './access.js';
import { ActivitiesCursorRepository } from './cursor.js';
@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    CampusModule,
    VerificationModule,
    SafetyPolicyModule,
    ActivityRequestThrottlingModule,
    DiscoveryContinuationModule,
  ],
  controllers: [ActivitiesController],
  providers: [
    ActivitiesService,
    ActivitiesRepository,
    ActivityAccessService,
    ActivitiesCursorRepository,
  ],
})
export class ActivitiesModule {}
