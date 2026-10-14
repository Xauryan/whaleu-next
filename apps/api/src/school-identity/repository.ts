import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import type {
  SchoolIdentityCommand,
  SchoolIdentityReceipt,
} from './contracts.js';
@Injectable()
export class SchoolIdentityRepository {
  async requestLock(actor: string, request: string, tx: PoolClient) {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:school-identity-request:v1:'||$1||':'||$2,0))",
      [actor, request],
    );
  }
  async request(actor: string, request: string, tx: PoolClient) {
    return (
      (
        await tx.query<{ intent_hash: string; receipt: unknown }>(
          'SELECT intent_hash,receipt FROM whaleu_school_uid.commands WHERE actor_id=$1 AND request_id=$2',
          [actor, request],
        )
      ).rows[0] ?? null
    );
  }
  async inputs(
    actor: string,
    selected: string,
    target: string,
    campus: string | null,
    tx: PoolClient,
  ) {
    const row = (
      await tx.query<{ facts: unknown }>(
        'SELECT whaleu_school_uid.management_inputs($1,$2,$3,$4) facts',
        [actor, selected, target, campus],
      )
    ).rows[0];
    if (
      !row?.facts ||
      Buffer.byteLength(JSON.stringify(row.facts)) > 4 * 1024 * 1024
    )
      throw new ApplicationError('SCHOOL_IDENTITY_UNAVAILABLE');
    return row.facts;
  }
  async stateVersion(target: string, actor: string, tx: PoolClient) {
    return (
      await tx.query<{ version: string }>(
        'SELECT whaleu_school_uid.state_version($1,$2) version',
        [target, actor],
      )
    ).rows[0]!.version;
  }
  async destination(campus: string, tx: PoolClient) {
    return (
      (
        await tx.query<{
          campusId: string;
          campusName: string;
          institutionId: string;
          regionId: string;
          code: string;
          name: string;
          destinationVersion: string;
        }>(
          `SELECT c.id "campusId",c.full_name "campusName",c.institution_id "institutionId",r.id "regionId",m.school_code code,i.name,whaleu_school_uid.destination_version(c.id) "destinationVersion" FROM whaleu_campus.campuses c JOIN whaleu_campus.institutions i ON i.id=c.institution_id JOIN whaleu_campus.school_identifiers m ON m.institution_id=i.id JOIN whaleu_campus.campus_region_assignments a ON a.campus_id=c.id JOIN whaleu_campus.operating_regions r ON r.id=a.operating_region_id WHERE c.id=$1 AND c.is_active AND r.is_active`,
          [campus],
        )
      ).rows[0] ?? null
    );
  }
  async school(institution: string, tx: PoolClient) {
    return (
      (
        await tx.query<{ code: string; name: string }>(
          'SELECT m.school_code code,i.name FROM whaleu_campus.institutions i JOIN whaleu_campus.school_identifiers m ON m.institution_id=i.id WHERE i.id=$1',
          [institution],
        )
      ).rows[0] ?? null
    );
  }
  async completionAllowed(account: string, assertion: string, tx: PoolClient) {
    return (
      (
        await tx.query<{ allowed: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM whaleu_verification.student_decisions d WHERE d.account_id=$1 AND d.assertion_id=$2 AND d.decision='approved') OR EXISTS(SELECT 1 FROM whaleu_school_uid.assignment_events e JOIN whaleu_school_uid.producing_causes c ON c.id=e.cause_id WHERE e.account_id=$1 AND e.affiliation_assertion_id=$2 AND e.outcome='deferred_unavailable') OR EXISTS(SELECT 1 FROM whaleu_school_uid.account_coverage c WHERE c.account_id=$1 AND c.kind='accepted_import' AND whaleu_school_uid.coverage_valid($1)) allowed`,
          [account, assertion],
        )
      ).rows[0]?.allowed === true
    );
  }
  async save(
    input: {
      id: string;
      actor: string;
      sessionId: string;
      tokenHash: string;
      command: SchoolIdentityCommand;
      hash: string;
      receipt: SchoolIdentityReceipt;
      account: string | null;
      grant: string | null;
      initial: unknown;
      oldSnapshotId?: string;
      newSnapshotId?: string;
      newAssertionId?: string;
      verificationEventId?: string;
      uidEventId?: string;
      causeId?: string;
    },
    tx: PoolClient,
  ) {
    const changed = await tx.query(
      `INSERT INTO whaleu_school_uid.commands(id,actor_id,request_id,session_id,token_hash,target_profile_id,account_id,actor_grant_id,intent_hash,command,receipt,input_before,old_snapshot_id,new_snapshot_id,new_assertion_id,verification_event_id,uid_event_id,cause_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [
        input.id,
        input.actor,
        input.command.clientRequestId,
        input.sessionId,
        input.tokenHash,
        input.command.targetProfileId,
        input.account,
        input.grant,
        input.hash,
        input.command,
        input.receipt,
        input.initial,
        input.oldSnapshotId ?? null,
        input.newSnapshotId ?? null,
        input.newAssertionId ?? null,
        input.verificationEventId ?? null,
        input.uidEventId ?? null,
        input.causeId ?? null,
      ],
    );
    if (changed.rowCount !== 1)
      throw new ApplicationError('SCHOOL_IDENTITY_UNAVAILABLE');
  }
}
