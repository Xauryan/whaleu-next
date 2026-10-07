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
  static register(config: RuntimeConfig): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigurationModule.register(config),
        ObservabilityModule,
        HealthModule,
        IdentityModule,
        CampusModule,
        ProfileModule,
        CommunityModule,
        IdentityPrivacyModule,
      ],
    };
  }
}
