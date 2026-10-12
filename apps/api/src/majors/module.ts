import {
  MajorDiscussionV2Controller,
  MajorDiscussionNoticesV2Controller,
} from './discussion/controller-v2.js';
import { MajorDiscussionMediaOwner } from './discussion/media-owner.js';
import {
  MajorDiscussionMediaService,
  MAJOR_DISCUSSION_MEDIA_RUNTIME,
} from './discussion/media/facade.js';
import type { MajorDiscussionMediaRuntime } from './discussion/media/facade.js';
import {
  MajorDiscussionMediaController,
  MajorDiscussionMultipartInterceptor,
} from './discussion/media/controller.js';
import { MajorDiscussionMediaThrottlingModule } from './discussion/media/module.js';
import { DatabaseService } from '../database/database.js';
import { IdentityService } from '../identity/identity.service.js';
import { MediaDeliveryBudgetModule } from '../media/delivery-budget.module.js';
import { MediaDeliveryBudgetPool } from '../media/delivery-budget.js';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { VerificationModule } from '../verification/verification.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { SafetyPolicyModule } from '../safety/policy.module.js';
import { ProfileModule } from '../profile/profile.module.js';
import { ContentReviewModule } from '../community/content-review/content-review.module.js';
import { DiscoveryContinuationModule } from '../community/discovery-continuation.module.js';
import { RatingRequestThrottlingModule } from '../request-throttling/module.js';
import { MajorDiscussionNoticeModule } from '../notifications/major-discussion/owner.js';
import {
  MajorDiscussionController,
  MajorDiscussionNoticesController,
} from './discussion/controller.js';
import { MajorDiscussionDeleteService } from './discussion/delete-service.js';
import { MajorDiscussionDeleteController } from './discussion/delete-controller.js';
import { MajorDiscussionService } from './discussion/service.js';
import { MajorDiscussionCursors } from './discussion/cursor.js';
import { MajorsController } from './controller.js';
import { MajorsService } from './service.js';
import { MajorCursors } from './cursor.js';
@Module({
  imports: [
    MajorDiscussionMediaThrottlingModule,
    MediaDeliveryBudgetModule,
    DatabaseModule,
    IdentityModule,
    VerificationModule,
    AuthorizationModule,
    SafetyPolicyModule,
    ProfileModule,
    ContentReviewModule,
    DiscoveryContinuationModule,
    RatingRequestThrottlingModule,
    MajorDiscussionNoticeModule,
  ],
  controllers: [
    MajorDiscussionV2Controller,
    MajorDiscussionNoticesV2Controller,
    MajorDiscussionMediaController,
    MajorDiscussionDeleteController,
    MajorDiscussionController,
    MajorDiscussionNoticesController,
    MajorsController,
  ],
  providers: [
    MajorDiscussionMediaOwner,
    MajorDiscussionMultipartInterceptor,
    { provide: MAJOR_DISCUSSION_MEDIA_RUNTIME, useValue: null },
    {
      provide: MajorDiscussionMediaService,
      inject: [
        DatabaseService,
        IdentityService,
        MajorDiscussionMediaOwner,
        MAJOR_DISCUSSION_MEDIA_RUNTIME,
        MediaDeliveryBudgetPool,
      ],
      useFactory: (
        db: DatabaseService,
        identity: IdentityService,
        owner: MajorDiscussionMediaOwner,
        runtime: MajorDiscussionMediaRuntime | null,
        budget: MediaDeliveryBudgetPool,
      ) =>
        new MajorDiscussionMediaService(db, identity, owner, runtime, budget),
    },

    MajorDiscussionDeleteService,
    MajorDiscussionService,
    MajorDiscussionCursors,
    MajorsService,
    MajorCursors,
  ],
})
export class MajorsModule {}
