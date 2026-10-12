import { DatabaseService } from '../database/database.js';
import { IdentityService } from '../identity/identity.service.js';
import { MediaDeliveryBudgetModule } from '../media/delivery-budget.module.js';
import { MediaDeliveryBudgetPool } from '../media/delivery-budget.js';
import { MessagingImageAuthority } from './image-authority.js';
import {
  PrivateMessageMediaService,
  PRIVATE_MESSAGE_MEDIA_RUNTIME,
} from './media/facade.js';
import type { PrivateMessageMediaRuntime } from './media/facade.js';
import {
  PrivateMessageMediaController,
  PrivateMessageMultipartInterceptor,
} from './media/controller.js';
import { PrivateMessageMediaRequestGuard } from './media/request-guard.js';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { VerificationModule } from '../verification/verification.module.js';
import { SafetyPolicyModule } from '../safety/policy.module.js';
import { CommunityModule } from '../community/community.module.js';
import { ProfileModule } from '../profile/profile.module.js';
import { ContentReviewModule } from '../community/content-review/content-review.module.js';
import { MessagingRequestThrottlingModule } from './throttling.module.js';
import { MessagingController } from './controller.js';
import { MessagingAccess } from './access.js';
import { MessagingRepository } from './repository.js';
import { MessagingRequests } from './requests.js';
import { MessagingMutationService } from './mutation.service.js';
import { MessagingReadService } from './read.service.js';
@Module({
  imports: [
    DatabaseModule,
    MediaDeliveryBudgetModule,
    IdentityModule,
    VerificationModule,
    SafetyPolicyModule,
    CommunityModule,
    ProfileModule,
    ContentReviewModule,
    MessagingRequestThrottlingModule,
  ],
  controllers: [MessagingController, PrivateMessageMediaController],
  providers: [
    MessagingImageAuthority,
    PrivateMessageMultipartInterceptor,
    PrivateMessageMediaRequestGuard,
    { provide: PRIVATE_MESSAGE_MEDIA_RUNTIME, useValue: null },
    {
      provide: PrivateMessageMediaService,
      inject: [
        DatabaseService,
        IdentityService,
        MessagingImageAuthority,
        PRIVATE_MESSAGE_MEDIA_RUNTIME,
        MediaDeliveryBudgetPool,
      ],
      useFactory: (
        db: DatabaseService,
        identity: IdentityService,
        access: MessagingImageAuthority,
        runtime: PrivateMessageMediaRuntime | null,
        budget: MediaDeliveryBudgetPool,
      ) =>
        new PrivateMessageMediaService(db, identity, access, runtime, budget),
    },
    MessagingAccess,
    MessagingRepository,
    MessagingRequests,
    MessagingMutationService,
    MessagingReadService,
  ],
})
export class MessagingModule {}
