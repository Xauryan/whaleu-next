import { ProfileCoverReviewFacade } from './profile-cover-review.facade.js';
import { CurrentRatingLinkDependency } from '../rating-target-link/dependency.js';
import { CommunityDistributionService } from '../related-sync/service.js';
import { MajorDiscussionMediaReviewFacade } from './major-discussion-media-review.facade.js';
import { WindowDiscussionMediaReviewFacade } from './window-discussion-media-review.facade.js';
import { MajorDiscussionReviewFacade } from './major-discussion-review.facade.js';
import { WindowDiscussionReviewFacade } from './window-discussion-review.facade.js';
import { DishReviewFacade } from './dish-review.facade.js';
import { CourseCommentReviewFacade } from './course-comment-review.facade.js';
import { RatingCategoryIconReviewFacade } from './rating-category-icon-review.facade.js';
import { TextReviewRuntime } from '../text-review/runtime.js';
import { ProfileAvatarReviewFacade } from './profile-avatar-review.facade.js';
import {
  MediaContentSnapshotFacade,
  UnavailableMediaContentSnapshotFacade,
} from '../../media/content-snapshot.facade.js';
import {
  CONTENT_MEDIA_PROOF,
  UnavailableContentMediaProof,
} from './media-proof.js';
import { RatingScopedContentReviewFacade } from './rating-scoped-content-review.facade.js';
import { DmContentReviewFacade } from './dm-content-review.facade.js';
import { RatingCategoryContentReviewFacade } from './rating-category-content-review.facade.js';
import { RatingContentReviewFacade } from './rating-content-review.facade.js';
import { ErrandContentReviewFacade } from './errand-content-review.facade.js';
import { ContentReviewCountRepository } from './count-snapshot.repository.js';
import { Module } from '@nestjs/common';
import { CampusModule } from '../../campus/campus.module.js';
import { ApprovalRepository } from './approval.repository.js';
import { ContentDefinitionRepository } from './content-definition.repository.js';
import { LocalContentPublicationGate } from './local-content-publication-gate.js';
import { LocalApprovedContentVisibility } from './local-approved-content-visibility.js';
/** Leaf facts only: deliberately does not import CommunityModule or Safety. */
@Module({
  imports: [CampusModule],
  providers: [
    CurrentRatingLinkDependency,
    CommunityDistributionService,
    WindowDiscussionReviewFacade,
    WindowDiscussionMediaReviewFacade,
    MajorDiscussionMediaReviewFacade,
    MajorDiscussionReviewFacade,
    CourseCommentReviewFacade,
    DishReviewFacade,
    RatingCategoryIconReviewFacade,
    TextReviewRuntime,
    ProfileAvatarReviewFacade,
    ProfileCoverReviewFacade,
    {
      provide: MediaContentSnapshotFacade,
      useClass: UnavailableMediaContentSnapshotFacade,
    },
    { provide: CONTENT_MEDIA_PROOF, useClass: UnavailableContentMediaProof },
    DmContentReviewFacade,
    RatingContentReviewFacade,
    RatingScopedContentReviewFacade,
    RatingCategoryContentReviewFacade,
    ErrandContentReviewFacade,
    ContentReviewCountRepository,
    ApprovalRepository,
    ContentDefinitionRepository,
    LocalContentPublicationGate,
    LocalApprovedContentVisibility,
  ],
  exports: [
    ContentDefinitionRepository,
    CurrentRatingLinkDependency,
    CommunityDistributionService,
    WindowDiscussionReviewFacade,
    WindowDiscussionMediaReviewFacade,
    MajorDiscussionMediaReviewFacade,
    MajorDiscussionReviewFacade,
    CourseCommentReviewFacade,
    DishReviewFacade,
    RatingCategoryIconReviewFacade,
    TextReviewRuntime,
    ProfileAvatarReviewFacade,
    ProfileCoverReviewFacade,
    MediaContentSnapshotFacade,
    DmContentReviewFacade,
    RatingContentReviewFacade,
    RatingScopedContentReviewFacade,
    RatingCategoryContentReviewFacade,
    ErrandContentReviewFacade,
    ContentReviewCountRepository,
    ApprovalRepository,
    LocalContentPublicationGate,
    LocalApprovedContentVisibility,
  ],
})
export class ContentReviewModule {}
