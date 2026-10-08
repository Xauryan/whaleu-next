import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.js';
import { CommunityLikeEnrollment } from './enrollment.js';
import { LikeComponentRepository } from './repository.js';
import { LikeComponentSettlement } from './settlement.js';
import { LikeComponentWorker } from './worker.js';
@Module({
  imports: [DatabaseModule],
  providers: [
    CommunityLikeEnrollment,
    LikeComponentRepository,
    LikeComponentSettlement,
    LikeComponentWorker,
  ],
  exports: [
    CommunityLikeEnrollment,
    LikeComponentRepository,
    LikeComponentSettlement,
    LikeComponentWorker,
  ],
})
export class CommunityLikeComponentModule {}
