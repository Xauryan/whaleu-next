import { ErrandGroupDeliveryModule } from '../notifications/errand-group/module.js';
import { ErrandGroupSource } from './group-source.js';
import { ModuleRef } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { DatabaseService } from '../database/database.js';
import { IdentityService } from '../identity/identity.service.js';
import { PostgresRequestThrottlingModule } from '../request-throttling/module.js';
import { PostgresThrottlerStorage } from '../request-throttling/postgres-storage.js';
import { MediaDeliveryBudgetModule } from '../media/delivery-budget.module.js';
import { MediaDeliveryBudgetPool } from '../media/delivery-budget.js';
import { ErrandMediaService, ERRAND_MEDIA_RUNTIME } from './media/facade.js';
import type { ErrandMediaRuntime } from './media/facade.js';
import {
  ErrandMediaController,
  ErrandMultipartInterceptor,
} from './media/controller.js';
import { ErrandMediaRequestGuard } from './media/request-guard.js';
import { ErrandPublicationService } from './publication-service.js';
import { ErrandPublicationController } from './publication-controller.js';
import { ErrandAdminCommandController } from './admin-command-controller.js';
import { ErrandAdminCommandService } from './admin-command-service.js';
import { ErrandRestrictionService } from './restriction-service.js';
import { SafetyErrandManagementModule } from '../safety/errand-management/module.js';
import { ErrandAdminController } from './admin-controller.js';
import { ErrandAdminService } from './admin-service.js';
import { ErrandAdminRepository } from './admin-repository.js';
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
import { ErrandNotificationsModule } from '../notifications/errand.module.js';
import { ErrandRequestThrottlingModule } from '../request-throttling/module.js';
import { ErrandsController } from './controller.js';
import { ErrandsService } from './service.js';
import { ErrandAccessService } from './access.js';
import { ErrandsRepository } from './repository.js';
import { ErrandRequests } from './requests.js';
@Module({
  imports: [
    DatabaseModule,
    ErrandGroupDeliveryModule,
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
    SafetyErrandManagementModule,
    IdentityModule,
    VerificationModule,
    AuthorizationModule,
    CampusModule,
    ProfileModule,
    SafetyPolicyModule,
    ContentReviewModule,
    DiscoveryContinuationModule,
    ErrandNotificationsModule,
    ErrandRequestThrottlingModule,
  ],
  controllers: [
    ErrandsController,
    ErrandPublicationController,
    ErrandMediaController,
    ErrandAdminController,
    ErrandAdminCommandController,
  ],
  exports: [ErrandsService, ErrandMediaService, ErrandPublicationService],
  providers: [
    ErrandPublicationService,
    ErrandGroupSource,
    ErrandMediaRequestGuard,
    ErrandMultipartInterceptor,
    { provide: ERRAND_MEDIA_RUNTIME, useValue: null },
    {
      provide: ErrandMediaService,
      inject: [
        DatabaseService,
        IdentityService,
        ModuleRef,
        ERRAND_MEDIA_RUNTIME,
        MediaDeliveryBudgetPool,
      ],
      useFactory: (
        db: DatabaseService,
        identity: IdentityService,
        modules: ModuleRef,
        runtime: ErrandMediaRuntime | null,
        budget: MediaDeliveryBudgetPool,
      ) =>
        new ErrandMediaService(
          db,
          identity,
          {
            authorizePrepare: (actor, input, tx) =>
              modules
                .get(ErrandPublicationService, { strict: false })
                .authorizeMediaPrepare(actor, input, tx),
            retainDraftCurrent: async (id, tx) => {
              await modules
                .get(ErrandPublicationService, { strict: false })
                .retainDraftCurrent(id, tx);
            },
            authorizeRead: (token, target, tx) =>
              modules
                .get(ErrandsService, { strict: false })
                .mediaAuthority(token, target, tx),
          },
          runtime,
          budget,
        ),
    },
    ErrandAdminCommandService,
    ErrandRestrictionService,
    ErrandAdminService,
    ErrandAdminRepository,
    ErrandsService,
    ErrandAccessService,
    ErrandsRepository,
    ErrandRequests,
  ],
})
export class ErrandsModule {}
