import {
  WindowDiscussionV2Controller,
  WindowDiscussionNoticesV2Controller,
} from './discussion/controller-v2.js';
import { WindowDiscussionMediaOwner } from './discussion/media-owner.js';
import {
  WindowDiscussionMediaService,
  WINDOW_DISCUSSION_MEDIA_RUNTIME,
} from './discussion/media/facade.js';
import type { WindowDiscussionMediaRuntime } from './discussion/media/facade.js';
import {
  WindowDiscussionMediaController,
  WindowDiscussionMultipartInterceptor,
} from './discussion/media/controller.js';
import { WindowDiscussionMediaThrottlingModule } from './discussion/media/module.js';
import { DatabaseService } from '../../database/database.js';
import { IdentityService } from '../../identity/identity.service.js';
import { MediaDeliveryBudgetModule } from '../../media/delivery-budget.module.js';
import { MediaDeliveryBudgetPool } from '../../media/delivery-budget.js';
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
    WindowDiscussionMediaThrottlingModule,
    MediaDeliveryBudgetModule,
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
    WindowDiscussionV2Controller,
    WindowDiscussionNoticesV2Controller,
    WindowDiscussionMediaController,
    WindowRatingsController,
    DishRecommendationsController,
    WindowDiscussionController,
    WindowDiscussionNoticesController,
  ],
  providers: [
    WindowDiscussionMediaOwner,
    WindowDiscussionMultipartInterceptor,
    { provide: WINDOW_DISCUSSION_MEDIA_RUNTIME, useValue: null },
    {
      provide: WindowDiscussionMediaService,
      inject: [
        DatabaseService,
        IdentityService,
        WindowDiscussionMediaOwner,
        WINDOW_DISCUSSION_MEDIA_RUNTIME,
        MediaDeliveryBudgetPool,
      ],
      useFactory: (
        db: DatabaseService,
        identity: IdentityService,
        owner: WindowDiscussionMediaOwner,
        runtime: WindowDiscussionMediaRuntime | null,
        budget: MediaDeliveryBudgetPool,
      ) =>
        new WindowDiscussionMediaService(db, identity, owner, runtime, budget),
    },
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
