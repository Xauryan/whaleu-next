import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.js';
import { CommunityViewEnrollment } from './enrollment.js';
import { ViewComponentRepository } from './repository.js';
import { ViewComponentCleanup } from './cleanup.js';
@Module({
  imports: [DatabaseModule],
  providers: [
    CommunityViewEnrollment,
    ViewComponentRepository,
    ViewComponentCleanup,
  ],
  exports: [
    CommunityViewEnrollment,
    ViewComponentRepository,
    ViewComponentCleanup,
  ],
})
export class CommunityViewComponentModule {}
