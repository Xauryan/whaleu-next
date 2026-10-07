import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { registerTransactionDeadline } from '../database/transaction-deadlines.js';
import type { ReportScope } from '../community/report-target.facade.js';
import type { ActiveGrant } from './contracts.js';
import { AuthorizationService } from './authorization.service.js';
export interface ReportWeight {
  weight: 1 | 5;
  grantId: string | null;
  scopeEvidence: string | null;
}
@Injectable()
export class AuthorizationReportWeightSource {
  constructor(
    @Inject(AuthorizationService)
    private readonly authorization: AuthorizationService,
  ) {}
  grants(actor: string, tx: PoolClient) {
    return this.authorization.grants(actor, tx);
  }
  resolve(
    grants: readonly ActiveGrant[],
    scope: ReportScope,
    tx: PoolClient,
  ): ReportWeight {
    const global =
      grants.find((g) => g.role === 'developer') ??
      grants.find((g) => g.role === 'super_admin');
    const selected =
      global ??
      grants.find(
        (g) =>
          g.role === 'school_admin' &&
          scope.kind === 'regional' &&
          g.operatingRegionId === scope.operatingRegionId,
      );
    if (selected) {
      registerTransactionDeadline(
        tx,
        selected.validUntil,
        'AUTHORIZATION_UNAVAILABLE',
      );
      return {
        weight: 5,
        grantId: selected.id,
        scopeEvidence: global
          ? 'global_management'
          : `regional:${scope.operatingRegionId}`,
      };
    }
    if (grants.some((g) => g.role === 'school_admin'))
      throw new ApplicationError('REPORT_SCOPE_UNAVAILABLE');
    return { weight: 1, grantId: null, scopeEvidence: null };
  }
}
