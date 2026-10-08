import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import { ApplicationError } from '../http/application-error.js';
import { IdentityService } from '../identity/identity.service.js';
import { AuthorizationRepository } from './authorization.repository.js';
import { capabilitiesFromGrants, canManageRegion } from './contracts.js';
import type { ActiveGrant, AuthorizationCapabilities } from './contracts.js';

@Injectable()
export class AuthorizationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(IdentityService) private readonly identity: IdentityService,
    @Inject(AuthorizationRepository)
    private readonly repository: AuthorizationRepository,
  ) {}

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

  /** Fresh, locked global authority only; cosmetic titles and regional scope do not qualify.
   * The caller authenticates the active session in this same transaction first. */
  async requireGlobalTitleMaintenance(
    accountId: string,
    transaction: PoolClient,
  ): Promise<ActiveGrant> {
    const grant = (await this.grants(accountId, transaction))
      .filter(
        (candidate) =>
          candidate.operatingRegionId === null &&
          (candidate.role === 'developer' || candidate.role === 'super_admin'),
      )
      .sort((left, right) => {
        if (left.role !== right.role) return left.role === 'developer' ? -1 : 1;
        return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
      })[0];
    if (!grant) throw new ApplicationError('AUTHORIZATION_REQUIRED');
    registerTransactionDeadline(
      transaction,
      grant.validUntil,
      'AUTHORIZATION_UNAVAILABLE',
    );
    return grant;
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
