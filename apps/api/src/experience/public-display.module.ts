import { Module } from '@nestjs/common';
import { ExperiencePublicDisplayFacade } from './public-display.facade.js';

/** Database-only leaf; no worker, private owner service or application owner. */
@Module({
  providers: [ExperiencePublicDisplayFacade],
  exports: [ExperiencePublicDisplayFacade],
})
export class ExperiencePublicDisplayModule {}
