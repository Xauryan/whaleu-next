import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { CommunityModule } from '../community/community.module.js';
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
  imports: [DatabaseModule, IdentityModule, CommunityModule],
  controllers: [ExperienceCatalogController, ExperienceController],
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
  ],
  exports: [ExperienceService, ExperienceWorker, ExperienceDispatcher],
})
export class ExperienceModule {}
