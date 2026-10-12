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
import { MajorDiscussionService } from './discussion/service.js';
import { MajorDiscussionCursors } from './discussion/cursor.js';
import { MajorsController } from './controller.js';
import { MajorsService } from './service.js';
import { MajorCursors } from './cursor.js';
@Module({
  imports: [
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
    MajorDiscussionController,
    MajorDiscussionNoticesController,
    MajorsController,
  ],
  providers: [
    MajorDiscussionService,
    MajorDiscussionCursors,
    MajorsService,
    MajorCursors,
  ],
})
export class MajorsModule {}
