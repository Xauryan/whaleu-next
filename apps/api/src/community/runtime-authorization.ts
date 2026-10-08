import { readPhoneContinuation } from './phone-continuation.js';
import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuthorizationService } from '../authorization/authorization.service.js';
import type { ActiveGrant } from '../authorization/contracts.js';
import { CampusCommunityPolicyService } from '../campus/community-policy/campus-community-policy.service.js';
import { RegionalCommunityPolicyService } from '../campus/community-policy/regional-community-policy.service.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import { ApplicationError } from '../http/application-error.js';
import { SafetyRepository } from '../safety/repository.js';
import { LocalSafetyPhoneSource } from '../verification/safety-phone.source.js';
import { LocalPublicationEligibilitySource } from '../verification/publication-eligibility.source.js';
import type {
  Authority,
  AuthorizationContext,
  CommunityAuthorizationPort,
  Decision,
} from './community-policy.js';
import type { CommunitySpace } from './contracts.js';
import { categorySchema } from './contracts.js';
import { ApprovalRepository } from './content-review/approval.repository.js';

/** Compose owner facades only. No profile, browse-campus or student-number reads. */
@Injectable()
export class RuntimeCommunityAuthorization implements CommunityAuthorizationPort {
  constructor(
    @Inject(LocalSafetyPhoneSource)
    private readonly phones: LocalSafetyPhoneSource,
    @Inject(LocalPublicationEligibilitySource)
    private readonly affiliations: LocalPublicationEligibilitySource,
    @Inject(SafetyRepository) private readonly safety: SafetyRepository,
    @Inject(AuthorizationService)
    private readonly authorization: AuthorizationService,
    @Inject(CampusCommunityPolicyService)
    private readonly campuses: CampusCommunityPolicyService,
    @Inject(RegionalCommunityPolicyService)
    private readonly policies: RegionalCommunityPolicyService,
    @Inject(ApprovalRepository) private readonly approvals: ApprovalRepository,
  ) {}
  async resolve(
    accountId: string,
    space: CommunitySpace,
    tx: PoolClient,
    context: AuthorizationContext = {},
  ): Promise<Decision<Authority>> {
    const phone = await readPhoneContinuation(this.phones, accountId, tx);
    if (phone.kind !== 'allow') return phone;
    const value: Authority = {
      runtime: true,
      phoneVerified: phone.value.phoneVerified,
      studentVerified: false,
      affiliationStatus: 'unavailable',
      identityStatus: 'unavailable',
      scopeRelation: 'unavailable',
      configurationStatus: 'unavailable',
      identityRegionId: null,
      crossRegionAllowed: false,
      unverifiedCategories: [],
      unverifiedCommentsAllowed: false,
      restrictedActions: [],
      canManage: false,
      canDisableComments: false,
      managementStatus: 'known',
    };
    if (context.phoneOnly) return { kind: 'allow', value };
    try {
      await this.safety.restriction(accountId, tx);
    } catch (error) {
      if (error instanceof ApplicationError)
        return error.code === 'SAFETY_ACTION_RESTRICTED'
          ? { kind: 'deny', reason: 'COMMUNITY_ACTION_RESTRICTED' }
          : { kind: 'unavailable' };
      throw error;
    }
    // Phone-authorized interaction and feed continuation never load affiliation or identity selection.
    if (!context.publication && !context.targetPostId)
      return { kind: 'allow', value };
    const grants = await this.authorization.grants(accountId, tx);
    const global = grants.find(
      (g) => g.role === 'super_admin' || g.role === 'developer',
    );
    const local = grants.find(
      (g) =>
        g.role === 'school_admin' &&
        g.operatingRegionId === space.operatingRegionId,
    );
    const selected: ActiveGrant[] = [];
    if (global) {
      value.canManage = true;
      value.canDisableComments = true;
      selected.push(global);
    } else if (context.targetPostId) {
      const scope = await this.approvals.scopeForPost(context.targetPostId, tx);
      if (!scope && grants.some((g) => g.role === 'school_admin'))
        value.managementStatus = 'unavailable';
      if (scope) {
        if (scope.originalRegionId) {
          const grant = grants.find(
            (g) =>
              g.role === 'school_admin' &&
              g.operatingRegionId === scope.originalRegionId,
          );
          if (grant) {
            value.canManage = true;
            selected.push(grant);
          }
        } else if (scope.authorOriginRegionId) {
          for (const grant of grants.filter(
            (g) => g.role === 'school_admin' && g.operatingRegionId,
          )) {
            const relation = await this.campuses.sameGroup(
              grant.operatingRegionId!,
              scope.authorOriginRegionId,
              tx,
            );
            if (relation.status === 'unavailable')
              value.managementStatus = 'unavailable';
            if (relation.status === 'known' && relation.sameGroup) {
              value.canManage = true;
              selected.push(grant);
              break;
            }
          }
        }
      }
    } else if (local) {
      value.canManage = true;
      selected.push(local);
    }
    if (!global && local && space.kind === 'regional') {
      value.canDisableComments = true;
      selected.push(local);
    }
    for (const grant of context.managementRequired ? selected : [])
      registerTransactionDeadline(
        tx,
        grant.validUntil,
        'AUTHORIZATION_REQUIRED',
      );
    if (!context.publication) return { kind: 'allow', value };
    const affiliation = await this.affiliations.resolve(accountId, tx);
    value.affiliationStatus = affiliation.status;
    value.studentVerified = affiliation.status === 'verified';
    value.publicationScope = {
      originalSpaceId: space.id,
      originalRegionId: space.operatingRegionId,
      authorOriginRegionId: null,
      identityRegionId: null,
      topologySnapshotId: null,
      sync: 'none',
      identityCampusId: null,
      affiliationAssertionId: null,
    };
    if (affiliation.status === 'verified') {
      registerTransactionDeadline(
        tx,
        affiliation.validUntil,
        'STUDENT_VERIFICATION_REQUIRED',
      );
      const identity = await this.campuses.resolve(
        accountId,
        affiliation,
        space.operatingRegionId,
        tx,
      );
      value.identityStatus = identity.status;
      if (identity.status === 'valid') {
        value.identityRegionId = identity.identityRegionId;
        value.scopeRelation = identity.relation;
        value.publicationScope = {
          ...value.publicationScope,
          authorOriginRegionId: affiliation.originRegionId,
          identityRegionId: identity.identityRegionId,
          topologySnapshotId: identity.topologySnapshotId,
          identityCampusId: identity.campusId,
          affiliationAssertionId: affiliation.assertionId,
          affiliationSnapshotId: affiliation.snapshotId,
          identitySelectionId: identity.selectionId,
        };
      }
    } else if (affiliation.status === 'unverified' && space.operatingRegionId) {
      const policy = await this.policies.resolve(space.operatingRegionId, tx);
      value.configurationStatus = policy.status;
      if (policy.status === 'known') {
        value.publicationScope.configurationRevisionId = policy.revisionId;
        value.unverifiedCategories = policy.unverifiedPostEnabled
          ? policy.unverifiedCategories.flatMap((x) => {
              const parsed = categorySchema.safeParse(x);
              return parsed.success && parsed.data !== 'trading'
                ? [parsed.data]
                : [];
            })
          : [];
        value.unverifiedCommentsAllowed = policy.unverifiedCommentEnabled;
      }
    }
    return { kind: 'allow', value };
  }
}
