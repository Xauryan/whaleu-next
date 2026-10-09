import { RatingsSubscriptionUpdatesSourceFacade } from './subscription-facade.js';
import { RatingSubscriptionUpdatesProjectionFacade } from './subscription-projection.js';
import { ProfileModule } from '../../profile/profile.module.js';
import { SafetyPolicyModule } from '../../safety/policy.module.js';
import { Module } from '@nestjs/common';
import { RatingsReadModule } from '../read.module.js';
import { RatingsUpdatesSourceFacade } from './facade.js';
import { RatingUpdatesProjectionFacade } from './projection.js';
@Module({
  imports: [RatingsReadModule, ProfileModule, SafetyPolicyModule],
  providers: [
    RatingsUpdatesSourceFacade,
    RatingUpdatesProjectionFacade,
    RatingsSubscriptionUpdatesSourceFacade,
    RatingSubscriptionUpdatesProjectionFacade,
  ],
  exports: [
    RatingsUpdatesSourceFacade,
    RatingUpdatesProjectionFacade,
    RatingsSubscriptionUpdatesSourceFacade,
    RatingSubscriptionUpdatesProjectionFacade,
  ],
})
export class RatingUpdatesSourceModule {}
