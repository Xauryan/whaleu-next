import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuthorizationService } from './authorization.service.js';
import { ApplicationError } from '../http/application-error.js';
import { registerTransactionExactDeadline } from '../database/transaction-deadlines.js';
/** Pin authority deliberately does not use community canManage: that permission
 * also permits some school moderation of global posts. Pins never do. */
@Injectable()
export class PostPinAuthorityFacade {
  constructor(
    @Inject(AuthorizationService)
    private readonly authority: AuthorizationService,
  ) {}
  async require(
    actor: string,
    regionId: string | null,
    tx: PoolClient,
  ): Promise<string> {
    const grants = await this.authority.grants(actor, tx);
    const grant =
      grants.find(
        (g) =>
          (g.role === 'developer' || g.role === 'super_admin') &&
          g.operatingRegionId === null,
      ) ??
      grants.find(
        (g) =>
          regionId !== null &&
          g.role === 'school_admin' &&
          g.operatingRegionId === regionId,
      );
    if (!grant) throw new ApplicationError('AUTHORIZATION_REQUIRED');
    const row = (
      await tx.query<{ until: string | null; current: boolean }>(
        `SELECT expires_at::text AS until,(valid_from<=clock_timestamp() AND (expires_at IS NULL OR expires_at>clock_timestamp()) AND revoked_at IS NULL) AS current FROM whaleu_authorization.role_grants WHERE id=$1 FOR SHARE`,
        [grant.id],
      )
    ).rows[0];
    if (!row?.current) throw new ApplicationError('AUTHORIZATION_REQUIRED');
    registerTransactionExactDeadline(tx, row.until, 'AUTHORIZATION_REQUIRED');
    return grant.id;
  }
}
