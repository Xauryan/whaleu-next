import { Inject, Injectable, Module } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  DiscoveryCursorRepository,
  discoveryCursorBucket,
  discoveryScopeHash,
} from './discovery-cursors.js';
import type { DiscoveryPosition } from './discovery-cursors.js';

/** Application-facing owner boundary for opaque navigation metadata only.
 * Call create after domain locks/session checks; it never authorizes a read. */
@Injectable()
export class DiscoveryContinuationFacade {
  constructor(
    @Inject(DiscoveryCursorRepository)
    private readonly records: DiscoveryCursorRepository,
  ) {}
  get<T>(
    cursor: string,
    scope: string,
    tx: PoolClient,
    validate: (value: unknown) => T,
  ) {
    return this.records.get(cursor, scope, tx, validate);
  }
  create(
    scope: string,
    accountId: string,
    position: DiscoveryPosition,
    tx: PoolClient,
  ) {
    return this.records.create(
      scope,
      discoveryCursorBucket(accountId),
      position,
      tx,
    );
  }
}
export const discoveryContinuationScope = discoveryScopeHash;
@Module({
  providers: [DiscoveryCursorRepository, DiscoveryContinuationFacade],
  exports: [DiscoveryContinuationFacade],
})
export class DiscoveryContinuationModule {}
