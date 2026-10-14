import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { ProfileModule } from '../profile/profile.module.js';
import { VerificationModule } from '../verification/verification.module.js';
import { CampusModule } from '../campus/campus.module.js';
import { SafetyPolicyModule } from '../safety/policy.module.js';
import { SchoolUidModule } from '../school-uid/module.js';
import { SchoolAdminManagementRepository } from '../authorization/school-admin-management/repository.js';
import {
  SchoolIdentityController,
  SchoolUidLookupController,
} from './controller.js';
import { SchoolIdentityService } from './service.js';
import { SchoolIdentityRepository } from './repository.js';
@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    ProfileModule,
    VerificationModule,
    CampusModule,
    SafetyPolicyModule,
    SchoolUidModule,
  ],
  controllers: [SchoolIdentityController, SchoolUidLookupController],
  providers: [
    SchoolIdentityService,
    SchoolIdentityRepository,
    SchoolAdminManagementRepository,
  ],
})
export class SchoolIdentityModule {}
