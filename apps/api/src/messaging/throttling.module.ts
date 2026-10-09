import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { IdentityModule } from '../identity/identity.module.js';
import { PostgresRequestThrottlingModule } from '../request-throttling/module.js';
import { PostgresThrottlerStorage } from '../request-throttling/postgres-storage.js';
import { MessagingRequestGuard } from './request.guard.js';
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
          { name: 'default', ttl: 60000, limit: 240, blockDuration: 60000 },
        ],
      }),
    }),
  ],
  providers: [MessagingRequestGuard],
  exports: [MessagingRequestGuard],
})
export class MessagingRequestThrottlingModule {}
