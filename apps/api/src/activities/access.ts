import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { IdentityService } from '../identity/identity.service.js';
import { LocalSafetyPhoneSource } from '../verification/safety-phone.source.js';
import { LocalPublicationEligibilitySource } from '../verification/publication-eligibility.source.js';
import { CampusCommunityPolicyService } from '../campus/community-policy/campus-community-policy.service.js';
import { SafetyActivityReadFacade } from '../safety/activity-read.facade.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import { ApplicationError } from '../http/application-error.js';
import { lockSafetyPolicy } from '../safety/locks.js';

@Injectable()
export class ActivityAccessService {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(LocalSafetyPhoneSource)
    private readonly phones: LocalSafetyPhoneSource,
    @Inject(LocalPublicationEligibilitySource)
    private readonly affiliations: LocalPublicationEligibilitySource,
    @Inject(CampusCommunityPolicyService)
    private readonly campuses: CampusCommunityPolicyService,
    @Inject(SafetyActivityReadFacade)
    private readonly safety: SafetyActivityReadFacade,
  ) {}
  async authenticate(token: string, tx: PoolClient) {
    await lockSafetyPolicy(tx);
    return this.identity.session(token, tx);
  }
  async resolve(token: string, regionId: string | null, tx: PoolClient) {
    await lockSafetyPolicy(tx);
    const session = await this.identity.session(token, tx);
    const phone = await this.phones.resolve(session.accountId, tx);
    if (phone.status === 'unverified')
      throw new ApplicationError('PHONE_VERIFICATION_REQUIRED');
    if (phone.status !== 'verified')
      throw new ApplicationError('VERIFICATION_UNAVAILABLE');
    registerTransactionDeadline(
      tx,
      phone.validUntil,
      'VERIFICATION_UNAVAILABLE',
    );
    await this.safety.requireAllowed(session.accountId, tx);
    const affiliation = await this.affiliations.resolve(session.accountId, tx);
    if (affiliation.status === 'unverified')
      throw new ApplicationError('AFFILIATION_VERIFICATION_REQUIRED');
    if (affiliation.status !== 'verified')
      throw new ApplicationError('VERIFICATION_UNAVAILABLE');
    registerTransactionDeadline(
      tx,
      affiliation.validUntil,
      'VERIFICATION_UNAVAILABLE',
    );
    const campus = await this.campuses.resolve(
      session.accountId,
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
      throw new ApplicationError('ACTIVITY_SCOPE_UNAVAILABLE');
    registerTransactionDeadline(
      tx,
      campus.validUntil,
      'IDENTITY_CAMPUS_UNAVAILABLE',
    );
    return {
      session,
      regionId: campus.identityRegionId,
      selectionId: campus.selectionId,
      topologySnapshotId: campus.topologySnapshotId,
    };
  }
  async recheck(token: string, tx: PoolClient) {
    await this.identity.session(token, tx);
  }
}
