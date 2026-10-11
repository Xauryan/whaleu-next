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
    DatabaseModule,
    IdentityModule,
    VerificationModule,
    CampusModule,
    SafetyPolicyModule,
    DiscoveryContinuationModule,
    RatingRequestThrottlingModule,
  ],
  controllers: [CourseRatingsController],
  providers: [CourseRatingsService, CourseRepository, CourseCursors],
})
export class CourseRatingsModule {}
