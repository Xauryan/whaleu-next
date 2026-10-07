import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { ProfileModule } from '../profile/profile.module.js';
import { CommunityModule } from '../community/community.module.js';
import { SafetyPolicyModule } from '../safety/policy.module.js';
import {
  OwnPublicProfileController,
  PublicProfileController,
} from './controller.js';
import { ProfileDiscoveryService } from './service.js';

@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    ProfileModule,
    CommunityModule,
    SafetyPolicyModule,
  ],
  controllers: [PublicProfileController, OwnPublicProfileController],
  providers: [ProfileDiscoveryService],
})
export class ProfileDiscoveryModule {}
