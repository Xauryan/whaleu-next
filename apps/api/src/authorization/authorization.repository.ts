import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { CampusService } from '../campus/campus.service.js';
import { ApplicationError } from '../http/application-error.js';
import type { ActiveGrant } from './contracts.js';

interface TimedGrant extends ActiveGrant {
  readonly validFrom: Date;
  readonly expiresAt: Date | null;
}
@Injectable()
export class AuthorizationRepository {
  constructor(
    @Inject(CampusService) private readonly campuses: CampusService,
  ) {}
  async activeGrants(
    accountId: string,
    transaction: PoolClient,
  ): Promise<ActiveGrant[]> {
    try {
      // Lock grants before evaluation: revocation/scope changes cannot race this transaction.
      const grants = await transaction.query<TimedGrant>(
        `SELECT id, role, operating_region_id AS "operatingRegionId", valid_from AS "validFrom", expires_at AS "expiresAt"
         FROM whaleu_authorization.role_grants
         WHERE account_id=$1 AND revoked_at IS NULL
           AND valid_from <= clock_timestamp() AND (expires_at IS NULL OR expires_at > clock_timestamp())
         ORDER BY id FOR SHARE`,
        [accountId],
      );
      const scoped: TimedGrant[] = [];
      for (const grant of grants.rows) {
        if (
          (grant.role === 'developer' || grant.role === 'super_admin') &&
          grant.operatingRegionId === null
        ) {
          scoped.push(grant);
        } else if (
          grant.role === 'school_admin' &&
          grant.operatingRegionId !== null
        ) {
          try {
            await this.campuses.requireActiveRegion(
              grant.operatingRegionId,
              transaction,
            );
            scoped.push(grant);
          } catch (error) {
            if (!(
              error instanceof ApplicationError &&
              error.code === 'COMMUNITY_SCOPE_UNAVAILABLE'
            ))
              throw error;
          }
        } else {
          throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
        }
      }
      // SQL WHERE predicates may be evaluated before a FOR SHARE lock wait. Read time
      // again after ALL grant/scope locks, so contention cannot revive expired authority.
      const now = (
        await transaction.query<{ now: Date }>(
          'SELECT clock_timestamp() AS now',
        )
      ).rows[0]!.now;
      return scoped
        .filter(
          (grant) =>
            grant.validFrom <= now &&
            (grant.expiresAt === null || grant.expiresAt > now),
        )
        .map(({ id, role, operatingRegionId }) => ({
          id,
          role,
          operatingRegionId,
        }));
    } catch {
      throw new ApplicationError('AUTHORIZATION_UNAVAILABLE');
    }
  }
}
