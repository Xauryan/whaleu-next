import { Module } from '@nestjs/common';
import { CommunityExperienceSourceFacade } from '../community/experience-source/facade.js';
import { RatingExperienceSourceModule } from '../ratings/experience-source/module.js';
import { ExperienceSourceRouter } from './source-router.js';

/** Source reads need no mutable Community/Ratings application modules. */
@Module({
  imports: [RatingExperienceSourceModule],
  providers: [CommunityExperienceSourceFacade, ExperienceSourceRouter],
  exports: [ExperienceSourceRouter],
})
export class ExperienceSourceModule {}
