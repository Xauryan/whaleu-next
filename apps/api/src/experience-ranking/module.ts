import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { ProfileModule } from '../profile/profile.module.js';
import { SafetyPolicyModule } from '../safety/policy.module.js';
import { ExperienceRankingSourceModule } from '../experience/ranking-source.module.js';
import { ExperienceRankingController } from './controller.js';
import { ExperienceRankingService } from './service.js';
@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    ProfileModule,
    SafetyPolicyModule,
    ExperienceRankingSourceModule,
  ],
  controllers: [ExperienceRankingController],
  providers: [ExperienceRankingService],
})
export class ExperienceRankingModule {}
