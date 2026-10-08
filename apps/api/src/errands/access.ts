import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { IdentityService } from '../identity/identity.service.js';
import { LocalSafetyPhoneSource } from '../verification/safety-phone.source.js';
import { LocalPublicationEligibilitySource } from '../verification/publication-eligibility.source.js';
import { LocalErrandBaseEligibilitySource } from '../verification/errand-base.source.js';
import { CampusCommunityPolicyService } from '../campus/community-policy/campus-community-policy.service.js';
import { AuthorizationService } from '../authorization/authorization.service.js';
import { SafetyErrandFacade } from '../safety/errand.facade.js';
import { ApplicationError } from '../http/application-error.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import { lockSafetyPolicy } from '../safety/locks.js';
@Injectable()
export class ErrandAccessService {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(LocalSafetyPhoneSource)
    private readonly phones: LocalSafetyPhoneSource,
    @Inject(LocalPublicationEligibilitySource)
    private readonly affiliations: LocalPublicationEligibilitySource,
    @Inject(LocalErrandBaseEligibilitySource)
    private readonly temporary: LocalErrandBaseEligibilitySource,
    @Inject(CampusCommunityPolicyService)
    private readonly campus: CampusCommunityPolicyService,
    @Inject(AuthorizationService)
    private readonly authorization: AuthorizationService,
    @Inject(SafetyErrandFacade) private readonly safety: SafetyErrandFacade,
  ) {}
  async authenticate(token: string, tx: PoolClient, write = false) {
    await lockSafetyPolicy(tx, write);
    return this.identity.session(token, tx);
  }
  async common(token: string, tx: PoolClient, write = false) {
    const session = await this.authenticate(token, tx, write);
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
    return session;
  }
  async base(accountId: string, tx: PoolClient) {
    const affiliation = await this.affiliations.resolve(accountId, tx);
    if (affiliation.status === 'verified') {
      registerTransactionDeadline(
        tx,
        affiliation.validUntil,
        'VERIFICATION_UNAVAILABLE',
      );
      return;
    }
    const grant = (await this.authorization.grants(accountId, tx))[0];
    if (grant) {
      registerTransactionDeadline(
        tx,
        grant.validUntil,
        'AUTHORIZATION_UNAVAILABLE',
      );
      return;
    }
    const temporary = await this.temporary.resolve(accountId, tx);
    if (temporary.status === 'verified') return;
    if (
      affiliation.status === 'unavailable' ||
      temporary.status === 'unavailable'
    )
      throw new ApplicationError('VERIFICATION_UNAVAILABLE');
    throw new ApplicationError('AFFILIATION_VERIFICATION_REQUIRED');
  }
  async scope(accountId: string, targetRegionId: string, tx: PoolClient) {
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
    const campus = await this.campus.resolve(
      accountId,
      affiliation,
      targetRegionId,
      tx,
    );
    if (campus.status === 'selection_required')
      throw new ApplicationError('IDENTITY_CAMPUS_REQUIRED');
    if (campus.status !== 'valid')
      throw new ApplicationError('IDENTITY_CAMPUS_UNAVAILABLE');
    registerTransactionDeadline(
      tx,
      campus.validUntil,
      'IDENTITY_CAMPUS_UNAVAILABLE',
    );
    return {
      targetRegionId,
      sourceRegionId: campus.identityRegionId,
      identityCampusId: campus.campusId,
      identitySelectionId: campus.selectionId,
      topologySnapshotId: campus.topologySnapshotId,
      affiliationAssertionId: affiliation.assertionId,
      affiliationSnapshotId: affiliation.snapshotId,
    };
  }
  async feature(
    accountId: string,
    action: 'publish' | 'accept',
    tx: PoolClient,
  ) {
    await this.safety.requireFeature(accountId, action, tx);
  }
  async recheck(token: string, tx: PoolClient) {
    await this.identity.session(token, tx);
  }
}
