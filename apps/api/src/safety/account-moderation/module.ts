import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.js';
import { IdentityModule } from '../../identity/identity.module.js';
import { AuthorizationModule } from '../../authorization/authorization.module.js';
import { SafetyPolicyModule } from '../policy.module.js';
import { AccountPunishmentOwner } from './owner.js';
import { AccountModerationService } from './service.js';
import {
  AccountPunishmentManagementController,
  OwnAccountModerationController,
} from './controller.js';
@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    AuthorizationModule,
    SafetyPolicyModule,
  ],
  providers: [AccountPunishmentOwner, AccountModerationService],
  controllers: [
    OwnAccountModerationController,
    AccountPunishmentManagementController,
  ],
  exports: [AccountPunishmentOwner],
})
export class AccountModerationModule {}
