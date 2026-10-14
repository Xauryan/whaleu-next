import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { DatabaseModule } from '../database/database.js';
import { CampusModule } from '../campus/campus.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { SafetyPolicyModule } from '../safety/policy.module.js';
import { MediaDeliveryBudgetModule } from '../media/delivery-budget.module.js';
import { PostgresRequestThrottlingModule } from '../request-throttling/module.js';
import { PostgresThrottlerStorage } from '../request-throttling/postgres-storage.js';
import { CampusToolsService } from './service.js';
import { CampusToolsController } from './controller.js';
import { CampusToolsRequestGuard } from './request-guard.js';
import { CampusToolsMediaService } from './media/service.js';
import { CampusToolsMediaController } from './media/controller.js';
import { CAMPUS_TOOLS_RUNTIME } from './runtime.js';
@Module({
  imports: [
    DatabaseModule,
    CampusModule,
    IdentityModule,
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
  controllers: [CampusToolsController, CampusToolsMediaController],
  providers: [
    CampusToolsService,
    CampusToolsMediaService,
    CampusToolsRequestGuard,
    { provide: CAMPUS_TOOLS_RUNTIME, useValue: null },
  ],
  exports: [CampusToolsService, CampusToolsMediaService],
})
export class CampusToolsModule {}
