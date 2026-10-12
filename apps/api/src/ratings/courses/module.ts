import { AuthorizationModule } from '../../authorization/authorization.module.js';
import { ContentReviewModule } from '../../community/content-review/content-review.module.js';
import { CourseCommentsController } from './comments/controller.js';
import { CourseCommentsService } from './comments/service.js';
import { CourseCommentCursors } from './comments/cursor.js';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.js';
import { IdentityModule } from '../../identity/identity.module.js';
import { VerificationModule } from '../../verification/verification.module.js';
import { CampusModule } from '../../campus/campus.module.js';
import { SafetyPolicyModule } from '../../safety/policy.module.js';
import { DiscoveryContinuationModule } from '../../community/discovery-continuation.module.js';
import { RatingRequestThrottlingModule } from '../../request-throttling/module.js';
import { CourseRatingsController } from './controller.js';
import { CourseRatingsService } from './service.js';
import { CourseRepository } from './repository.js';
import { CourseCursors } from './cursor.js';
@Module({
  imports: [
    AuthorizationModule,
    ContentReviewModule,
    DatabaseModule,
    IdentityModule,
    VerificationModule,
    CampusModule,
    SafetyPolicyModule,
    DiscoveryContinuationModule,
    RatingRequestThrottlingModule,
  ],
  controllers: [CourseCommentsController, CourseRatingsController],
  providers: [
    CourseCommentsService,
    CourseCommentCursors,
    CourseRatingsService,
    CourseRepository,
    CourseCursors,
  ],
})
export class CourseRatingsModule {}
