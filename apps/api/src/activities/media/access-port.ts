import type { PoolClient } from 'pg';
import type { ActivityMediaSlot } from './contracts.js';
export interface ActivityMediaActorAuthority {
  readonly actorAccountId: string;
  readonly activityId: string;
  readonly revision: number;
  readonly organizationId: string;
  readonly organizationRevision: number;
  readonly authorityVersion: string;
}
export interface ActivityMediaReadTarget {
  readonly activityId: string;
  readonly revision: number;
  readonly slot: ActivityMediaSlot;
  readonly audience: 'public' | 'management';
}
/** Activities owns live draft/publication, organization, session and Safety
 * authorization. Media never infers permission from a copied pointer. */
export interface ActivityMediaAccessPort {
  retainMediaCurrent(activityId: string, tx: PoolClient): Promise<void>;
  authorizeMediaActor(
    accountId: string,
    activityId: string,
    revision: number,
    tx: PoolClient,
  ): Promise<ActivityMediaActorAuthority>;
  authorizeMediaRead(
    token: string,
    target: ActivityMediaReadTarget,
    tx: PoolClient,
  ): Promise<{
    readonly accountId: string;
    readonly sessionId: string;
    readonly authorityVersion: string;
  }>;
}
