import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { IdentityService } from '../identity/identity.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { ActiveGrant } from '../authorization/contracts.js';
import { CampusService } from '../campus/campus.service.js';
import type { OperatingRegion } from '../campus/contracts.js';
import { ApplicationError } from '../http/application-error.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import { SafetyRepository } from '../safety/repository.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import { requireSchoolCurrent } from './current-proof.js';

/** School administration is intentionally narrower than generic global management.
 * Selected campus, verified school, cosmetic titles and developer grants cannot grant it. */
export function selectSchoolManagement(
  grants: readonly ActiveGrant[],
  regionId?: string,
) {
  const global = grants
    .filter(
      (grant) =>
        grant.role === 'super_admin' && grant.operatingRegionId === null,
    )
    .sort((a, b) => a.id.localeCompare(b.id))[0];
  if (global) {
    if (!regionId)
      throw new BadRequestException('An explicit target region is required');
    return { grant: global, regionId, management: 'global' as const };
  }
  const schools = grants.filter(
    (grant) =>
      grant.role === 'school_admin' && grant.operatingRegionId !== null,
  );
  if (!schools.length) throw new ApplicationError('AUTHORIZATION_REQUIRED');
  if (schools.length !== 1)
    throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
  const grant = schools[0]!;
  if (regionId !== undefined && regionId !== grant.operatingRegionId)
    throw new ApplicationError('AUTHORIZATION_REQUIRED');
  return {
    grant,
    regionId: grant.operatingRegionId!,
    management: 'fixed' as const,
  };
}
@Injectable()
export class SchoolConfigurationAccess {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(AuthorizationService)
    private readonly authorization: AuthorizationService,
    @Inject(CampusService) private readonly campuses: CampusService,
    @Inject(SafetyRepository) private readonly safety: SafetyRepository,
  ) {}
  async authenticate(token: string, tx: PoolClient) {
    await lockSafetyPolicy(tx);
    const session = await this.identity.session(token, tx);
    await this.safety.restriction(session.accountId, tx);
    return session;
  }
  async authorizeAccount(
    accountId: string,
    regionId: string | undefined,
    tx: PoolClient,
  ) {
    await lockSafetyPolicy(tx);
    await this.safety.restriction(accountId, tx);
    const scope = selectSchoolManagement(
      await this.authorization.grants(accountId, tx),
      regionId,
    );
    registerTransactionDeadline(
      tx,
      scope.grant.validUntil,
      'AUTHORIZATION_UNAVAILABLE',
    );
    const region = await this.campuses.requireActiveRegion(scope.regionId, tx);
    return { grant: scope.grant, management: scope.management, region };
  }
  async management(
    token: string,
    regionId: string | undefined,
    tx: PoolClient,
  ) {
    const session = await this.authenticate(token, tx);
    return {
      session,
      ...(await this.authorizeAccount(session.accountId, regionId, tx)),
    };
  }
  async capabilities(token: string, tx: PoolClient) {
    const session = await this.authenticate(token, tx);
    const grants = await this.authorization.grants(session.accountId, tx);
    const global = grants.find(
      (grant) =>
        grant.role === 'super_admin' && grant.operatingRegionId === null,
    );
    if (global) {
      registerTransactionDeadline(
        tx,
        global.validUntil,
        'AUTHORIZATION_UNAVAILABLE',
      );
      return { management: 'global' as const, region: null };
    }
    const schools = grants.filter(
      (grant) =>
        grant.role === 'school_admin' && grant.operatingRegionId !== null,
    );
    if (!schools.length) return { management: 'none' as const, region: null };
    const selected = selectSchoolManagement(grants);
    registerTransactionDeadline(
      tx,
      selected.grant.validUntil,
      'AUTHORIZATION_UNAVAILABLE',
    );
    const region = await this.campuses.requireActiveRegion(
      selected.regionId,
      tx,
    );
    return {
      management: 'fixed' as const,
      region: { id: region.id, name: region.name },
    };
  }
  async browse(token: string | null, campusId: string, tx: PoolClient) {
    await lockSafetyPolicy(tx);
    const session = token === null ? null : await this.authenticate(token, tx);
    const campus = await this.campuses.requireSelectable(campusId, tx);
    const region =
      (
        await tx.query<OperatingRegion>(
          `SELECT r.id,r.name,r.is_active AS "isActive" FROM whaleu_campus.campus_region_assignments a JOIN whaleu_campus.operating_regions r ON r.id=a.operating_region_id WHERE a.campus_id=$1 FOR SHARE OF a,r`,
          [campusId],
        )
      ).rows[0] ?? null;
    if (region && !region.isActive)
      throw new ApplicationError('COMMUNITY_SCOPE_UNAVAILABLE');
    await requireSchoolCurrent({ campusId, regionId: null, key: null }, tx);
    return {
      session,
      campus: { id: campus.id, fullName: campus.fullName },
      region,
    };
  }
}
