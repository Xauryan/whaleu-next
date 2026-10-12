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
    IdentityModule,
    VerificationModule,
    SafetyPolicyModule,
    DiscoveryContinuationModule,
    RatingRequestThrottlingModule,
  ],
  controllers: [WindowRatingsController],
  providers: [WindowRatingsService, WindowRepository, WindowCursors],
})
export class WindowRatingsModule {}
