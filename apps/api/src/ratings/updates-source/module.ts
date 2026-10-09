import { Module } from '@nestjs/common';
import { RatingsReadModule } from '../read.module.js';
import { RatingsUpdatesSourceFacade } from './facade.js';
import { RatingUpdatesProjectionFacade } from './projection.js';
@Module({
  imports: [RatingsReadModule],
  providers: [RatingsUpdatesSourceFacade, RatingUpdatesProjectionFacade],
  exports: [RatingsUpdatesSourceFacade, RatingUpdatesProjectionFacade],
})
export class RatingUpdatesSourceModule {}
