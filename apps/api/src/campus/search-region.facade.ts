import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ApplicationError } from '../http/application-error.js';

export const SEARCH_REGION_BATCH_LIMIT = 256;
const regionSchema = z.strictObject({ id: z.uuid(), isActive: z.boolean() });

/** Search-specific owner read. Caller must hold the shared common policy gate
 * first and retain it through commit. No count epochs, affiliation, physical
 * campus assignment, identity selection or topology are required for reading. */
@Injectable()
export class CampusSearchRegionFacade {
  async readSearchRegionActivity(
    ids: readonly string[],
    tx: PoolClient,
  ): Promise<ReadonlyMap<string, boolean>> {
    const distinct = [...new Set(ids)].sort();
    if (
      distinct.length > SEARCH_REGION_BATCH_LIMIT ||
      distinct.some(
        (id) => !z.uuid().safeParse(id).success || id !== id.toLowerCase(),
      )
    )
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    if (!distinct.length) return new Map();
    try {
      await tx.query(
        'SELECT id FROM whaleu_campus.operating_regions WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
        [distinct],
      );
      // Reread after any lock wait. Missing is unknown, never known inactive.
      const result = await tx.query<{ id: string; isActive: boolean }>(
        'SELECT id,is_active AS "isActive" FROM whaleu_campus.operating_regions WHERE id=ANY($1::uuid[]) ORDER BY id',
        [distinct],
      );
      if (result.rows.length !== distinct.length)
        throw new ApplicationError('COMMUNITY_UNAVAILABLE');
      const activity = new Map<string, boolean>();
      for (const [index, raw] of result.rows.entries()) {
        const parsed = regionSchema.safeParse(raw);
        if (!parsed.success || parsed.data.id !== distinct[index])
          throw new ApplicationError('COMMUNITY_UNAVAILABLE');
        activity.set(parsed.data.id, parsed.data.isActive);
      }
      return activity;
    } catch {
      throw new ApplicationError('COMMUNITY_UNAVAILABLE');
    }
  }
}
