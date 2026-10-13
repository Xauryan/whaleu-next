import { Injectable, Module } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import { lockExperienceOwner } from './ingress.js';
/** Deliberately narrow cosmetic entitlement owner. No balance, level, reward,
 * appearance, provider identity or notification is created by this writer. */
@Injectable()
export class SchoolAdminTitleEntitlementWriter {
  async missing(owner: string, tx: PoolClient): Promise<boolean> {
    const catalog = (
      await tx.query<{ title_key: string }>(
        "SELECT title_key FROM whaleu_experience.title_catalog WHERE title_key='role_admin' AND name='管理员' AND kind='special' AND unlock_level IS NULL FOR SHARE",
      )
    ).rows[0];
    if (!catalog)
      throw new ApplicationError('SCHOOL_ADMIN_MANAGEMENT_UNAVAILABLE');
    return (
      (
        await tx.query(
          "SELECT 1 FROM whaleu_experience.entitlements WHERE owner_id=$1 AND title_key='role_admin'",
          [owner],
        )
      ).rowCount === 0
    );
  }
  /** All Identity, Profile, Authorization, Verification and Campus ordinary
   * locks/checks must be complete before this terminal Experience owner lock. */
  async write(
    input: {
      actor: string;
      requestId: string;
      owner: string;
      recordedAt: string;
      titleGranted: boolean;
    },
    tx: PoolClient,
  ): Promise<void> {
    await lockExperienceOwner(tx, input.owner, true);
    const present =
      (
        await tx.query(
          "SELECT 1 FROM whaleu_experience.entitlements WHERE owner_id=$1 AND title_key='role_admin'",
          [input.owner],
        )
      ).rowCount === 1;
    if (present === input.titleGranted)
      throw new ApplicationError('SCHOOL_ADMIN_MANAGEMENT_UNAVAILABLE');
    if (!input.titleGranted) return;
    await tx.query(
      "INSERT INTO whaleu_experience.school_admin_title_grants(actor_id,request_id,owner_id,title_key) VALUES($1,$2,$3,'role_admin')",
      [input.actor, input.requestId, input.owner],
    );
    await tx.query(
      "INSERT INTO whaleu_experience.entitlements(owner_id,title_key,origin,earned_at,school_admin_actor_id,school_admin_request_id) VALUES($1,'role_admin','school_admin_appointment',$2,$3,$4)",
      [input.owner, input.recordedAt, input.actor, input.requestId],
    );
  }
}
@Module({
  providers: [SchoolAdminTitleEntitlementWriter],
  exports: [SchoolAdminTitleEntitlementWriter],
})
export class SchoolAdminTitleEntitlementModule {}
