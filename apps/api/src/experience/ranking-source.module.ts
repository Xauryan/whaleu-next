import { Module } from '@nestjs/common';
import { ExperienceRankingSourceFacade } from './ranking-source.facade.js';
@Module({
  providers: [ExperienceRankingSourceFacade],
  exports: [ExperienceRankingSourceFacade],
})
export class ExperienceRankingSourceModule {}
