import { AccountPolicyFor } from '../../safety/account-policy/decorator.js';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { IdentityService } from '../../identity/identity.service.js';
import { LocalSafetyPhoneSource } from '../../verification/safety-phone.source.js';
import { LocalPublicationEligibilitySource } from '../../verification/publication-eligibility.source.js';
import { CampusCommunityPolicyService } from '../../campus/community-policy/campus-community-policy.service.js';
import { CampusService } from '../../campus/campus.service.js';
import { AuthorizationService } from '../../authorization/authorization.service.js';
import { SchoolConfigurationAccess } from '../../school-configuration/access.js';
import { SafetyRepository } from '../../safety/repository.js';
import { lockSafetyPolicy } from '../../safety/locks.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import {
  lockOrganization,
  requireOrganizationCurrent,
  requireOrganizationAccountCurrent,
} from './current-proof.js';
import { organizationDataSchema } from './contracts.js';
import type { OrganizationData } from './contracts.js';
import type {
  OrganizationMediaAccessPort,
  OrganizationMediaActorAuthority,
  OrganizationMediaReadTarget,
} from '../media/access-port.js';
import type { OrganizationMediaBindings } from '../media/contracts.js';
export interface OrganizationRow {
  id: string;
  region_id: string;
  applicant_account_id: string;
  revision: string;
  authority_version: string;
  state: 'draft' | 'pending' | 'rejected' | 'approved';
  taxonomy_revision_id: string;
  category_id: string;
  data: OrganizationData;
  media_bindings: OrganizationMediaBindings;
  first_approval_id: string | null;
  review_reason: string | null;
  created_at: Date;
  updated_at: Date;
}
export interface OrganizationGrant {
  id: string;
  organization_id: string;
  account_id: string;
  role: 'organization_owner' | 'organization_admin';
  valid_from: Date;
  expires_at: Date | null;
  version: string;
}
export type OrganizationAuthority = {
  role: OrganizationMediaActorAuthority['role'];
  grantId: string | null;
};
export const organizationAuthorityVersion = (
  row: OrganizationRow,
  authority: OrganizationAuthority,
) => `${row.authority_version}:${authority.grantId ?? 'applicant'}`;
@Injectable()
export class OrganizationAccess implements OrganizationMediaAccessPort {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(LocalSafetyPhoneSource)
    private readonly phones: LocalSafetyPhoneSource,
    @Inject(LocalPublicationEligibilitySource)
    private readonly affiliations: LocalPublicationEligibilitySource,
    @Inject(CampusCommunityPolicyService)
    private readonly policies: CampusCommunityPolicyService,
    @Inject(CampusService) private readonly campuses: CampusService,
    @Inject(AuthorizationService)
    private readonly authorization: AuthorizationService,
    @Inject(SchoolConfigurationAccess)
    readonly schools: SchoolConfigurationAccess,
    @Inject(SafetyRepository) private readonly safety: SafetyRepository,
  ) {}
  async authenticate(token: string, tx: PoolClient, write = false) {
    await lockSafetyPolicy(tx, write);
    return this.identity.session(token, tx);
  }
  async base(accountId: string, tx: PoolClient) {
    if (!(await this.identity.activeAccount(accountId, tx)))
      throw new ApplicationError('ACCOUNT_BLOCKED');
    const phone = await this.phones.resolve(accountId, tx);
    if (phone.status === 'unverified')
      throw new ApplicationError('PHONE_VERIFICATION_REQUIRED');
    if (phone.status !== 'verified')
      throw new ApplicationError('VERIFICATION_UNAVAILABLE');
    registerTransactionDeadline(
      tx,
      phone.validUntil,
      'VERIFICATION_UNAVAILABLE',
    );
    await this.safety.restriction(accountId, tx);
    await requireOrganizationAccountCurrent(accountId, tx);
  }
  async home(accountId: string, regionId: string | null, tx: PoolClient) {
    await this.base(accountId, tx);
    const affiliation = await this.affiliations.resolve(accountId, tx);
    if (affiliation.status === 'unverified')
      throw new ApplicationError('AFFILIATION_VERIFICATION_REQUIRED');
    if (affiliation.status !== 'verified')
      throw new ApplicationError('VERIFICATION_UNAVAILABLE');
    registerTransactionDeadline(
      tx,
      affiliation.validUntil,
      'VERIFICATION_UNAVAILABLE',
    );
    const campus = await this.policies.resolve(
      accountId,
      affiliation,
      regionId,
      tx,
    );
    if (campus.status === 'selection_required')
      throw new ApplicationError('IDENTITY_CAMPUS_REQUIRED');
    if (campus.status !== 'valid')
      throw new ApplicationError('IDENTITY_CAMPUS_UNAVAILABLE');
    if (
      regionId !== null &&
      (campus.relation !== 'home' || campus.identityRegionId !== regionId)
    )
      throw new ApplicationError('DIRECTORY_SCOPE_UNAVAILABLE');
    registerTransactionDeadline(
      tx,
      campus.validUntil,
      'IDENTITY_CAMPUS_UNAVAILABLE',
    );
    return campus;
  }
  async row(
    id: string,
    tx: PoolClient,
    write = false,
  ): Promise<OrganizationRow> {
    await lockOrganization(id, tx, write);
    const row = (
      await tx.query<OrganizationRow>(
        `SELECT * FROM whaleu_organizations.organizations WHERE id=$1 FOR ${write ? 'UPDATE' : 'SHARE'}`,
        [id],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('ORGANIZATION_NOT_FOUND');
    organizationDataSchema.parse(row.data);
    await this.campuses.requireActiveRegion(row.region_id, tx);
    return row;
  }
  async grants(id: string, tx: PoolClient): Promise<OrganizationGrant[]> {
    const rows = (
      await tx.query<OrganizationGrant>(
        `SELECT id,organization_id,account_id,role,valid_from,expires_at,version FROM whaleu_organizations.organization_grants WHERE organization_id=$1 AND revoked_at IS NULL ORDER BY id LIMIT 101 FOR SHARE`,
        [id],
      )
    ).rows;
    if (rows.length > 100)
      throw new ApplicationError('ORGANIZATION_UNAVAILABLE');
    const now = (
      await tx.query<{ now: Date }>('SELECT clock_timestamp() now')
    ).rows[0]!.now.getTime();
    const current = rows.filter(
      (g) =>
        g.valid_from.getTime() <= now &&
        (g.expires_at === null || g.expires_at.getTime() > now),
    );
    for (const g of current)
      registerTransactionDeadline(
        tx,
        g.expires_at?.getTime() ?? null,
        'AUTHORIZATION_UNAVAILABLE',
      );
    return current;
  }
  async authority(
    accountId: string,
    row: OrganizationRow,
    tx: PoolClient,
    allowApplicant = false,
  ): Promise<OrganizationAuthority> {
    await this.base(accountId, tx);
    const global = await this.authorization.grants(accountId, tx);
    // Pass the organization's actual target region. Never use the taxonomy's shared
    // global region or a user's display/browsing school to select authority.
    if (
      global.some(
        (g) =>
          (g.role === 'super_admin' && g.operatingRegionId === null) ||
          (g.role === 'school_admin' && g.operatingRegionId === row.region_id),
      )
    ) {
      const management = await this.schools.authorizeAccount(
        accountId,
        row.region_id,
        tx,
      );
      return {
        role:
          management.grant.role === 'super_admin'
            ? 'super_admin'
            : 'school_admin',
        grantId: management.grant.id,
      };
    }
    const grant = (await this.grants(row.id, tx)).find(
      (g) => g.account_id === accountId,
    );
    if (grant) {
      await this.home(accountId, row.region_id, tx);
      return { role: grant.role, grantId: grant.id };
    }
    if (
      allowApplicant &&
      row.applicant_account_id === accountId &&
      row.first_approval_id === null
    ) {
      await this.home(accountId, row.region_id, tx);
      return { role: 'applicant', grantId: null };
    }
    throw new ApplicationError('AUTHORIZATION_REQUIRED');
  }
  async canManage(
    accountId: string,
    row: OrganizationRow,
    tx: PoolClient,
  ): Promise<boolean> {
    const grants = await this.authorization.grants(accountId, tx);
    if (
      grants.some(
        (g) =>
          (g.role === 'super_admin' && g.operatingRegionId === null) ||
          (g.role === 'school_admin' && g.operatingRegionId === row.region_id),
      )
    ) {
      await this.schools.authorizeAccount(accountId, row.region_id, tx);
      return true;
    }
    return (await this.grants(row.id, tx)).some(
      (g) => g.account_id === accountId,
    );
  }
  async editable(accountId: string, row: OrganizationRow, tx: PoolClient) {
    if (row.state === 'pending')
      throw new ApplicationError('ORGANIZATION_STATE_CONFLICT');
    const authority = await this.authority(accountId, row, tx, true);
    if (
      authority.role === 'applicant' &&
      !['draft', 'rejected'].includes(row.state)
    )
      throw new ApplicationError('AUTHORIZATION_REQUIRED');
    return authority;
  }
  async reviewer(accountId: string, row: OrganizationRow, tx: PoolClient) {
    await this.base(accountId, tx);
    const scope = await this.schools.authorizeAccount(
      accountId,
      row.region_id,
      tx,
    );
    return {
      role:
        scope.grant.role === 'super_admin'
          ? ('super_admin' as const)
          : ('school_admin' as const),
      grantId: scope.grant.id,
    };
  }
  async authorizeMediaActor(
    accountId: string,
    organizationId: string,
    applicationRevision: number,
    tx: PoolClient,
  ): Promise<OrganizationMediaActorAuthority> {
    const row = await this.row(organizationId, tx, true);
    if (Number(row.revision) !== applicationRevision)
      throw new ApplicationError('ORGANIZATION_REVISION_CONFLICT');
    const authority = await this.editable(accountId, row, tx);
    return {
      actorAccountId: accountId,
      organizationId,
      regionId: row.region_id,
      applicationRevision,
      organizationPlatform: row.data.platform,
      authorityVersion: organizationAuthorityVersion(row, authority),
      ...authority,
    };
  }
  retainMediaCurrent(id: string, tx: PoolClient) {
    return requireOrganizationCurrent(id, tx);
  }
  @AccountPolicyFor(() => 'browse', 'entry')
  async authorizeMediaRead(
    token: string,
    target: OrganizationMediaReadTarget,
    tx: PoolClient,
  ) {
    const session = await this.authenticate(token, tx);
    const row = await this.row(target.organizationId, tx);
    if (Number(row.revision) !== target.applicationRevision)
      throw new ApplicationError('MEDIA_UNAVAILABLE');
    let role: OrganizationAuthority = { role: 'applicant', grantId: null };
    if (target.audience === 'public') {
      if (row.state !== 'approved' || target.slot === 'managerContact')
        throw new ApplicationError('MEDIA_UNAVAILABLE');
      await this.home(session.accountId, row.region_id, tx);
    } else role = await this.authority(session.accountId, row, tx, true);
    await requireOrganizationCurrent(row.id, tx);
    return {
      accountId: session.accountId,
      sessionId: session.sessionId,
      authorityVersion: organizationAuthorityVersion(row, role),
    };
  }
  async recheck(token: string, tx: PoolClient) {
    await this.identity.session(token, tx);
  }
}
