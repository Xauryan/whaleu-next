import { SchoolIdentityModule } from './school-identity/module.js';
import { SchoolUidModule } from './school-uid/module.js';
import { AccountPolicyModule } from './safety/account-policy/module.js';
import { SchoolAdminManagementModule } from './authorization/school-admin-management/module.js';
import { ProfileAvatarModerationModule } from './profile/avatar-moderation/module.js';
import { ProfileModerationModule } from './profile/moderation/module.js';
import { MajorsModule } from './majors/module.js';
import { ActivityPublicationModule } from './activities/publication/module.js';
import { OrganizationManagementModule } from './organizations/management/module.js';
import { SchoolPostingPolicyModule } from './school-posting-policy/module.js';
import { SchoolConfigurationModule } from './school-configuration/module.js';
import { MessagingModule } from './messaging/module.js';
import { RatingUpdatesModule } from './notifications/ratings/module.js';
import { RatingsModule } from './ratings/module.js';
import { ErrandsModule } from './errands/module.js';
import { ActivitiesModule } from './activities/module.js';
import { AnnouncementsModule } from './announcements/module.js';
import { HotFeedRunnerModule } from './community/hot-score/runner.js';
import { DirectoryModule } from './organizations/directory/module.js';
import { ScheduleModule } from '@nestjs/schedule';
import { ViewRetentionModule } from './community/view-component/retention-runner.js';
import { ExperienceRankingModule } from './experience-ranking/module.js';
import { ExperienceModule } from './experience/module.js';
import { IdentityCampusModule } from './identity-campus/module.js';
import { ProfileDiscoveryModule } from './profile-discovery/module.js';
import { SafetyModule } from './safety/safety.module.js';
import { NotificationsModule } from './notifications/notifications.module.js';
import { IdentityPrivacyModule } from './identity-privacy/identity-privacy.module.js';
import { CommunityModule } from './community/community.module.js';
import { CampusModule } from './campus/campus.module.js';
import { ProfileModule } from './profile/profile.module.js';
import { Module } from '@nestjs/common';
import type { DynamicModule } from '@nestjs/common';
import { ConfigurationModule } from './config/config.js';
import type { RuntimeConfig } from './config/config.js';
import { IdentityModule } from './identity/identity.module.js';
import { HealthModule } from './health/health.js';
import { ObservabilityModule } from './observability/logger.js';

@Module({})
export class AppModule {
  static register(
    config: RuntimeConfig,
    options: { httpRuntime?: boolean } = {},
  ): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigurationModule.register(config),
        ...(options.httpRuntime
          ? [
              ScheduleModule.forRoot({
                cronJobs: false,
                timeouts: false,
                intervals:
                  config.VIEW_REPORTING_RETENTION_PROCESSING === 'automatic' ||
                  config.HOT_FEED_PROCESSING === 'automatic',
              }),
              ViewRetentionModule,
              ...(config.HOT_FEED_PROCESSING === 'automatic'
                ? [HotFeedRunnerModule]
                : []),
            ]
          : []),
        ObservabilityModule,
        HealthModule,
        IdentityModule,
        CampusModule,
        IdentityCampusModule,
        ProfileModule,
        ProfileModerationModule,
        SchoolAdminManagementModule,
        SchoolIdentityModule,
        SchoolUidModule,
        ProfileAvatarModerationModule,
        ProfileDiscoveryModule,
        CommunityModule,
        DirectoryModule,
        AnnouncementsModule,
        ActivitiesModule,
        ActivityPublicationModule,
        ErrandsModule,
        RatingsModule,
        MajorsModule,
        MessagingModule,
        SchoolConfigurationModule,
        SchoolPostingPolicyModule,
        OrganizationManagementModule,
        RatingUpdatesModule,
        SafetyModule,
        AccountPolicyModule,
        NotificationsModule,
        IdentityPrivacyModule,
        ExperienceModule,
        ExperienceRankingModule,
      ],
    };
  }
}
