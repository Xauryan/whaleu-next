import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';

export const CONTENT_SCOPE_BATCH_LIMIT = 256;

/** Internal count snapshot only. The caller holds the shared common-policy gate
 * and captures/finally proves the owner epoch vector for the complete count;
 * catalog writers take the common-policy gate exclusively.
 * This is not publication/affiliation authority and never registers deadlines. */
@Injectable()
export class CampusContentScopeFacade {
  async readRegionsBatch(
    ids: readonly string[],
    tx: PoolClient,
  ): Promise<Map<string, boolean>> {
    const distinct = [...new Set(ids)].sort();
    if (distinct.length > CONTENT_SCOPE_BATCH_LIMIT)
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    const facts = new Map(distinct.map((id) => [id, false]));
    if (!distinct.length) return facts;
    const regions = await tx.query<{ id: string; is_active: boolean }>(
      'SELECT id,is_active FROM whaleu_campus.operating_regions WHERE id=ANY($1::uuid[])',
      [distinct],
    );
    for (const region of regions.rows)
      if (facts.has(region.id)) facts.set(region.id, region.is_active === true);
    return facts;
  }
}
