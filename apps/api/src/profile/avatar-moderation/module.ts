import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.js';
import { IdentityModule } from '../../identity/identity.module.js';
import { AuthorizationModule } from '../../authorization/authorization.module.js';
import { CommunityModule } from '../../community/community.module.js';
import { ProfileModule } from '../profile.module.js';
import { ProfileAvatarModerationService } from './service.js';
import { ProfileAvatarModerationController } from './controller.js';
/** Application composition prevents a Profile -> Community -> Profile cycle. */
@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    AuthorizationModule,
    CommunityModule,
    ProfileModule,
  ],
  providers: [ProfileAvatarModerationService],
  controllers: [ProfileAvatarModerationController],
  exports: [ProfileAvatarModerationService],
})
export class ProfileAvatarModerationModule {}
