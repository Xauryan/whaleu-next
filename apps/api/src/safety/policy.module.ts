import { ProfileAvatarSafetyFacade } from './profile-avatar.facade.js';
import { DmSafetyFacade } from './dm.facade.js';
import { RatingSafetyFacade } from './rating.facade.js';
import { SafetyErrandFacade } from './errand.facade.js';
import { SafetyActivityReadFacade } from './activity-read.facade.js';
import { SafetyAnnouncementReadFacade } from './announcement-read.facade.js';
import { SafetyDirectoryReadFacade } from './directory-read.facade.js';
import { Module } from '@nestjs/common';
import { SafetySearchEligibilityFacade } from './search-eligibility.facade.js';
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
    ProfileAvatarSafetyFacade,
    DmSafetyFacade,
    RatingSafetyFacade,
    SafetyErrandFacade,
    SafetyRepository,
    SafetyDirectoryReadFacade,
    SafetyActivityReadFacade,
    SafetyAnnouncementReadFacade,
    NamedBlockVisibility,
    ProfileVisibilityFacade,
    SafetyContentVisibilityFacade,
    SafetySearchEligibilityFacade,
    {
      provide: COMMUNITY_BASE_VISIBILITY,
      useExisting: LocalApprovedContentVisibility,
    },
  ],
  exports: [
    ProfileAvatarSafetyFacade,
    DmSafetyFacade,
    RatingSafetyFacade,
    SafetyErrandFacade,
    SafetyRepository,
    SafetyDirectoryReadFacade,
    SafetyActivityReadFacade,
    SafetyAnnouncementReadFacade,
    NamedBlockVisibility,
    ProfileVisibilityFacade,
    SafetyContentVisibilityFacade,
    SafetySearchEligibilityFacade,
  ],
})
export class SafetyPolicyModule {}
