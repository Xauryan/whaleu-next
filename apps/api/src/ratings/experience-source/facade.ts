import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { ExperienceSourceUnit } from '../../experience/source-contracts.js';

/** Settles the captured private beneficiary, even if content is subsequently
 * deleted or authority, Safety, Profile, or visible identity changes. */
@Injectable()
export class RatingExperienceSourceFacade {
  async loadUnit(
    unitId: string,
    tx: PoolClient,
  ): Promise<ExperienceSourceUnit | null> {
    const result = await tx.query<ExperienceSourceUnit>(
      `SELECT u.id AS "unitId",u.group_id AS "groupId",u.beneficiary_id AS "beneficiaryId",u.action,
       g.occurred_at::text AS "occurredAt",'rating_event' AS "sourceKind",u.event_id AS "sourceId"
       FROM whaleu_ratings.reward_units u
       JOIN whaleu_ratings.reward_groups g
        ON (g.id,g.event_id,g.enrollment_order)=(u.group_id,u.event_id,u.enrollment_order)
       WHERE u.id=$1 AND g.source_version=1
        AND g.event_kind IN ('root_created','reply_created')
        AND u.action IN ('comment','received_comment')`,
      [unitId],
    );
    return result.rows[0] ?? null;
  }

  /** Ratings has no mutable saved obligation. Acknowledgement proves the
   * exact captured tuple has a real settlement; work completion is durable
   * in the same transaction and independently guarded by the database. */
  async acknowledge(
    unitId: string,
    settlementId: string,
    tx: PoolClient,
  ): Promise<void> {
    const result = await tx.query<{ unit_id: string }>(
      `SELECT u.id AS unit_id FROM whaleu_ratings.reward_units u
       JOIN whaleu_ratings.reward_groups g
        ON (g.id,g.event_id,g.enrollment_order)=(u.group_id,u.event_id,u.enrollment_order)
       JOIN whaleu_experience.source_groups sg
        ON (sg.group_id,sg.enrollment_order,sg.creation_transaction)=(g.id,g.enrollment_order,g.creation_transaction)
        AND sg.source_domain='ratings' AND sg.rating_group_id=g.id AND sg.community_group_id IS NULL
        AND sg.source_version=g.source_version
       JOIN whaleu_experience.source_units su
        ON (su.unit_id,su.group_id,su.beneficiary_id,su.action,su.enrollment_order)
          =(u.id,u.group_id,u.beneficiary_id,u.action,u.enrollment_order)
        AND su.source_domain=sg.source_domain AND su.rating_unit_id=u.id AND su.community_unit_id IS NULL
       JOIN whaleu_experience.work w
        ON (w.unit_id,w.group_id,w.beneficiary_id,w.action,w.enrollment_order)
          =(u.id,u.group_id,u.beneficiary_id,u.action,u.enrollment_order)
       JOIN whaleu_experience.settlements s
        ON (s.unit_id,s.owner_id,s.action)=(u.id,u.beneficiary_id,u.action)
       WHERE u.id=$1 AND s.id=$2 AND g.source_version=1
        AND g.event_kind IN ('root_created','reply_created')
        AND u.action IN ('comment','received_comment')`,
      [unitId, settlementId],
    );
    if (!result.rows[0])
      throw new Error('Rating reward source settlement does not match');
  }
}
