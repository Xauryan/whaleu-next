import { RatingDeletionRepository } from './deletion/repository.js';
import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { VerificationModule } from '../verification/verification.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { CampusModule } from '../campus/campus.module.js';
import { ProfileModule } from '../profile/profile.module.js';
import { SafetyPolicyModule } from '../safety/policy.module.js';
import { ContentReviewModule } from '../community/content-review/content-review.module.js';
import { RatingsAccessService } from './access.js';
import { RatingsRepository } from './repository.js';
import { RatingDiscussionRepository } from './discussion-repository.js';
import { RatingDiscussionProjection } from './discussion-projection.js';
@Module({
  imports: [
    IdentityModule,
    VerificationModule,
    AuthorizationModule,
    CampusModule,
    ProfileModule,
    SafetyPolicyModule,
    ContentReviewModule,
  ],
  providers: [
    RatingDeletionRepository,
    RatingsAccessService,
    RatingsRepository,
    RatingDiscussionRepository,
    RatingDiscussionProjection,
  ],
  exports: [
    RatingDeletionRepository,
    RatingsAccessService,
    RatingsRepository,
    RatingDiscussionRepository,
    RatingDiscussionProjection,
  ],
})
export class RatingsReadModule {}
