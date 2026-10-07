import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { DatabaseService } from '../database/database.js';
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
