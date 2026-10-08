import { Module } from '@nestjs/common';
import { COMMUNITY_BASE_VISIBILITY } from '../community/community-policy.js';
import { ContentReviewModule } from '../community/content-review/content-review.module.js';
import { LocalApprovedContentVisibility } from '../community/content-review/local-approved-content-visibility.js';
import { SafetyRepository } from './repository.js';
import { NamedBlockVisibility } from './visibility.js';
import { ProfileVisibilityFacade } from './profile-visibility.facade.js';
import { SafetyContentVisibilityFacade } from './content-visibility.facade.js';
@Module({
  imports: [ContentReviewModule],
  providers: [
    SafetyRepository,
    NamedBlockVisibility,
    ProfileVisibilityFacade,
    SafetyContentVisibilityFacade,
    {
      provide: COMMUNITY_BASE_VISIBILITY,
      useExisting: LocalApprovedContentVisibility,
    },
  ],
  exports: [
    SafetyRepository,
    NamedBlockVisibility,
    ProfileVisibilityFacade,
    SafetyContentVisibilityFacade,
  ],
})
export class SafetyPolicyModule {}
