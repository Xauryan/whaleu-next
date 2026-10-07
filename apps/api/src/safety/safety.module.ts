import { AuthorizationModule } from '../authorization/authorization.module.js';
import { SystemNoticesModule } from '../notifications/system-notices/system-notices.module.js';
import { ReportingService } from './reporting/service.js';
import { ReportsRepository } from './reporting/repository.js';
import { ReportingController } from './reporting/controller.js';
import { JurySettlementService } from './reporting/settlement.js';
import { JuryWorker, JuryDispatcher } from './reporting/worker.js';
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
    AuthorizationModule,
    SystemNoticesModule,
    IdentityModule,
    ProfileModule,
    VerificationModule,
    CommunityModule,
    SafetyPolicyModule,
  ],
  providers: [
    NamedBlockService,
    ReportingService,
    ReportsRepository,
    JurySettlementService,
    JuryWorker,
    JuryDispatcher,
  ],
  controllers: [NamedBlockController, ReportingController],
})
export class SafetyModule {}
