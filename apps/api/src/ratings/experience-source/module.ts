import { Module } from '@nestjs/common';
import { RatingExperienceSourceFacade } from './facade.js';

@Module({
  providers: [RatingExperienceSourceFacade],
  exports: [RatingExperienceSourceFacade],
})
export class RatingExperienceSourceModule {}
