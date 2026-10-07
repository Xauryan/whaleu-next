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
    ApprovalRepository,
    ContentDefinitionRepository,
    LocalContentPublicationGate,
    LocalApprovedContentVisibility,
  ],
  exports: [
    ApprovalRepository,
    LocalContentPublicationGate,
    LocalApprovedContentVisibility,
  ],
})
export class ContentReviewModule {}
