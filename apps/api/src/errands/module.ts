import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { VerificationModule } from '../verification/verification.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { CampusModule } from '../campus/campus.module.js';
import { ProfileModule } from '../profile/profile.module.js';
import { SafetyPolicyModule } from '../safety/policy.module.js';
import { ContentReviewModule } from '../community/content-review/content-review.module.js';
import { DiscoveryContinuationModule } from '../community/discovery-continuation.module.js';
import { ErrandNotificationsModule } from '../notifications/errand.module.js';
import { ErrandRequestThrottlingModule } from '../request-throttling/module.js';
import { ErrandsController } from './controller.js';
import { ErrandsService } from './service.js';
import { ErrandAccessService } from './access.js';
import { ErrandsRepository } from './repository.js';
import { ErrandRequests } from './requests.js';
@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    VerificationModule,
    AuthorizationModule,
    CampusModule,
    ProfileModule,
    SafetyPolicyModule,
    ContentReviewModule,
    DiscoveryContinuationModule,
    ErrandNotificationsModule,
    ErrandRequestThrottlingModule,
  ],
  controllers: [ErrandsController],
  providers: [
    ErrandsService,
    ErrandAccessService,
    ErrandsRepository,
    ErrandRequests,
  ],
})
export class ErrandsModule {}
