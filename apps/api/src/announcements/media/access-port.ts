import type { PoolClient } from 'pg';
import type { AnnouncementMediaSlot } from './contracts.js';
export interface AnnouncementMediaActorAuthority {
  readonly actorAccountId: string;
  readonly announcementId: string;
  readonly revision: number;
  readonly authorityVersion: string;
}
export interface AnnouncementMediaReadTarget {
  readonly announcementId: string;
  readonly revision: number;
  readonly slot: AnnouncementMediaSlot;
  readonly audience: 'public' | 'management';
  readonly campusId: string | null;
}
/** Announcements owns current publication/audience, session, grant and Safety
 * authorization. Media never infers permission from a copied pointer. */
export interface AnnouncementMediaAccessPort {
  retainMediaCurrent(announcementId: string, tx: PoolClient): Promise<void>;
  authorizeMediaActor(
    accountId: string,
    announcementId: string,
    revision: number,
    tx: PoolClient,
  ): Promise<AnnouncementMediaActorAuthority>;
  authorizeMediaRead(
    token: string | null,
    target: AnnouncementMediaReadTarget,
    tx: PoolClient,
  ): Promise<{
    readonly accountId: string | null;
    readonly sessionId: string | null;
    readonly authorityVersion: string;
  }>;
}
