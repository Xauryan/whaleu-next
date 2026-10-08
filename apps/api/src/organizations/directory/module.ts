import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.js';
import { IdentityModule } from '../../identity/identity.module.js';
import { CampusModule } from '../../campus/campus.module.js';
import { VerificationModule } from '../../verification/verification.module.js';
import { SafetyPolicyModule } from '../../safety/policy.module.js';
import { DirectoryRequestThrottlingModule } from '../../request-throttling/module.js';
import { DiscoveryContinuationModule } from '../../community/discovery-continuation.module.js';
import { DirectoryController } from './controller.js';
import { DirectoryService } from './service.js';
import { DirectoryRepository } from './repository.js';
import { DirectoryAccessService } from './access.js';
import { DirectoryCursorRepository } from './cursor.js';
@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    CampusModule,
    VerificationModule,
    SafetyPolicyModule,
    DirectoryRequestThrottlingModule,
    DiscoveryContinuationModule,
  ],
  controllers: [DirectoryController],
  providers: [
    DirectoryService,
    DirectoryRepository,
    DirectoryAccessService,
    DirectoryCursorRepository,
  ],
})
export class DirectoryModule {}
