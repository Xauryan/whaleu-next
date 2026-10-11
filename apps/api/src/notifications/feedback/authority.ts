import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuthorizationService } from '../../authorization/authorization.service.js';
import { registerTransactionDeadline } from '../../database/transaction-deadlines.js';
import { ApplicationError } from '../../http/application-error.js';

@Injectable()
export class FeedbackNoticeAuthority {
  constructor(
    @Inject(AuthorizationService)
    private readonly authorization: AuthorizationService,
  ) {}

  async current(accountId: string, tx: PoolClient) {
    const grant = (await this.authorization.grants(accountId, tx))
      .filter(
        (candidate) =>
          candidate.role === 'super_admin' &&
          candidate.operatingRegionId === null,
      )
      .sort((a, b) => a.id.localeCompare(b.id))[0];
    if (grant)
      registerTransactionDeadline(
        tx,
        grant.validUntil,
        'AUTHORIZATION_UNAVAILABLE',
      );
    return grant ?? null;
  }

  async require(accountId: string, tx: PoolClient): Promise<void> {
    if (!(await this.current(accountId, tx)))
      throw new ApplicationError('AUTHORIZATION_REQUIRED');
  }
}
