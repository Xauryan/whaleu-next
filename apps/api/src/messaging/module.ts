import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { VerificationModule } from '../verification/verification.module.js';
import { SafetyPolicyModule } from '../safety/policy.module.js';
import { CommunityModule } from '../community/community.module.js';
import { ProfileModule } from '../profile/profile.module.js';
import { ContentReviewModule } from '../community/content-review/content-review.module.js';
import { MessagingRequestThrottlingModule } from './throttling.module.js';
import { MessagingController } from './controller.js';
import { MessagingAccess } from './access.js';
import { MessagingRepository } from './repository.js';
import { MessagingRequests } from './requests.js';
import { MessagingMutationService } from './mutation.service.js';
import { MessagingReadService } from './read.service.js';
@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    VerificationModule,
    SafetyPolicyModule,
    CommunityModule,
    ProfileModule,
    ContentReviewModule,
    MessagingRequestThrottlingModule,
  ],
  controllers: [MessagingController],
  providers: [
    MessagingAccess,
    MessagingRepository,
    MessagingRequests,
    MessagingMutationService,
    MessagingReadService,
  ],
})
export class MessagingModule {}
