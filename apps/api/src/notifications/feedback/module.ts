import { Module } from '@nestjs/common';
import { AuthorizationModule } from '../../authorization/authorization.module.js';
import { IdentityModule } from '../../identity/identity.module.js';
import { FeedbackNoticeAuthority } from './authority.js';
import { FeedbackNotificationsFacade } from './facade.js';
import { FeedbackNoticesRepository } from './repository.js';

/** The ingress has no dependency on Community. The read service/controller are
 * registered by Community with its exact current-access target source. */
@Module({
  imports: [AuthorizationModule, IdentityModule],
  providers: [
    FeedbackNoticeAuthority,
    FeedbackNoticesRepository,
    FeedbackNotificationsFacade,
  ],
  exports: [
    FeedbackNoticeAuthority,
    FeedbackNoticesRepository,
    FeedbackNotificationsFacade,
  ],
})
export class FeedbackNotificationsModule {}
