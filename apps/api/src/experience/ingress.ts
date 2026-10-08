import { Injectable, Module } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { ExperienceAction } from './catalog.js';
export interface ExperienceEnqueueUnit {
  unitId: string;
  groupId: string;
  beneficiaryId: string;
  action: ExperienceAction;
  enrollmentOrder: string;
}
export async function lockExperienceEnrollment(tx: PoolClient) {
  await tx.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('experience-enrollment',0))",
  );
}
export async function lockExperienceOwner(
  tx: PoolClient,
  owner: string,
  create = false,
  shared = false,
) {
  if (create)
    await tx.query(
      'INSERT INTO whaleu_experience.owners(owner_id) VALUES($1) ON CONFLICT DO NOTHING',
      [owner],
    );
  await tx.query(
    `SELECT owner_id FROM whaleu_experience.owners WHERE owner_id=$1 FOR ${shared ? 'SHARE' : 'UPDATE'}`,
    [owner],
  );
}
/** DB-only ingress. Enrollment never infers a balance or grants a reward. */
@Injectable()
export class ExperienceIngressService {
  async reserve(
    tx: PoolClient,
    beneficiaryIds: readonly string[],
  ): Promise<{ enrollmentOrder: string }> {
    await lockExperienceEnrollment(tx);
    for (const owner of [...new Set(beneficiaryIds)].sort())
      await lockExperienceOwner(tx, owner, true);
    const row = (
      await tx.query<{ enrollment_order: string }>(
        'INSERT INTO whaleu_experience.enrollments DEFAULT VALUES RETURNING enrollment_order::text',
      )
    ).rows[0]!;
    return { enrollmentOrder: row.enrollment_order };
  }
  async enqueue(
    tx: PoolClient,
    units: readonly ExperienceEnqueueUnit[],
  ): Promise<void> {
    for (const unit of units) {
      await tx.query(
        'INSERT INTO whaleu_experience.work(unit_id,group_id,beneficiary_id,action,enrollment_order) VALUES($1,$2,$3,$4,$5)',
        [
          unit.unitId,
          unit.groupId,
          unit.beneficiaryId,
          unit.action,
          unit.enrollmentOrder,
        ],
      );
    }
  }
}
@Module({
  providers: [ExperienceIngressService],
  exports: [ExperienceIngressService],
})
export class ExperienceIngressModule {}
export type { ExperienceAction } from './catalog.js';
