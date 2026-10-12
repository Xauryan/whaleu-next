import { WindowRatingsModule } from './windows/module.js';
import { CourseRatingsModule } from './courses/module.js';
import { RatingCategoryIconRetirementOwner } from './category-management/icon-retirement.js';
import {
  RatingCategoryIconManagementController,
  RatingCategoryIconRequestController,
} from './category-management/icon-controller.js';
import { RatingCategoryIconPublicController } from './category-management/icon-public-controller.js';
import { RatingCategoryIconManagementService } from './category-management/icon-service.js';
import { RatingCategoryIconRepository } from './category-management/icon-repository.js';
import { RatingCategoryIconAuthority } from './category-management/icon-authority.js';
import { RatingCategoryIconMediaService } from './category-management/icon-media.service.js';
import {
  CategoryIconMediaCredentials,
  RATINGS_CATEGORY_ICON_MEDIA_AUTHORITY,
  RATINGS_CATEGORY_ICON_MEDIA_RUNTIME,
} from './category-management/icon-media-authority.js';
import {
  CategoryIconMediaController,
  CategoryIconMultipartInterceptor,
} from '../media/controller-category-icon.js';
import {
  CategoryIconUploadApplication,
  CATEGORY_ICON_MEDIA_OWNER,
} from '../media/application-category-icon.js';
import { RatingDiscussionMediaController } from './scoped/discussion-media-controller.js';
import {
  RatingDiscussionMediaService,
  RATINGS_DISCUSSION_MEDIA_RUNTIME,
} from './discussion-media.service.js';
import {
  RATINGS_DISCUSSION_MEDIA_OWNER,
  RatingsDiscussionUploadApplication,
  type RatingsDiscussionMediaRuntime,
} from '../media/application-ratings-discussion.js';
import {
  RatingsDiscussionMediaController,
  RatingsDiscussionMultipartInterceptor,
} from '../media/controller-ratings-discussion.js';
import { RatingsRepository } from './repository.js';
import { RatingDiscussionRepository } from './discussion-repository.js';
import { RatingDiscussionProjection } from './discussion-projection.js';
import { RatingTargetCoverController } from './scoped/target-cover-controller.js';
import {
  RatingTargetCoverMediaService,
  RATINGS_TARGET_COVER_RUNTIME,
} from './target-cover-media.service.js';
import {
  RATINGS_TARGET_MEDIA_OWNER,
  RatingsTargetUploadApplication,
  type RatingsTargetMediaRuntime,
} from '../media/application-ratings.js';
import {
  RatingsTargetMediaController,
  RatingsTargetMultipartInterceptor,
} from '../media/controller-ratings.js';
import { MediaDeliveryBudgetPool } from '../media/delivery-budget.js';
import { MediaDeliveryBudgetModule } from '../media/delivery-budget.module.js';
import { DatabaseService } from '../database/database.js';
import { IdentityService } from '../identity/identity.service.js';
import { RatingsAccessService } from './access.js';
import { RatingScopedContextService } from './scoped/context.service.js';
import { RatingScopedRepository } from './scoped/repository.js';
import { RatingCategoryScopedManagementController } from './category-management/scoped-controller.js';
import { RatingCategoryScopedManagementService } from './category-management/scoped-service.js';
import { RatingCategoryManagementReader } from './category-management/scoped-reader.repository.js';
import { RatingCategorySourceIssuer } from './category-management/source-issuer.js';
import { RatingLegacyBridgeService } from './scoped/legacy-bridge.service.js';
import {
  RatingScopedController,
  RatingScopedNoticesController,
} from './scoped/controller.js';
import { RatingScopedCommands } from './scoped/commands.service.js';
import { RatingScopedReadService } from './scoped/read.service.js';
import { RatingScopedRandomService } from './scoped/random.service.js';
import { RatingScopedNoticeService } from './scoped/notice.service.js';
import { RatingScopedReleaseRepository } from './scoped/release.repository.js';
import { RatingUpdatesRepository } from '../notifications/ratings/repository.js';
import { RatingSubscriptionUpdatesRepository } from '../notifications/ratings/subscription-repository.js';
import { RatingUpdatesCursors } from '../notifications/ratings/cursor.js';
import { RatingSubscriptionUpdatesCursors } from '../notifications/ratings/subscription-cursor.js';
import { RatingCategoryManagementController } from './category-management/controller.js';
import { RatingCategoryManagementService } from './category-management/service.js';
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
    CourseRatingsModule,
    WindowRatingsModule,
    DatabaseModule,
    MediaDeliveryBudgetModule,
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
    RatingCategoryIconManagementController,
    RatingCategoryIconRequestController,
    RatingCategoryIconPublicController,
    CategoryIconMediaController,
    RatingDiscussionMediaController,
    RatingsDiscussionMediaController,
    RatingTargetCoverController,
    RatingsTargetMediaController,
    RatingScopedController,
    RatingScopedNoticesController,
    RatingCategoryManagementController,
    RatingCategoryScopedManagementController,
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
    RatingCategoryIconRetirementOwner,
    RatingCategoryIconRepository,
    RatingCategoryIconAuthority,
    CategoryIconMediaCredentials,
    RatingCategoryIconManagementService,
    {
      provide: RATINGS_CATEGORY_ICON_MEDIA_AUTHORITY,
      useExisting: RatingCategoryIconAuthority,
    },
    { provide: RATINGS_CATEGORY_ICON_MEDIA_RUNTIME, useValue: null },
    RatingCategoryIconMediaService,
    {
      provide: CATEGORY_ICON_MEDIA_OWNER,
      useExisting: RatingCategoryIconMediaService,
    },
    {
      provide: CategoryIconUploadApplication,
      inject: [RatingCategoryIconMediaService],
      useFactory: (owner: RatingCategoryIconMediaService) =>
        new CategoryIconUploadApplication(owner),
    },
    CategoryIconMultipartInterceptor,

    { provide: RATINGS_DISCUSSION_MEDIA_RUNTIME, useValue: null },
    {
      provide: RatingDiscussionMediaService,
      inject: [
        DatabaseService,
        IdentityService,
        RatingsAccessService,
        RatingScopedContextService,
        RatingScopedRepository,
        RatingsRepository,
        RatingDiscussionRepository,
        RatingDiscussionProjection,
        RATINGS_DISCUSSION_MEDIA_RUNTIME,
        MediaDeliveryBudgetPool,
      ],
      useFactory: (
        database: DatabaseService,
        identity: IdentityService,
        access: RatingsAccessService,
        contexts: RatingScopedContextService,
        scoped: RatingScopedRepository,
        records: RatingsRepository,
        replies: RatingDiscussionRepository,
        discussion: RatingDiscussionProjection,
        runtime: RatingsDiscussionMediaRuntime | null,
        budget: MediaDeliveryBudgetPool,
      ) =>
        new RatingDiscussionMediaService(
          database,
          identity,
          access,
          contexts,
          scoped,
          records,
          replies,
          discussion,
          runtime,
          budget,
        ),
    },
    {
      provide: RATINGS_DISCUSSION_MEDIA_OWNER,
      useExisting: RatingDiscussionMediaService,
    },
    {
      provide: RatingsDiscussionUploadApplication,
      inject: [RatingDiscussionMediaService],
      useFactory: (owner: RatingDiscussionMediaService) =>
        new RatingsDiscussionUploadApplication(owner),
    },
    RatingsDiscussionMultipartInterceptor,

    { provide: RATINGS_TARGET_COVER_RUNTIME, useValue: null },
    {
      provide: RatingTargetCoverMediaService,
      inject: [
        DatabaseService,
        IdentityService,
        RatingsAccessService,
        RatingScopedContextService,
        RatingScopedRepository,
        RATINGS_TARGET_COVER_RUNTIME,
        MediaDeliveryBudgetPool,
      ],
      useFactory: (
        db: DatabaseService,
        identity: IdentityService,
        access: RatingsAccessService,
        contexts: RatingScopedContextService,
        scoped: RatingScopedRepository,
        runtime: RatingsTargetMediaRuntime | null,
        budget: MediaDeliveryBudgetPool,
      ) =>
        new RatingTargetCoverMediaService(
          db,
          identity,
          access,
          contexts,
          scoped,
          runtime,
          budget,
        ),
    },
    {
      provide: RATINGS_TARGET_MEDIA_OWNER,
      useExisting: RatingTargetCoverMediaService,
    },
    {
      provide: RatingsTargetUploadApplication,
      inject: [RatingTargetCoverMediaService],
      useFactory: (owner: RatingTargetCoverMediaService) =>
        new RatingsTargetUploadApplication(owner),
    },
    RatingsTargetMultipartInterceptor,

    RatingLegacyBridgeService,
    RatingScopedCommands,
    RatingScopedReadService,
    RatingScopedRandomService,
    RatingScopedNoticeService,
    RatingScopedReleaseRepository,
    RatingUpdatesRepository,
    RatingSubscriptionUpdatesRepository,
    RatingUpdatesCursors,
    RatingSubscriptionUpdatesCursors,
    RatingCategoryManagementService,
    RatingCategoryScopedManagementService,
    RatingCategoryManagementReader,
    RatingCategorySourceIssuer,
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
