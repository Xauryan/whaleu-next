import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { DatabaseModule, DatabaseService } from '../../database/database.js';
import { IdentityModule } from '../../identity/identity.module.js';
import { IdentityService } from '../../identity/identity.service.js';
import { CampusModule } from '../../campus/campus.module.js';
import { AuthorizationModule } from '../../authorization/authorization.module.js';
import { VerificationModule } from '../../verification/verification.module.js';
import { SafetyPolicyModule } from '../../safety/policy.module.js';
import { ProfileModule } from '../../profile/profile.module.js';
import { SchoolConfigurationModule } from '../../school-configuration/module.js';
import { PostgresRequestThrottlingModule } from '../../request-throttling/module.js';
import { PostgresThrottlerStorage } from '../../request-throttling/postgres-storage.js';
import { DiscoveryContinuationModule } from '../../community/discovery-continuation.module.js';
import { MediaDeliveryBudgetModule } from '../../media/delivery-budget.module.js';
import { MediaDeliveryBudgetPool } from '../../media/delivery-budget.js';
import { DirectoryRepository } from '../directory/repository.js';
import { OrganizationAccess } from './access.js';
import { OrganizationService } from './service.js';
import { OrganizationController } from './controller.js';
import { OrganizationRequestGuard } from './request-guard.js';
import { OrganizationAuthorityFacade } from './authority.facade.js';
import {
  OrganizationMediaService,
  ORGANIZATION_MEDIA_RUNTIME,
} from '../media/facade.js';
import type { OrganizationMediaRuntime } from '../media/facade.js';
import {
  OrganizationMediaController,
  OrganizationMultipartInterceptor,
} from '../media/controller.js';
import { OrganizationMediaRequestGuard } from '../media/request-guard.js';
@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    CampusModule,
    AuthorizationModule,
    VerificationModule,
    SafetyPolicyModule,
    ProfileModule,
    SchoolConfigurationModule,
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
  controllers: [OrganizationController, OrganizationMediaController],
  providers: [
    DirectoryRepository,
    OrganizationAccess,
    OrganizationService,
    OrganizationRequestGuard,
    OrganizationAuthorityFacade,
    OrganizationMediaRequestGuard,
    OrganizationMultipartInterceptor,
    { provide: ORGANIZATION_MEDIA_RUNTIME, useValue: null },
    {
      provide: OrganizationMediaService,
      inject: [
        DatabaseService,
        IdentityService,
        OrganizationAccess,
        ORGANIZATION_MEDIA_RUNTIME,
        MediaDeliveryBudgetPool,
      ],
      useFactory: (
        db: DatabaseService,
        identity: IdentityService,
        access: OrganizationAccess,
        runtime: OrganizationMediaRuntime | null,
        budget: MediaDeliveryBudgetPool,
      ) => new OrganizationMediaService(db, identity, access, runtime, budget),
    },
  ],
  exports: [
    OrganizationService,
    OrganizationAccess,
    OrganizationAuthorityFacade,
    OrganizationMediaService,
  ],
})
export class OrganizationManagementModule {}
