import { Inject, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { CommunityExperienceSourceFacade } from '../community/experience-source/facade.js';
import { RatingExperienceSourceFacade } from '../ratings/experience-source/facade.js';
import type {
  ExperienceSourceDomain,
  ExperienceSourceUnit,
  RoutedExperienceSourceUnit,
} from './source-contracts.js';

interface SourceReference {
  unitId: string;
  groupId: string;
  beneficiaryId: string;
  action: ExperienceSourceUnit['action'];
  enrollmentOrder: string;
  sourceDomain: ExperienceSourceDomain;
}

@Injectable()
export class ExperienceSourceRouter {
  constructor(
    @Inject(CommunityExperienceSourceFacade)
    private readonly community: CommunityExperienceSourceFacade,
    @Inject(RatingExperienceSourceFacade)
    private readonly ratings: RatingExperienceSourceFacade,
  ) {}

  /** Call before taking the beneficiary owner guard. No UUID probing or
   * fallback to another domain is allowed when a registered source is absent. */
  async loadUnit(
    unitId: string,
    tx: PoolClient,
  ): Promise<RoutedExperienceSourceUnit | null> {
    const reference = (
      await tx.query<SourceReference>(
        `SELECT u.unit_id AS "unitId",u.group_id AS "groupId",
         u.beneficiary_id AS "beneficiaryId",u.action,
         u.enrollment_order::text AS "enrollmentOrder",u.source_domain AS "sourceDomain"
         FROM whaleu_experience.source_units u
         JOIN whaleu_experience.source_groups g
          ON (g.group_id,g.source_domain,g.enrollment_order)=(u.group_id,u.source_domain,u.enrollment_order)
         WHERE u.unit_id=$1 AND g.source_version=1
          AND ((u.source_domain='community' AND u.community_unit_id=u.unit_id AND u.rating_unit_id IS NULL
                AND g.community_group_id=g.group_id AND g.rating_group_id IS NULL)
            OR (u.source_domain='ratings' AND u.rating_unit_id=u.unit_id AND u.community_unit_id IS NULL
                AND g.rating_group_id=g.group_id AND g.community_group_id IS NULL))`,
        [unitId],
      )
    ).rows[0];
    if (!reference || reference.unitId !== unitId) return null;
    let unit: ExperienceSourceUnit | null;
    switch (reference.sourceDomain) {
      case 'community':
        unit = await this.community.loadUnit(unitId, tx);
        if (
          unit &&
          unit.sourceKind !== 'community_outbox' &&
          unit.sourceKind !== 'saved_obligation'
        )
          return null;
        break;
      case 'ratings':
        unit = await this.ratings.loadUnit(unitId, tx);
        if (unit?.sourceKind !== 'rating_event') return null;
        break;
      default:
        return null;
    }
    if (
      !unit ||
      unit.unitId !== reference.unitId ||
      unit.groupId !== reference.groupId ||
      unit.beneficiaryId !== reference.beneficiaryId ||
      unit.action !== reference.action
    )
      return null;
    return {
      ...unit,
      sourceDomain: reference.sourceDomain,
      enrollmentOrder: reference.enrollmentOrder,
    };
  }

  /** Route by the immutable reference loaded before the owner guard, rather
   * than reacquiring a domain or enrollment lock after settlement. */
  async acknowledge(
    unit: RoutedExperienceSourceUnit,
    settlementId: string,
    tx: PoolClient,
  ): Promise<void> {
    switch (unit.sourceDomain) {
      case 'community':
        if (
          unit.sourceKind !== 'community_outbox' &&
          unit.sourceKind !== 'saved_obligation'
        )
          throw new Error('Reward source domain does not match');
        return this.community.acknowledge(unit.unitId, settlementId, tx);
      case 'ratings':
        if (unit.sourceKind !== 'rating_event')
          throw new Error('Reward source domain does not match');
        return this.ratings.acknowledge(unit.unitId, settlementId, tx);
      default:
        throw new Error('Reward source domain is unavailable');
    }
  }
}
