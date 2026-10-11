import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { OrganizationAccess, organizationAuthorityVersion } from './access.js';
import { requireOrganizationCurrent } from './current-proof.js';
/** Stable typed native target for future Activities integration. Accepted legacy
 * directory IDs are deliberately not accepted as native organization authority. */
export interface OrganizationTarget {
  readonly source: 'managed';
  readonly organizationId: string;
}
@Injectable()
export class OrganizationAuthorityFacade {
  constructor(
    @Inject(OrganizationAccess) private readonly access: OrganizationAccess,
  ) {}
  async requireManager(
    accountId: string,
    target: OrganizationTarget,
    tx: PoolClient,
  ) {
    if (target.source !== 'managed')
      throw new ApplicationError('AUTHORIZATION_REQUIRED');
    const row = await this.access.row(target.organizationId, tx),
      authority = await this.access.authority(accountId, row, tx);
    if (row.state !== 'approved')
      throw new ApplicationError('AUTHORIZATION_REQUIRED');
    await requireOrganizationCurrent(row.id, tx);
    return Object.freeze({
      target: Object.freeze({ ...target }),
      regionId: row.region_id,
      revision: Number(row.revision),
      authorityVersion: organizationAuthorityVersion(row, authority),
      role: authority.role,
      grantId: authority.grantId,
    });
  }
}
