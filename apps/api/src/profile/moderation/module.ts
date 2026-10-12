import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.js';
import { IdentityModule } from '../../identity/identity.module.js';
import { AuthorizationModule } from '../../authorization/authorization.module.js';
import { CommunityModule } from '../../community/community.module.js';
import { ProfileModule } from '../profile.module.js';
import { ProfileModerationService } from './service.js';
import { ProfileModerationController } from './controller.js';
/** Application composition prevents a Profile -> Community -> Profile cycle. */
@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    AuthorizationModule,
    CommunityModule,
    ProfileModule,
  ],
  providers: [ProfileModerationService],
  controllers: [ProfileModerationController],
  exports: [ProfileModerationService],
})
export class ProfileModerationModule {}
