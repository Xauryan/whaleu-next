import type { PoolClient } from 'pg';
import type { OrganizationMediaSlot } from './contracts.js';
export interface OrganizationMediaActorAuthority {
  readonly actorAccountId: string;
  readonly organizationId: string;
  readonly regionId: string;
  readonly applicationRevision: number;
  readonly organizationPlatform: 'qq' | 'wechat' | 'official';
  readonly authorityVersion: string;
  readonly role:
    | 'applicant'
    | 'organization_owner'
    | 'organization_admin'
    | 'school_admin'
    | 'super_admin';
  readonly grantId: string | null;
}
export interface OrganizationMediaReadTarget {
  readonly organizationId: string;
  readonly applicationRevision: number;
  readonly slot: OrganizationMediaSlot;
  readonly audience: 'public' | 'management';
  readonly campusId: string | null;
}
/** Organizations owns every live permission and final owner proof. Media never
 * infers ownership from a directory row, approval, school affiliation or labels. */
export interface OrganizationMediaAccessPort {
  retainMediaCurrent(organizationId: string, tx: PoolClient): Promise<void>;
  authorizeMediaActor(
    accountId: string,
    organizationId: string,
    applicationRevision: number,
    tx: PoolClient,
  ): Promise<OrganizationMediaActorAuthority>;
  authorizeMediaRead(
    token: string,
    target: OrganizationMediaReadTarget,
    tx: PoolClient,
  ): Promise<{
    readonly accountId: string;
    readonly sessionId: string;
    readonly authorityVersion: string;
  }>;
}
