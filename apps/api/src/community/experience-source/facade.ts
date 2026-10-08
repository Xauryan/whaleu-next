import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { ExperienceSourceUnit } from './contracts.js';

/** Experience consumes enrolled immutable facts, never current content policy,
 * named identity, like membership, or Updates eligibility. */
@Injectable()
export class CommunityExperienceSourceFacade {
  async loadUnit(
    unitId: string,
    tx: PoolClient,
  ): Promise<ExperienceSourceUnit | null> {
    const result = await tx.query<ExperienceSourceUnit>(
      `SELECT u.id AS "unitId",u.group_id AS "groupId",u.beneficiary_id AS "beneficiaryId",u.action,
       g.occurred_at::text AS "occurredAt",CASE WHEN u.saved_obligation_id IS NULL THEN 'community_outbox' ELSE 'saved_obligation' END AS "sourceKind",
       coalesce(u.saved_obligation_id,u.outbox_event_id) AS "sourceId"
       FROM whaleu_community.reward_source_units u JOIN whaleu_community.reward_source_groups g ON g.id=u.group_id
       WHERE u.id=$1 AND g.source_version=1`,
      [unitId],
    );
    // This exact SQL coordinate is internal input to settlement, not a public DTO.
    // Do not round-trip through Date and silently truncate source microseconds.
    return result.rows[0] ?? null;
  }

  async acknowledge(
    unitId: string,
    settlementId: string,
    tx: PoolClient,
  ): Promise<void> {
    const row = (
      await tx.query<{ saved_obligation_id: string | null }>(
        `SELECT u.saved_obligation_id FROM whaleu_community.reward_source_units u
         JOIN whaleu_experience.work w ON w.unit_id=u.id
         JOIN whaleu_experience.settlements s ON s.unit_id=w.unit_id
         WHERE u.id=$1 AND s.id=$2 AND s.owner_id=u.beneficiary_id AND s.action=u.action`,
        [unitId, settlementId],
      )
    ).rows[0];
    if (!row) throw new Error('Reward source settlement does not match');
    if (row.saved_obligation_id)
      await tx.query(
        "UPDATE whaleu_community.saved_obligations SET status='completed' WHERE id=$1 AND status<>'completed'",
        [row.saved_obligation_id],
      );
  }
}
