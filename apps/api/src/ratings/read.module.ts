import { RatingScopedContextService } from './scoped/context.service.js';
import { RatingScopedRepository } from './scoped/repository.js';
import { RatingScopedProjection } from './scoped/projection.js';
import { RatingScopedSourceFacade } from './scoped/source.facade.js';
import { RatingCompatReadFacade } from './scoped/compat-read.facade.js';
import { RatingDeletionRepository } from './deletion/repository.js';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.js';
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
    DatabaseModule,
    IdentityModule,
    VerificationModule,
    AuthorizationModule,
    CampusModule,
    ProfileModule,
    SafetyPolicyModule,
    ContentReviewModule,
  ],
  providers: [
    RatingScopedContextService,
    RatingScopedRepository,
    RatingScopedProjection,
    RatingScopedSourceFacade,

    RatingCompatReadFacade,
    RatingDeletionRepository,
    RatingsAccessService,
    RatingsRepository,
    RatingDiscussionRepository,
    RatingDiscussionProjection,
  ],
  exports: [
    RatingScopedContextService,
    RatingScopedRepository,
    RatingScopedProjection,
    RatingScopedSourceFacade,

    RatingCompatReadFacade,
    RatingDeletionRepository,
    RatingsAccessService,
    RatingsRepository,
    RatingDiscussionRepository,
    RatingDiscussionProjection,
  ],
})
export class RatingsReadModule {}
