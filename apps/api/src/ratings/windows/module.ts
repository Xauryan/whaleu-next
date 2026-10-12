import { WindowDiscussionNoticeModule } from '../../notifications/window-discussion/owner.js';
import { ProfileModule } from '../../profile/profile.module.js';
import {
  WindowDiscussionController,
  WindowDiscussionNoticesController,
} from './discussion/controller.js';
import { WindowDiscussionService } from './discussion/service.js';
import { WindowDiscussionCursors } from './discussion/cursor.js';
import { ContentReviewModule } from '../../community/content-review/content-review.module.js';
import { DishRecommendationsController } from './dishes/controller.js';
import { DishRecommendationsService } from './dishes/service.js';
import { DishCursors } from './dishes/cursor.js';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.js';
import { IdentityModule } from '../../identity/identity.module.js';
import { VerificationModule } from '../../verification/verification.module.js';
import { SafetyPolicyModule } from '../../safety/policy.module.js';
import { DiscoveryContinuationModule } from '../../community/discovery-continuation.module.js';
import { RatingRequestThrottlingModule } from '../../request-throttling/module.js';
import { WindowRatingsController } from './controller.js';
import { WindowRatingsService } from './service.js';
import { WindowRepository } from './repository.js';
import { WindowCursors } from './cursor.js';
@Module({
  imports: [
    DatabaseModule,
    ProfileModule,
    WindowDiscussionNoticeModule,
    ContentReviewModule,
    IdentityModule,
    VerificationModule,
    SafetyPolicyModule,
    DiscoveryContinuationModule,
    RatingRequestThrottlingModule,
  ],
  controllers: [
    WindowRatingsController,
    DishRecommendationsController,
    WindowDiscussionController,
    WindowDiscussionNoticesController,
  ],
  providers: [
    WindowRatingsService,
    WindowDiscussionService,
    WindowDiscussionCursors,
    WindowRepository,
    WindowCursors,
    DishRecommendationsService,
    DishCursors,
  ],
})
export class WindowRatingsModule {}
