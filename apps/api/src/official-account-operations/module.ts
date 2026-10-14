import { OfficialRequestGuard } from './request-guard.js';
import { OfficialArticleOperatorController } from './operator-controller.js';
import { Module } from '@nestjs/common';
import { DatabaseModule, DatabaseService } from '../database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { IdentityService } from '../identity/identity.service.js';
import { OfficialAccountOperationsService } from './service.js';
import type { OfficialRuntime } from './service.js';
import { OFFICIAL_RUNTIME } from './contracts.js';
import {
  OfficialAccountOperationsController,
  OfficialAccountCallbackController,
} from './controller.js';
import { OfficialCallbackBoundary } from './callback-ledger.js';
import type { SyntheticCallbackRuntime } from './callback-ledger.js';
export const OFFICIAL_CALLBACK_RUNTIME = Symbol('OFFICIAL_CALLBACK_RUNTIME');
@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [
    OfficialAccountOperationsController,
    OfficialAccountCallbackController,
    OfficialArticleOperatorController,
  ],
  providers: [
    OfficialRequestGuard,
    { provide: OFFICIAL_RUNTIME, useValue: null },
    { provide: OFFICIAL_CALLBACK_RUNTIME, useValue: null },
    {
      provide: OfficialAccountOperationsService,
      inject: [DatabaseService, IdentityService, OFFICIAL_RUNTIME],
      useFactory: (
        database: DatabaseService,
        identity: IdentityService,
        runtime: OfficialRuntime | null,
      ) => new OfficialAccountOperationsService(database, identity, runtime),
    },
    {
      provide: OfficialCallbackBoundary,
      inject: [DatabaseService, OFFICIAL_CALLBACK_RUNTIME],
      useFactory: (
        database: DatabaseService,
        runtime: SyntheticCallbackRuntime | null,
      ) => new OfficialCallbackBoundary(database, runtime),
    },
  ],
  exports: [OfficialAccountOperationsService],
})
export class OfficialAccountOperationsModule {}
