import { ThrottlerModule } from '@nestjs/throttler';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { IdentityService } from '../identity/identity.service.js';
import { DatabaseService } from '../database/database.js';
import { PostgresRequestThrottlingModule } from '../request-throttling/module.js';
import { PostgresThrottlerStorage } from '../request-throttling/postgres-storage.js';
import { MediaDeliveryBudgetModule } from '../media/delivery-budget.module.js';
import { MediaDeliveryBudgetPool } from '../media/delivery-budget.js';
import { AnnouncementAuthoringAccess } from './authoring/access.js';
import { AnnouncementAuthoringService } from './authoring/service.js';
import {
  AnnouncementManagementController,
  NativeAnnouncementsController,
  OwnNativeAnnouncementsController,
} from './authoring/controller.js';
import {
  AnnouncementMediaService,
  ANNOUNCEMENT_MEDIA_RUNTIME,
} from './media/facade.js';
import type { AnnouncementMediaRuntime } from './media/facade.js';
import {
  AnnouncementMediaController,
  AnnouncementMultipartInterceptor,
} from './media/controller.js';
import { AnnouncementMediaRequestGuard } from './media/request-guard.js';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { CampusModule } from '../campus/campus.module.js';
import { SafetyPolicyModule } from '../safety/policy.module.js';
import { DiscoveryContinuationModule } from '../community/discovery-continuation.module.js';
import { AnnouncementRequestThrottlingModule } from '../request-throttling/module.js';
import {
  AnnouncementsController,
  OwnAnnouncementsController,
} from './controller.js';
import { AnnouncementsService } from './service.js';
import { AnnouncementsRepository } from './repository.js';
import { AnnouncementsAccessService } from './access.js';
import { AnnouncementsCursorRepository } from './cursor.js';
@Module({
  imports: [
    DatabaseModule,
    AuthorizationModule,
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
    IdentityModule,
    CampusModule,
    SafetyPolicyModule,
    DiscoveryContinuationModule,
    AnnouncementRequestThrottlingModule,
  ],
  controllers: [
    AnnouncementsController,
    OwnAnnouncementsController,
    AnnouncementManagementController,
    NativeAnnouncementsController,
    OwnNativeAnnouncementsController,
    AnnouncementMediaController,
  ],
  providers: [
    AnnouncementAuthoringAccess,
    AnnouncementAuthoringService,
    AnnouncementMediaRequestGuard,
    AnnouncementMultipartInterceptor,
    { provide: ANNOUNCEMENT_MEDIA_RUNTIME, useValue: null },
    {
      provide: AnnouncementMediaService,
      inject: [
        DatabaseService,
        IdentityService,
        AnnouncementAuthoringAccess,
        ANNOUNCEMENT_MEDIA_RUNTIME,
        MediaDeliveryBudgetPool,
      ],
      useFactory: (
        db: DatabaseService,
        identity: IdentityService,
        access: AnnouncementAuthoringAccess,
        runtime: AnnouncementMediaRuntime | null,
        budget: MediaDeliveryBudgetPool,
      ) => new AnnouncementMediaService(db, identity, access, runtime, budget),
    },
    AnnouncementsService,
    AnnouncementsRepository,
    AnnouncementsAccessService,
    AnnouncementsCursorRepository,
  ],
  exports: [
    AnnouncementAuthoringService,
    AnnouncementAuthoringAccess,
    AnnouncementMediaService,
  ],
})
export class AnnouncementsModule {}
