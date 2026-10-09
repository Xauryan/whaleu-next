import { RatingTargetEditController } from './management/target-edit/controller.js';
import { RatingTargetEditService } from './management/target-edit/service.js';
import { RatingTargetEditRepository } from './management/target-edit/repository.js';
import { RatingTargetOwnerDeletionController } from './management/target-deletion/controller.js';
import { RatingTargetOwnerDeletionService } from './management/target-deletion/service.js';
import { RatingTargetOwnerDeletionRepository } from './management/target-deletion/repository.js';
import { RatingRandomDraw } from './random/draw.js';
import { RatingRandomController } from './random/controller.js';
import { RatingRandomService } from './random/service.js';
import { RatingCompletePoolRepository } from './random/complete-pool.repository.js';
import { RatingManagementController } from './management/controller.js';
import { RatingManagementService } from './management/service.js';
import { RatingNativeTargetSourceFacade } from './management/native-source.facade.js';
import { RatingCatalogWriter } from './management/catalog-writer.js';
import { RatingDeletionController } from './deletion/controller.js';
import { RatingDeletionService } from './deletion/service.js';
import { RatingAdminDeletionRequests } from './deletion/requests.js';
import { RatingTargetOriginFacade } from './deletion/origin.facade.js';
import { RatingSubscriptionsController } from './subscriptions/controller.js';
import { RatingSubscriptionsService } from './subscriptions/service.js';
import { RatingSubscriptionsRepository } from './subscriptions/repository.js';
import { RatingSubscriptionRequests } from './subscriptions/requests.js';
import { RatingSubscriptionTargetFacade } from './subscriptions/target.facade.js';
import { RatingRootOrderCursors } from './like-order-cursor.js';
import { RatingRootOrderRepository } from './like-order-repository.js';
import { RatingLikesController } from './likes/controller.js';
import { RatingLikesService } from './likes/service.js';
import { RatingLikesRepository } from './likes/repository.js';
import { RatingLikeRequests } from './likes/requests.js';
import { RatingLikeSubjectFacade } from './likes/subject.facade.js';
import { RatingsReadModule } from './read.module.js';
import { ExperienceIngressModule } from '../experience/ingress.js';
import { RatingEffectsCapture } from './effects/capture.js';
import { RatingDiscussionController } from './discussion-controller.js';
import { RatingDiscussionService } from './discussion-service.js';
import { RatingReplyRequests } from './discussion-requests.js';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { VerificationModule } from '../verification/verification.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { CampusModule } from '../campus/campus.module.js';
import { ProfileModule } from '../profile/profile.module.js';
import { SafetyPolicyModule } from '../safety/policy.module.js';
import { ContentReviewModule } from '../community/content-review/content-review.module.js';
import { DiscoveryContinuationModule } from '../community/discovery-continuation.module.js';
import { RatingRequestThrottlingModule } from '../request-throttling/module.js';
import { RatingsController } from './controller.js';
import { RatingsService } from './service.js';
import { RatingsRequests } from './requests.js';
import { RatingsCursors } from './cursor.js';
@Module({
  imports: [
    DatabaseModule,
    RatingsReadModule,
    ExperienceIngressModule,
    IdentityModule,
    VerificationModule,
    AuthorizationModule,
    CampusModule,
    ProfileModule,
    SafetyPolicyModule,
    ContentReviewModule,
    DiscoveryContinuationModule,
    RatingRequestThrottlingModule,
  ],
  controllers: [
    RatingTargetEditController,
    RatingTargetOwnerDeletionController,
    RatingRandomController,
    RatingManagementController,
    RatingDeletionController,
    RatingSubscriptionsController,
    RatingsController,
    RatingDiscussionController,
    RatingLikesController,
  ],
  providers: [
    RatingTargetEditService,
    RatingTargetEditRepository,
    RatingTargetOwnerDeletionService,
    RatingTargetOwnerDeletionRepository,
    RatingRandomService,
    RatingRandomDraw,
    RatingCompletePoolRepository,
    RatingManagementService,
    RatingNativeTargetSourceFacade,
    RatingCatalogWriter,
    RatingDeletionService,
    RatingAdminDeletionRequests,
    RatingTargetOriginFacade,
    RatingSubscriptionsService,
    RatingSubscriptionsRepository,
    RatingSubscriptionRequests,
    RatingSubscriptionTargetFacade,
    RatingRootOrderCursors,
    RatingRootOrderRepository,
    RatingLikesService,
    RatingLikesRepository,
    RatingLikeRequests,
    RatingLikeSubjectFacade,
    RatingsService,
    RatingEffectsCapture,
    RatingDiscussionService,
    RatingReplyRequests,
    RatingsRequests,
    RatingsCursors,
  ],
})
export class RatingsModule {}
