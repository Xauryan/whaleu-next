import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { DatabaseModule, DatabaseService } from '../../database/database.js';
import { IdentityModule } from '../../identity/identity.module.js';
import { IdentityService } from '../../identity/identity.service.js';
import { OrganizationManagementModule } from '../../organizations/management/module.js';
import { DiscoveryContinuationModule } from '../../community/discovery-continuation.module.js';
import { PostgresRequestThrottlingModule } from '../../request-throttling/module.js';
import { PostgresThrottlerStorage } from '../../request-throttling/postgres-storage.js';
import { MediaDeliveryBudgetModule } from '../../media/delivery-budget.module.js';
import { MediaDeliveryBudgetPool } from '../../media/delivery-budget.js';
import {
  ActivityMediaService,
  ACTIVITY_MEDIA_RUNTIME,
} from '../media/facade.js';
import type { ActivityMediaRuntime } from '../media/facade.js';
import {
  ActivityMediaController,
  ActivityMultipartInterceptor,
} from '../media/controller.js';
import { ActivityMediaRequestGuard } from '../media/request-guard.js';
import { ActivityPublicationAccess } from './access.js';
import { ActivityPublicationService } from './service.js';
import { ActivityPublicationController } from './controller.js';
import { ActivityPublicationRequestGuard } from './request-guard.js';
import {
  ActivityReviewService,
  ActivityReviewProcessor,
  ACTIVITY_REVIEW_RUNTIME,
} from './review.js';
@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    OrganizationManagementModule,
    DiscoveryContinuationModule,
    MediaDeliveryBudgetModule,
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
  controllers: [ActivityPublicationController, ActivityMediaController],
  providers: [
    ActivityPublicationAccess,
    ActivityPublicationService,
    ActivityPublicationRequestGuard,
    ActivityReviewService,
    ActivityReviewProcessor,
    ActivityMediaRequestGuard,
    ActivityMultipartInterceptor,
    { provide: ACTIVITY_REVIEW_RUNTIME, useValue: null },
    { provide: ACTIVITY_MEDIA_RUNTIME, useValue: null },
    {
      provide: ActivityMediaService,
      inject: [
        DatabaseService,
        IdentityService,
        ActivityPublicationAccess,
        ACTIVITY_MEDIA_RUNTIME,
        MediaDeliveryBudgetPool,
      ],
      useFactory: (
        db: DatabaseService,
        identity: IdentityService,
        access: ActivityPublicationAccess,
        runtime: ActivityMediaRuntime | null,
        budget: MediaDeliveryBudgetPool,
      ) => new ActivityMediaService(db, identity, access, runtime, budget),
    },
  ],
  exports: [
    ActivityPublicationService,
    ActivityPublicationAccess,
    ActivityMediaService,
    ActivityReviewService,
    ActivityReviewProcessor,
  ],
})
export class ActivityPublicationModule {}
