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
