import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { IdentityService } from '../identity/identity.service.js';
import { RatingVerificationFacade } from '../verification/rating-eligibility.facade.js';
import { RatingAuthorizationFacade } from '../authorization/rating-grants.facade.js';
import { CampusRatingScopeFacade } from '../campus/rating-scope.facade.js';
import { RatingSafetyFacade } from '../safety/rating.facade.js';
import { lockSafetyPolicy } from '../safety/locks.js';
import { ownerFingerprint } from '../database/required-owner-proof.js';
import { ApplicationError } from '../http/application-error.js';
/** Application composition only. No other owner's SQL belongs here. */
@Injectable()
export class RatingsAccessService {
  constructor(
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(RatingVerificationFacade)
    private readonly verification: RatingVerificationFacade,
    @Inject(RatingAuthorizationFacade)
    private readonly authorization: RatingAuthorizationFacade,
    @Inject(CampusRatingScopeFacade)
    private readonly campus: CampusRatingScopeFacade,
    @Inject(RatingSafetyFacade) private readonly safety: RatingSafetyFacade,
  ) {}
  async authenticate(token: string, tx: PoolClient) {
    await lockSafetyPolicy(tx);
    return this.identity.session(token, tx);
  }
  /** Cleanup retains global eligibility without asserting content visibility,
   * school affiliation, anonymous privileges or bilateral relationships. */
  async requireDeletionActor(accountId: string, tx: PoolClient) {
    await lockSafetyPolicy(tx);
    if (!(await this.identity.activeAccount(accountId, tx)))
      throw new ApplicationError('RATING_NOT_FOUND');
    const phone = await this.verification.phone(accountId, tx);
    if (phone.status === 'unverified')
      throw new ApplicationError('PHONE_VERIFICATION_REQUIRED');
    if (phone.status !== 'verified')
      throw new ApplicationError('VERIFICATION_UNAVAILABLE');
    await this.safety.requireDeletionAllowed(accountId, tx);
    return {
      fingerprint: ownerFingerprint([
        accountId,
        phone.fingerprint,
        await this.safety.navigation(tx),
      ]),
    };
  }
  async resolve(
    token: string,
    regionId: string | null,
    tx: PoolClient,
    options: { phone: boolean },
  ) {
    const session = await this.authenticate(token, tx);
    return {
      session,
      ...(await this.resolveAccount(session.accountId, regionId, tx, options)),
    };
  }
  async resolveAccount(
    accountId: string,
    regionId: string | null,
    tx: PoolClient,
    options: { phone: boolean },
  ) {
    await lockSafetyPolicy(tx);
    if (!(await this.identity.activeAccount(accountId, tx)))
      throw new ApplicationError('RATING_NOT_FOUND');
    if (options.phone) {
      const phone = await this.verification.phone(accountId, tx);
      if (phone.status === 'unverified')
        throw new ApplicationError('PHONE_VERIFICATION_REQUIRED');
      if (phone.status !== 'verified')
        throw new ApplicationError('VERIFICATION_UNAVAILABLE');
    }
    await this.safety.requireAllowed(accountId, tx);
    const safety = await this.safety.navigation(tx);
    if (regionId === null)
      return {
        regionId,
        fingerprint: ownerFingerprint(['global', safety]),
      };
    const grant = await this.authorization.scope(accountId, tx);
    if (grant.kind === 'fixed' && grant.regionId !== regionId)
      throw new ApplicationError('RATING_SCOPE_UNAVAILABLE');
    if (grant.kind !== 'ordinary')
      return {
        regionId,
        fingerprint: ownerFingerprint([
          grant.fingerprint,
          await this.campus.requireManaged(regionId, tx),
          safety,
        ]),
      };
    const affiliation = await this.verification.affiliation(accountId, tx);
    if (affiliation.status === 'unverified')
      throw new ApplicationError('AFFILIATION_VERIFICATION_REQUIRED');
    if (affiliation.status !== 'verified')
      throw new ApplicationError('VERIFICATION_UNAVAILABLE');
    const scope = await this.campus.ordinary(
      accountId,
      affiliation,
      regionId,
      tx,
    );
    return {
      regionId,
      fingerprint: ownerFingerprint([
        grant.fingerprint,
        affiliation.fingerprint,
        scope.fingerprint,
        safety,
      ]),
    };
  }
  /** Creator editing always uses ordinary publication scope. A creator's role
   * grants cannot substitute for current affiliation or ordinary campus proof.
   * This is intentionally NOT used by hidden owner deletion or historical recovery. */
  async resolveOwnerEditAccount(
    accountId: string,
    regionId: string | null,
    tx: PoolClient,
  ) {
    await lockSafetyPolicy(tx);
    if (!(await this.identity.activeAccount(accountId, tx)))
      throw new ApplicationError('RATING_NOT_FOUND');
    const phone = await this.verification.phone(accountId, tx);
    if (phone.status === 'unverified')
      throw new ApplicationError('PHONE_VERIFICATION_REQUIRED');
    if (phone.status !== 'verified')
      throw new ApplicationError('VERIFICATION_UNAVAILABLE');
    await this.safety.requireEditAllowed(accountId, tx);
    const safety = await this.safety.navigation(tx);
    if (regionId === null)
      return {
        regionId,
        fingerprint: ownerFingerprint([
          'owner-edit-global',
          phone.fingerprint,
          safety,
        ]),
      };
    const affiliation = await this.verification.affiliation(accountId, tx);
    if (affiliation.status === 'unverified')
      throw new ApplicationError('AFFILIATION_VERIFICATION_REQUIRED');
    if (affiliation.status !== 'verified')
      throw new ApplicationError('VERIFICATION_UNAVAILABLE');
    const scope = await this.campus.ordinary(
      accountId,
      affiliation,
      regionId,
      tx,
    );
    return {
      regionId,
      fingerprint: ownerFingerprint([
        'owner-edit-ordinary',
        phone.fingerprint,
        affiliation.fingerprint,
        scope.fingerprint,
        safety,
      ]),
    };
  }
  /** Category administration has its own explicit grant check. This does not
   * alter creator-only editing or hidden owner cleanup eligibility. */
  async resolveCategoryManager(
    accountId: string,
    regionId: string | null,
    tx: PoolClient,
  ) {
    const eligibility = await this.requireDeletionActor(accountId, tx);
    const scope = await this.authorization.scope(accountId, tx);
    if (
      scope.kind === 'ordinary' ||
      (scope.kind === 'fixed' && scope.regionId !== regionId)
    )
      throw new ApplicationError('RATING_NOT_FOUND');
    return {
      fingerprint: ownerFingerprint([
        'category-manager:v1',
        eligibility.fingerprint,
        scope.fingerprint,
      ]),
      grant: scope,
    };
  }
  async context(token: string, tx: PoolClient) {
    const session = await this.authenticate(token, tx);
    await this.safety.requireAllowed(session.accountId, tx);
    const grant = await this.authorization.scope(session.accountId, tx);
    if (grant.kind !== 'ordinary') {
      const { homeRegion, regions } = await this.campus.managed(
        grant.kind === 'fixed' ? grant.regionId : null,
        tx,
      );
      return { homeRegion, regions };
    }
    const affiliation = await this.verification.affiliation(
      session.accountId,
      tx,
    );
    if (affiliation.status !== 'verified') {
      if (affiliation.status === 'unavailable')
        throw new ApplicationError('VERIFICATION_UNAVAILABLE');
      return { homeRegion: null, regions: [] };
    }
    const { homeRegion, regions } = await this.campus.ordinary(
      session.accountId,
      affiliation,
      null,
      tx,
    );
    return { homeRegion, regions };
  }
  private async anonymous(accountId: string, tx: PoolClient) {
    const affiliation = await this.verification.affiliation(accountId, tx);
    if (affiliation.status === 'verified') return 'verified' as const;
    const grant = await this.authorization.scope(accountId, tx);
    if (grant.kind !== 'ordinary') {
      if (grant.kind === 'fixed')
        await this.campus.requireManaged(grant.regionId, tx);
      return 'verified' as const;
    }
    const temporary = await this.verification.temporary(accountId, tx);
    return temporary.status === 'verified'
      ? ('verified' as const)
      : affiliation.status === 'unavailable' ||
          temporary.status === 'unavailable'
        ? ('unavailable' as const)
        : ('unverified' as const);
  }
  async authorModes(
    accountId: string,
    tx: PoolClient,
  ): Promise<('named' | 'anonymous')[]> {
    return (await this.anonymous(accountId, tx)) === 'verified'
      ? ['named', 'anonymous']
      : ['named'];
  }
  async requireAnonymous(accountId: string, tx: PoolClient) {
    const status = await this.anonymous(accountId, tx);
    if (status !== 'verified')
      throw new ApplicationError(
        status === 'unavailable'
          ? 'VERIFICATION_UNAVAILABLE'
          : 'AFFILIATION_VERIFICATION_REQUIRED',
      );
  }
  async recheck(token: string, tx: PoolClient) {
    await this.identity.session(token, tx);
  }
}
