import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.js';
import { IdentityModule } from '../../identity/identity.module.js';
import { SafetyPolicyModule } from '../policy.module.js';
import { AccountModerationModule } from '../account-moderation/module.js';
import {
  AccountAppealsController,
  AccountAppealManagementController,
} from './controller.js';
import { AccountAppealsRepository } from './repository.js';
import { AccountAppealsService } from './service.js';
@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    SafetyPolicyModule,
    AccountModerationModule,
  ],
  providers: [AccountAppealsRepository, AccountAppealsService],
  controllers: [AccountAppealsController, AccountAppealManagementController],
  exports: [AccountAppealsService],
})
export class AccountAppealsModule {}
