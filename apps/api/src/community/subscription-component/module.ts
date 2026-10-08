import { SubscriptionComponentRuntime } from './runtime.js';
import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.js';
import { CommunitySubscriptionEnrollment } from './enrollment.js';
import { SubscriptionComponentRepository } from './repository.js';
import { SubscriptionComponentSettlement } from './settlement.js';
import { SubscriptionComponentWorker } from './worker.js';
@Module({
  imports: [DatabaseModule],
  providers: [
    SubscriptionComponentRuntime,
    CommunitySubscriptionEnrollment,
    SubscriptionComponentRepository,
    SubscriptionComponentSettlement,
    SubscriptionComponentWorker,
  ],
  exports: [
    SubscriptionComponentRuntime,
    CommunitySubscriptionEnrollment,
    SubscriptionComponentRepository,
    SubscriptionComponentSettlement,
    SubscriptionComponentWorker,
  ],
})
export class CommunitySubscriptionComponentModule {}
