import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import { registerTransactionExactDeadline } from '../../database/transaction-deadlines.js';
import type {
  SchoolAdminManagementCommand,
  SchoolAdminManagementReceipt,
} from './contracts.js';
export interface ManagementGrant {
  id: string;
  accountId: string;
  role: 'developer' | 'super_admin' | 'school_admin';
  regionId: string | null;
  validFrom: Date;
  expiresAt: Date | null;
  expiresExact: string | null;
  validFromExact: string;
  current: boolean;
}
@Injectable()
export class SchoolAdminManagementRepository {
  async candidateSuper(actor: string, tx: PoolClient): Promise<string> {
    const row = (
      await tx.query<{ id: string }>(
        `SELECT id FROM whaleu_authorization.role_grants WHERE account_id=$1 AND role='super_admin' AND operating_region_id IS NULL AND revoked_at IS NULL AND valid_from<=clock_timestamp() AND (expires_at IS NULL OR expires_at>clock_timestamp()) ORDER BY id LIMIT 1`,
        [actor],
      )
    ).rows[0];
    if (!row) throw new ApplicationError('AUTHORIZATION_REQUIRED');
    return row.id;
  }
  async lockGrants(
    actor: string,
    target: string,
    selected: string,
    write: boolean,
    tx: PoolClient,
  ): Promise<{ actorGrant: ManagementGrant; targetGrants: ManagementGrant[] }> {
    const rows = (
      await tx.query<ManagementGrant>(
        `SELECT id,account_id AS "accountId",role,operating_region_id AS "regionId",valid_from AS "validFrom",expires_at AS "expiresAt",expires_at::text AS "expiresExact",valid_from::text AS "validFromExact",false AS current FROM whaleu_authorization.role_grants WHERE account_id=ANY($1::uuid[]) AND revoked_at IS NULL ORDER BY account_id,id FOR ${write ? 'UPDATE' : 'SHARE'}`,
        [[...new Set([actor, target])].sort()],
      )
    ).rows;
    const now = (await tx.query<{ now: Date }>('SELECT clock_timestamp() now'))
      .rows[0]!.now;
    for (const row of rows)
      row.current =
        row.validFrom <= now && (row.expiresAt === null || row.expiresAt > now);
    const actorGrant = rows.find(
      (row) =>
        row.accountId === actor &&
        row.id === selected &&
        row.role === 'super_admin' &&
        row.regionId === null &&
        row.current,
    );
    if (!actorGrant)
      throw new ApplicationError('SCHOOL_ADMIN_MANAGEMENT_UNAVAILABLE');
    registerTransactionExactDeadline(
      tx,
      actorGrant.expiresExact,
      'SCHOOL_ADMIN_MANAGEMENT_UNAVAILABLE',
    );
    return {
      actorGrant,
      targetGrants: rows.filter((row) => row.accountId === target),
    };
  }
  async requestLock(
    actor: string,
    requestId: string,
    tx: PoolClient,
  ): Promise<void> {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:school-admin-management-request:v1:'||$1||':'||$2,0))",
      [actor, requestId],
    );
  }
  async request(actor: string, requestId: string, tx: PoolClient) {
    return (
      (
        await tx.query<{
          intent_hash: string;
          receipt: SchoolAdminManagementReceipt;
        }>(
          'SELECT intent_hash,receipt FROM whaleu_authorization.school_admin_management_commands WHERE actor_id=$1 AND request_id=$2',
          [actor, requestId],
        )
      ).rows[0] ?? null
    );
  }
  async stateVersion(targetProfile: string, tx: PoolClient): Promise<string> {
    const row = (
      await tx.query<{ version: string }>(
        'SELECT whaleu_authorization.school_admin_management_state_version($1) version',
        [targetProfile],
      )
    ).rows[0];
    if (!row || !/^[a-f0-9]{64}$/.test(row.version))
      throw new ApplicationError('SCHOOL_ADMIN_MANAGEMENT_UNAVAILABLE');
    return row.version;
  }
  async region(regionId: string, tx: PoolClient) {
    return (
      (
        await tx.query<{ name: string; active: boolean }>(
          'SELECT name,is_active AS active FROM whaleu_campus.operating_regions WHERE id=$1 FOR SHARE',
          [regionId],
        )
      ).rows[0] ?? null
    );
  }
  async save(
    input: {
      actor: string;
      sessionId: string;
      tokenHash: string;
      command: SchoolAdminManagementCommand;
      hash: string;
      receipt: SchoolAdminManagementReceipt;
      subject: string | null;
      actorGrant: string | null;
      initial: unknown;
      oldGrant: string | null;
      newGrant: string | null;
    },
    tx: PoolClient,
  ): Promise<void> {
    const changed = await tx.query(
      `INSERT INTO whaleu_authorization.school_admin_management_commands(actor_id,request_id,session_id,token_hash,target_profile_id,subject_id,actor_grant_id,intent_hash,command,receipt,input_before,old_grant_id,new_grant_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        input.actor,
        input.command.clientRequestId,
        input.sessionId,
        input.tokenHash,
        input.command.targetProfileId,
        input.subject,
        input.actorGrant,
        input.hash,
        input.command,
        input.receipt,
        input.initial,
        input.oldGrant,
        input.newGrant,
      ],
    );
    if (changed.rowCount !== 1)
      throw new ApplicationError('SCHOOL_ADMIN_MANAGEMENT_UNAVAILABLE');
  }
  async revoke(
    oldGrant: string,
    actor: string,
    at: string,
    tx: PoolClient,
  ): Promise<void> {
    const result = await tx.query(
      "UPDATE whaleu_authorization.role_grants SET revoked_at=$3,revoked_by_account_id=$2 WHERE id=$1 AND role='school_admin' AND revoked_at IS NULL",
      [oldGrant, actor, at],
    );
    if (result.rowCount !== 1)
      throw new ApplicationError('SCHOOL_ADMIN_MANAGEMENT_UNAVAILABLE');
  }
  async appoint(
    id: string,
    subject: string,
    region: string,
    actor: string,
    request: string,
    tx: PoolClient,
  ): Promise<void> {
    const result = await tx.query(
      `INSERT INTO whaleu_authorization.role_grants(id,account_id,role,operating_region_id,approved_by_account_id,approval_reference) VALUES($1,$2,'school_admin',$3,$4,$5)`,
      [
        id,
        subject,
        region,
        actor,
        `school-admin-management:${actor}:${request}`,
      ],
    );
    if (result.rowCount !== 1)
      throw new ApplicationError('SCHOOL_ADMIN_MANAGEMENT_UNAVAILABLE');
  }
}
