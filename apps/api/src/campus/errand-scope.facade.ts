import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { CampusCommunityPolicyService } from './community-policy/campus-community-policy.service.js';
import { ApplicationError } from '../http/application-error.js';
export const ERRAND_ADMIN_REGION_BATCH_LIMIT = 202;
const historicalIdSchema = z.uuid().refine((id) => id === id.toLowerCase());
const historicalRegionSchema = z.strictObject({
  id: historicalIdSchema,
  label: z.string().refine(
    (label) =>
      label.trim().length > 0 &&
      [...label].length <= 200 &&
      [...label].every((character) => {
        const code = character.codePointAt(0)!;
        return (
          code >= 32 &&
          !(code >= 127 && code <= 159) &&
          !(code >= 0xd800 && code <= 0xdfff)
        );
      }),
  ),
  active: z.boolean(),
});
export type HistoricalErrandRegion =
  | { id: string; status: 'available'; label: string; active: boolean }
  | { id: string; status: 'unavailable' };
/** Current labels/relation for immutable source/target IDs. Never current author
 * campus selection. Caller holds common policy gate throughout transaction. */
@Injectable()
export class CampusErrandScopeFacade {
  constructor(
    @Inject(CampusCommunityPolicyService)
    private readonly policy: CampusCommunityPolicyService,
  ) {}
  /** Independent immutable source/target IDs retain their historical presence.
   * Inactive labels are still useful metadata; absence is explicit and grants
   * no authority. The administrative caller supplies its own final read proof. */
  async historicalBatch(
    ids: readonly string[],
    tx: PoolClient,
  ): Promise<ReadonlyMap<string, HistoricalErrandRegion>> {
    const distinct = [...new Set(ids)].sort();
    if (
      distinct.length > ERRAND_ADMIN_REGION_BATCH_LIMIT ||
      distinct.some((id) => !historicalIdSchema.safeParse(id).success)
    )
      throw new ApplicationError('ERRAND_UNAVAILABLE');
    const regions = new Map<string, HistoricalErrandRegion>(
      distinct.map((id) => [id, { id, status: 'unavailable' }]),
    );
    if (!distinct.length) return regions;
    try {
      const result = await tx.query<z.infer<typeof historicalRegionSchema>>(
        `SELECT id,name AS label,is_active AS active
         FROM whaleu_campus.operating_regions WHERE id=ANY($1::uuid[]) ORDER BY id`,
        [distinct],
      );
      for (const raw of result.rows) {
        const parsed = historicalRegionSchema.safeParse(raw);
        if (
          !parsed.success ||
          regions.get(parsed.data.id)?.status !== 'unavailable'
        )
          throw new ApplicationError('ERRAND_UNAVAILABLE');
        regions.set(parsed.data.id, { ...parsed.data, status: 'available' });
      }
      return regions;
    } catch {
      throw new ApplicationError('ERRAND_UNAVAILABLE');
    }
  }

  /** Final-only owner fence. Never replace this with a blocking table lock. */
  async fenceAdminLabels(tx: PoolClient): Promise<void> {
    await tx.query(
      'LOCK TABLE whaleu_campus.operating_regions IN SHARE MODE NOWAIT',
    );
  }

  async project(
    sourceRegionId: string,
    targetRegionId: string,
    tx: PoolClient,
  ) {
    const relation = await this.policy.sameGroup(
      sourceRegionId,
      targetRegionId,
      tx,
    );
    if (relation.status !== 'known')
      throw new ApplicationError('IDENTITY_CAMPUS_UNAVAILABLE');
    const rows = (
      await tx.query<{ id: string; name: string; is_active: boolean }>(
        'SELECT id,name,is_active FROM whaleu_campus.operating_regions WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',
        [[...new Set([sourceRegionId, targetRegionId])].sort()],
      )
    ).rows;
    const source = rows.find((r) => r.id === sourceRegionId),
      target = rows.find((r) => r.id === targetRegionId);
    if (
      !source?.is_active ||
      !target?.is_active ||
      !source.name?.trim() ||
      !target.name?.trim()
    )
      throw new ApplicationError('IDENTITY_CAMPUS_UNAVAILABLE');
    return {
      sourceRegion: { id: source.id, label: source.name },
      targetRegion: { id: target.id, label: target.name },
      scope:
        sourceRegionId === targetRegionId
          ? ('home' as const)
          : relation.sameGroup
            ? ('related' as const)
            : ('foreign' as const),
    };
  }
}
