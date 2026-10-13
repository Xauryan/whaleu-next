import { ContentReviewModule } from '../community/content-review/content-review.module.js';
import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { DatabaseModule } from '../database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { SchoolConfigurationModule } from '../school-configuration/module.js';
import { PostgresRequestThrottlingModule } from '../request-throttling/module.js';
import { PostgresThrottlerStorage } from '../request-throttling/postgres-storage.js';
import { SchoolPostingPolicyController } from './controller.js';
import { SchoolPostingPolicyRepository } from './repository.js';
import { SchoolPostingPolicyService } from './service.js';
import { SchoolPostingPolicyRequestGuard } from './request-guard.js';
@Module({
  imports: [
    ContentReviewModule,
    DatabaseModule,
    IdentityModule,
    SchoolConfigurationModule,
    PostgresRequestThrottlingModule,
    ThrottlerModule.forRootAsync({
      imports: [PostgresRequestThrottlingModule],
      inject: [PostgresThrottlerStorage],
      useFactory: (storage: PostgresThrottlerStorage) => ({
        storage,
        setHeaders: false,
        throttlers: [
          { name: 'default', ttl: 60000, limit: 120, blockDuration: 60000 },
        ],
      }),
    }),
  ],
  controllers: [SchoolPostingPolicyController],
  providers: [
    SchoolPostingPolicyRepository,
    SchoolPostingPolicyService,
    SchoolPostingPolicyRequestGuard,
  ],
  exports: [SchoolPostingPolicyService],
})
export class SchoolPostingPolicyModule {}
