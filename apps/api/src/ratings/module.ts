import { RatingsReadModule } from './read.module.js';
import { ExperienceIngressModule } from '../experience/ingress.js';
import { RatingEffectsCapture } from './effects/capture.js';
import { RatingDiscussionController } from './discussion-controller.js';
import { RatingDiscussionService } from './discussion-service.js';
import { RatingReplyRequests } from './discussion-requests.js';
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
import { RatingRequestThrottlingModule } from '../request-throttling/module.js';
import { RatingsController } from './controller.js';
import { RatingsService } from './service.js';
import { RatingsRequests } from './requests.js';
import { RatingsCursors } from './cursor.js';
@Module({
  imports: [
    DatabaseModule,
    RatingsReadModule,
    ExperienceIngressModule,
    IdentityModule,
    VerificationModule,
    AuthorizationModule,
    CampusModule,
    ProfileModule,
    SafetyPolicyModule,
    ContentReviewModule,
    DiscoveryContinuationModule,
    RatingRequestThrottlingModule,
  ],
  controllers: [RatingsController, RatingDiscussionController],
  providers: [
    RatingsService,
    RatingEffectsCapture,
    RatingDiscussionService,
    RatingReplyRequests,
    RatingsRequests,
    RatingsCursors,
  ],
})
export class RatingsModule {}
