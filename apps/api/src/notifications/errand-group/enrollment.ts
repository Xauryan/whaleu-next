import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ERRAND_GROUP_RUNTIME } from './contracts.js';
import type { ErrandGroupRuntime } from './contracts.js';
/** The only entry point is the genuine Errands publish transition transaction.
 * No historical scan, backlog adoption, session impersonation or scheduler. */
@Injectable()
export class ErrandGroupEnrollment {
  constructor(
    @Inject(ERRAND_GROUP_RUNTIME)
    private readonly runtime: ErrandGroupRuntime | null,
  ) {}
  async record(
    eventId: string,
    orderId: string,
    targetRegionId: string,
    publishedAt: string,
    tx: PoolClient,
  ) {
    if (this.runtime?.mode !== 'synthetic-only') return;
    await tx.query(
      `INSERT INTO whaleu_notifications.errand_group_publications(event_id,order_id,target_region_id,published_at)
      VALUES($1,$2,$3,$4) ON CONFLICT(event_id) DO NOTHING`,
      [eventId, orderId, targetRegionId, publishedAt],
    );
  }
}
