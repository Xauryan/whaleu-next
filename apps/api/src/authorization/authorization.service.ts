import { AccountPolicy } from '../safety/account-policy/decorator.js';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import { ApplicationError } from '../http/application-error.js';
import { IdentityService } from '../identity/identity.service.js';
import { AuthorizationRepository } from './authorization.repository.js';
import { capabilitiesFromGrants, canManageRegion } from './contracts.js';
import type { ActiveGrant, AuthorizationCapabilities } from './contracts.js';
import { requireUnprotectedErrandTarget } from './errand-target-protection.js';

@Injectable()
export class AuthorizationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(AuthorizationRepository)
    private readonly repository: AuthorizationRepository,
  ) {}

  @AccountPolicy('private_self_service', 'entry')
  capabilities(token: string): Promise<AuthorizationCapabilities> {
    return this.database.transaction(async (transaction) => {
      const actor = await this.identity.session(token, transaction);
      return capabilitiesFromGrants(
        await this.repository.activeGrants(actor.accountId, transaction),
      );
    });
  }

  grants(accountId: string, transaction: PoolClient): Promise<ActiveGrant[]> {
    return this.repository.activeGrants(accountId, transaction);
  }

  /** Candidate discovery only. Callers must independently retain current
   * grants() evidence before using any account as a feedback recipient. */
  async feedbackRecipientAccountIds(
    transaction: PoolClient,
  ): Promise<string[]> {
    try {
      const result = await transaction.query<{ account_id: string }>(
        `SELECT DISTINCT account_id FROM whaleu_authorization.role_grants
         WHERE role='super_admin' AND operating_region_id IS NULL
           AND revoked_at IS NULL AND valid_from<=clock_timestamp()
           AND (expires_at IS NULL OR expires_at>clock_timestamp())
         ORDER BY account_id LIMIT 1025`,
      );
      // Match the bounded local-notification recipient budget. The sentinel
      // fails the whole publication rather than silently dropping recipients.
      if (result.rows.length > 1024)
        throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
      return result.rows.map((row) => row.account_id);
    } catch {
      throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
    }
  }

  private selectedGlobal(
    grants: readonly ActiveGrant[],
  ): ActiveGrant | undefined {
    return grants
      .filter(
        (grant) =>
          grant.operatingRegionId === null &&
          (grant.role === 'developer' || grant.role === 'super_admin'),
      )
      .sort((a, b) =>
        a.role !== b.role
          ? a.role === 'developer'
            ? -1
            : 1
          : a.id.localeCompare(b.id),
      )[0];
  }
  private retainSelected(grant: ActiveGrant, tx: PoolClient): ActiveGrant {
    registerTransactionDeadline(
      tx,
      grant.validUntil,
      'AUTHORIZATION_UNAVAILABLE',
    );
    return grant;
  }
  /** Positive, locked authority only. No absence/protected-target inference. */
  async requireErrandManagement(
    accountId: string,
    regionId: string | undefined,
    tx: PoolClient,
  ) {
    const grants = await this.grants(accountId, tx);
    const global = this.selectedGlobal(grants);
    if (global) {
      if (!regionId)
        throw new BadRequestException('An explicit target region is required');
      return {
        grant: this.retainSelected(global, tx),
        regionId,
        management: 'global' as const,
      };
    }
    const schools = grants.filter(
      (grant) =>
        grant.role === 'school_admin' && grant.operatingRegionId !== null,
    );
    if (!schools.length) throw new ApplicationError('AUTHORIZATION_REQUIRED');
    const scopes = [
      ...new Set(schools.map((grant) => grant.operatingRegionId!)),
    ];
    if (schools.length !== 1 || scopes.length !== 1)
      throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
    const target = regionId ?? scopes[0]!;
    const grant = schools
      .filter((candidate) => candidate.operatingRegionId === target)
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    if (!grant) throw new ApplicationError('AUTHORIZATION_REQUIRED');
    return {
      grant: this.retainSelected(grant, tx),
      regionId: target,
      management: 'fixed' as const,
    };
  }

  /** Fresh, locked global authority only; cosmetic titles and regional scope do not qualify.
   * The caller authenticates the active session in this same transaction first. */
  async requireGlobalTitleMaintenance(
    accountId: string,
    transaction: PoolClient,
  ): Promise<ActiveGrant> {
    const grant = this.selectedGlobal(
      await this.grants(accountId, transaction),
    );
    if (!grant) throw new ApplicationError('AUTHORIZATION_REQUIRED');
    return this.retainSelected(grant, transaction);
  }

  /** Standalone errand restriction management has no school-scoped variant. */
  async requireGlobalErrandManagement(
    accountId: string,
    tx: PoolClient,
  ): Promise<ActiveGrant> {
    const grant = this.selectedGlobal(await this.grants(accountId, tx));
    if (!grant) throw new ApplicationError('AUTHORIZATION_REQUIRED');
    return this.retainSelected(grant, tx);
  }

  requireUnprotectedErrandTarget(
    subjectId: string,
    tx: PoolClient,
  ): Promise<void> {
    return requireUnprotectedErrandTarget(subjectId, tx);
  }

  async requireRegionManagement(
    accountId: string,
    operatingRegionId: string | null,
    transaction: PoolClient,
  ): Promise<void> {
    if (
      !canManageRegion(
        await this.grants(accountId, transaction),
        operatingRegionId,
      )
    )
      throw new ApplicationError('AUTHORIZATION_REQUIRED');
  }
}
