import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { ExperienceSourceModule } from './source-module.js';
import { AuthorizationModule } from '../authorization/authorization.module.js';
import { ExperienceTitleMaintenanceController } from './maintenance.controller.js';
import { ExperienceTitleMaintenanceService } from './maintenance.service.js';
import { TitleMaintenanceRepository } from './maintenance.repository.js';
import {
  ExperienceCatalogController,
  ExperienceController,
} from './controller.js';
import { ExperienceClock, ExperienceRepository } from './repository.js';
import { ExperienceSettlementService } from './settlement.js';
import { ExperienceService } from './service.js';
import { ExperienceWorker } from './worker.js';
import { ExperienceDispatcher } from './dispatcher.js';
import { ExperienceRedemptionService } from './redemption.service.js';
import { RedemptionRepository } from './redemption.repository.js';
import {
  RedemptionProvider,
  RedemptionAttemptBudget,
} from './redemption.provider.js';
@Module({
  imports: [
    DatabaseModule,
    IdentityModule,
    ExperienceSourceModule,
    AuthorizationModule,
  ],
  controllers: [
    ExperienceCatalogController,
    ExperienceController,
    ExperienceTitleMaintenanceController,
  ],
  providers: [
    ExperienceClock,
    ExperienceRepository,
    ExperienceSettlementService,
    ExperienceService,
    ExperienceWorker,
    ExperienceDispatcher,
    ExperienceRedemptionService,
    RedemptionRepository,
    RedemptionProvider,
    RedemptionAttemptBudget,
    ExperienceTitleMaintenanceService,
    TitleMaintenanceRepository,
  ],
  exports: [ExperienceService, ExperienceWorker, ExperienceDispatcher],
})
export class ExperienceModule {}
