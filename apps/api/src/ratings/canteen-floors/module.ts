import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.js';
import { IdentityModule } from '../../identity/identity.module.js';
import { VerificationModule } from '../../verification/verification.module.js';
import { SafetyPolicyModule } from '../../safety/policy.module.js';
import { RatingRequestThrottlingModule } from '../../request-throttling/module.js';
import { FloorRatingsController } from './controller.js';
import { FloorRatingsService } from './service.js';
import { FloorRepository } from './repository.js';
@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    VerificationModule,
    SafetyPolicyModule,
    RatingRequestThrottlingModule,
  ],
  controllers: [FloorRatingsController],
  providers: [FloorRatingsService, FloorRepository],
})
export class FloorRatingsModule {}
