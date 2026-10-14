import { RatingPromotionScheduler } from './schedule.js';
import { PromotionRequestGuard } from './request-guard.js';
import { RatingPromotionRetention } from './retention.js';
import { RatingPromotionQualification } from './qualification.js';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.js';
import { IdentityModule } from '../../identity/identity.module.js';
import { RATING_GROUP_PROMOTION_RUNTIME } from './contracts.js';
import {
  RATING_GROUP_OPERATOR_RENDERER,
  defaultRatingGroupOperatorRenderer,
  RatingGroupPromotionController,
  RatingGroupPromotionOperatorController,
} from './controller.js';
import { RatingGroupPromotionService } from './service.js';
import { RatingPromotionEnrollment } from './enrollment.js';
import { RatingPromotionSource } from './source.js';
import { RatingPromotionAuthority } from './authority.js';
import { RatingGroupRepository } from '../../notifications/rating-group/repository.js';
import { RatingGroupWorker } from '../../notifications/rating-group/worker.js';
@Module({
  imports: [DatabaseModule, IdentityModule],
  controllers: [
    RatingGroupPromotionController,
    RatingGroupPromotionOperatorController,
  ],
  providers: [
    {
      provide: RATING_GROUP_OPERATOR_RENDERER,
      useValue: defaultRatingGroupOperatorRenderer,
    },
    PromotionRequestGuard,
    { provide: RATING_GROUP_PROMOTION_RUNTIME, useValue: null },
    RatingGroupPromotionService,
    RatingPromotionEnrollment,
    RatingPromotionSource,
    RatingPromotionAuthority,
    RatingPromotionQualification,
    RatingPromotionRetention,
    RatingPromotionScheduler,
    RatingGroupRepository,
    RatingGroupWorker,
  ],
  exports: [
    RatingGroupPromotionService,
    RatingPromotionEnrollment,
    RatingGroupWorker,
    RatingPromotionSource,
    RatingPromotionAuthority,
    RatingPromotionQualification,
    RatingPromotionRetention,
    RatingPromotionScheduler,
  ],
})
export class RatingGroupPromotionModule {}
