import { RatingRequestGuard } from './rating-request.guard.js';
import { ErrandRequestGuard } from './errand-request.guard.js';
import { ActivityRequestGuard } from './activity-request.guard.js';
import { AnnouncementRequestGuard } from './announcement-request.guard.js';
import { DirectoryRequestGuard } from './directory-request.guard.js';
import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';
import { DatabaseModule } from '../database/database.js';
import { IdentityModule } from '../identity/identity.module.js';
import { PostgresThrottlerStorage } from './postgres-storage.js';
import { ViewReportingRequestGuard } from './view-request.guard.js';

@Module({
  imports: [DatabaseModule],
  providers: [PostgresThrottlerStorage],
  exports: [PostgresThrottlerStorage],
})
export class PostgresRequestThrottlingModule {}

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
  providers: [ViewReportingRequestGuard],
  exports: [ViewReportingRequestGuard, IdentityModule],
})
export class ViewRequestThrottlingModule {}

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
  providers: [DirectoryRequestGuard],
  exports: [DirectoryRequestGuard],
})
export class DirectoryRequestThrottlingModule {}

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
  providers: [AnnouncementRequestGuard],
  exports: [AnnouncementRequestGuard],
})
export class AnnouncementRequestThrottlingModule {}

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
  providers: [ActivityRequestGuard],
  exports: [ActivityRequestGuard],
})
export class ActivityRequestThrottlingModule {}

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
  providers: [ErrandRequestGuard],
  exports: [ErrandRequestGuard],
})
export class ErrandRequestThrottlingModule {}

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
  providers: [RatingRequestGuard],
  exports: [RatingRequestGuard],
})
export class RatingRequestThrottlingModule {}
