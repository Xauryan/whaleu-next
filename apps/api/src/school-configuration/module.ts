import { SchoolQrRequestGuard } from './media/request-guard.js';
import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { DatabaseModule, DatabaseService } from '../database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { IdentityService } from '../identity/identity.service.js';
import { CampusModule } from '../campus/campus.module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { SafetyPolicyModule } from '../safety/policy.module.js';
import { PostgresRequestThrottlingModule } from '../request-throttling/module.js';
import { PostgresThrottlerStorage } from '../request-throttling/postgres-storage.js';
import { MediaDeliveryBudgetModule } from '../media/delivery-budget.module.js';
import { MediaDeliveryBudgetPool } from '../media/delivery-budget.js';
import { SchoolConfigurationAccess } from './access.js';
import { SchoolConfigurationRepository } from './repository.js';
import { SchoolConfigurationService } from './service.js';
import {
  SchoolConfigurationController,
  SchoolServicesController,
} from './controller.js';
import { SchoolConfigurationRequestGuard } from './request-guard.js';
import {
  SchoolQrMediaService,
  SCHOOL_QR_MEDIA_RUNTIME,
} from './media/facade.js';
import type { SchoolQrMediaRuntime } from './media/facade.js';
import {
  SchoolQrMediaController,
  SchoolQrMultipartInterceptor,
} from './media/controller.js';
@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    CampusModule,
    AuthorizationModule,
    SafetyPolicyModule,
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
  controllers: [
    SchoolServicesController,
    SchoolConfigurationController,
    SchoolQrMediaController,
  ],
  providers: [
    SchoolConfigurationAccess,
    SchoolConfigurationRepository,
    SchoolConfigurationService,
    SchoolConfigurationRequestGuard,
    SchoolQrRequestGuard,
    SchoolQrMultipartInterceptor,
    { provide: SCHOOL_QR_MEDIA_RUNTIME, useValue: null },
    {
      provide: SchoolQrMediaService,
      inject: [
        DatabaseService,
        IdentityService,
        SchoolConfigurationAccess,
        SCHOOL_QR_MEDIA_RUNTIME,
        MediaDeliveryBudgetPool,
      ],
      useFactory: (
        database: DatabaseService,
        identity: IdentityService,
        access: SchoolConfigurationAccess,
        runtime: SchoolQrMediaRuntime | null,
        budget: MediaDeliveryBudgetPool,
      ) =>
        new SchoolQrMediaService(database, identity, access, runtime, budget),
    },
  ],
  exports: [
    SchoolConfigurationService,
    SchoolConfigurationAccess,
    SchoolQrMediaService,
  ],
})
export class SchoolConfigurationModule {}
