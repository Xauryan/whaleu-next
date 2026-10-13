import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.js';
import { IdentityModule } from '../../identity/identity.module.js';
import { ProfileModule } from '../../profile/profile.module.js';
import { VerificationModule } from '../../verification/verification.module.js';
import { CampusModule } from '../../campus/campus.module.js';
import { SchoolAdminTitleEntitlementModule } from '../../experience/school-admin-title.js';
import { SchoolAdminManagementController } from './controller.js';
import { SchoolAdminManagementService } from './service.js';
import { SchoolAdminManagementRepository } from './repository.js';
@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    ProfileModule,
    VerificationModule,
    CampusModule,
    SchoolAdminTitleEntitlementModule,
  ],
  controllers: [SchoolAdminManagementController],
  providers: [SchoolAdminManagementService, SchoolAdminManagementRepository],
})
export class SchoolAdminManagementModule {}
