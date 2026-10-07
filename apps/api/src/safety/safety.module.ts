import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { ProfileModule } from '../profile/profile.module.js';
import { VerificationModule } from '../verification/verification.module.js';
import { CommunityModule } from '../community/community.module.js';
import { SafetyPolicyModule } from './policy.module.js';
import { NamedBlockController } from './controller.js';
import { NamedBlockService } from './service.js';
@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    ProfileModule,
    VerificationModule,
    CommunityModule,
    SafetyPolicyModule,
  ],
  providers: [NamedBlockService],
  controllers: [NamedBlockController],
})
export class SafetyModule {}
