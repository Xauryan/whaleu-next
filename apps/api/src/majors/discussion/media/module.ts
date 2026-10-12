import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { IdentityModule } from '../../../identity/identity.module.js';
import { PostgresRequestThrottlingModule } from '../../../request-throttling/module.js';
import { PostgresThrottlerStorage } from '../../../request-throttling/postgres-storage.js';
import { MajorDiscussionMediaRequestGuard } from './request-guard.js';
/** Owner access and facade are wired by MajorRatingsModule, avoiding a circular
 * dependency between publication and image authority. */
@Module({
  imports: [
    IdentityModule,
    PostgresRequestThrottlingModule,
    ThrottlerModule.forRootAsync({
      imports: [PostgresRequestThrottlingModule],
      inject: [PostgresThrottlerStorage],
      useFactory: (storage: PostgresThrottlerStorage) => ({
        storage,
        setHeaders: false,
        throttlers: [
          { name: 'default', ttl: 60000, limit: 120, blockDuration: 60000 },
        ],
      }),
    }),
  ],
  providers: [MajorDiscussionMediaRequestGuard],
  exports: [MajorDiscussionMediaRequestGuard],
})
export class MajorDiscussionMediaThrottlingModule {}
