import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { CampusCommunityPolicyService } from './community-policy/campus-community-policy.service.js';
import { ApplicationError } from '../http/application-error.js';
/** Current labels/relation for immutable source/target IDs. Never current author
 * campus selection. Caller holds common policy gate throughout transaction. */
@Injectable()
export class CampusErrandScopeFacade {
  constructor(
    @Inject(CampusCommunityPolicyService)
    private readonly policy: CampusCommunityPolicyService,
  ) {}
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
