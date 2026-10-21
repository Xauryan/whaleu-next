import { ProfileStatsController } from './stats.controller.js';
import { ProfileStatsService } from './stats.service.js';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { ProfileModule } from '../profile/profile.module.js';
import { SafetyPolicyModule } from '../safety/policy.module.js';
import { ProfileDetailsController } from './controller.js';
import { ProfileDetailsService } from './service.js';
import { ProfileDetailsRepository } from './repository.js';
@Module({
  imports: [DatabaseModule, IdentityModule, ProfileModule, SafetyPolicyModule],
  controllers: [ProfileDetailsController, ProfileStatsController],
  providers: [
    ProfileDetailsService,
    ProfileDetailsRepository,
    ProfileStatsService,
  ],
})
export class ProfileDetailsModule {}
