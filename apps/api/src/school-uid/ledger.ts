import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { boundedOwnerProof } from '../database/required-owner-proof.js';
import {
  enableRequiredTransactionProof,
  registerRequiredTransactionFact,
  registerTransactionExactDeadline,
} from '../database/transaction-deadlines.js';
import type { RequiredTransactionProof } from '../database/transaction-deadlines.js';
import { ApplicationError } from '../http/application-error.js';
import { SchoolUidCoverageFacade } from './coverage.facade.js';
import type { NativeAbsenceObservation } from './coverage.facade.js';

export const SCHOOL_UID_MAX = 9223372036854775807n;
export type UidCauseKind =
  'student_approval' | 'correct_school' | 'complete_uid' | 'unchanged';
export interface UidCauseInput {
  id: string;
  kind: UidCauseKind;
  account: string;
  actor: string;
  sourceId: string;
  institutionId: string;
  assertionId: string;
  snapshotId: string;
  verificationEventId: string;
  oldSnapshotId: string;
  oldRevision: number;
  coverageObservationId?: string | null;
}
interface CauseRow {
  id: string;
  kind: UidCauseKind;
  account_id: string;
  actor_account_id: string;
  source_id: string;
  affiliation_assertion_id: string;
  snapshot_id: string;
  institution_id: string;
}
export interface UidLockedState {
  head: {
    revision: number;
    event_id: string;
    allocation_id: string | null;
    institution_id: string;
    cause_id: string;
  } | null;
  allocation: {
    id: string;
    uid: string;
    institution_id: string;
    admission_id: string;
  } | null;
  coverageId: string | null;
}
export interface UidResult {
  outcome: 'issued' | 'retained' | 'deferred_unavailable';
  unavailableReason: 'inventory_unknown' | 'account_history_unknown' | null;
  eventId: string;
  allocationId: string | null;
  uid: string | null;
}
const requiredUidProof: RequiredTransactionProof<string> = {
  maximumFacts: 1,
  failureCode: 'SCHOOL_UID_UNAVAILABLE',
  validate: (facts, tx) =>
    boundedOwnerProof(tx, 'SCHOOL_UID_UNAVAILABLE', async (read) => {
      await read.query(
        `LOCK TABLE whaleu_identity.legacy_account_mappings,whaleu_school_uid.account_coverage,whaleu_school_uid.allocations,whaleu_school_uid.assignment_events,whaleu_school_uid.account_heads,whaleu_school_uid.admission_heads,whaleu_school_uid.school_admissions,whaleu_verification.native_enrollments IN SHARE MODE NOWAIT`,
      );
      for (const id of facts) {
        const row = (
          await read.query<{ valid: boolean }>(
            'SELECT whaleu_school_uid.producing_cause_complete($1) valid',
            [id],
          )
        ).rows[0];
        if (!row?.valid) throw new ApplicationError('SCHOOL_UID_UNAVAILABLE');
      }
    }),
};

/** Register exactly ONE required UID owner fact per producing command. */
export async function requireUidCauseCurrent(
  causeId: string,
  tx: PoolClient,
): Promise<void> {
  const row = (
    await tx.query<{ expires: string | null }>(
      `SELECT a.expires_at::text expires FROM whaleu_school_uid.producing_causes c JOIN whaleu_verification.assertions a ON a.id=c.affiliation_assertion_id AND a.account_id=c.account_id WHERE c.id=$1`,
      [causeId],
    )
  ).rows[0];
  if (!row) throw new ApplicationError('SCHOOL_UID_UNAVAILABLE');
  enableRequiredTransactionProof(tx, requiredUidProof);
  registerRequiredTransactionFact(tx, requiredUidProof, causeId, causeId);
  registerTransactionExactDeadline(tx, row.expires, 'SCHOOL_UID_UNAVAILABLE');
}

export class SchoolUidLedger {
  readonly coverage = new SchoolUidCoverageFacade();

  async lockAccount(account: string, tx: PoolClient): Promise<UidLockedState> {
    await tx.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('whaleu:school-uid-account:v1:'||$1,0))",
      [account],
    );
    const head =
      (
        await tx.query<NonNullable<UidLockedState['head']>>(
          'SELECT revision,event_id,allocation_id,institution_id,cause_id FROM whaleu_school_uid.account_heads WHERE account_id=$1 FOR UPDATE',
          [account],
        )
      ).rows[0] ?? null;
    const allocation = head?.allocation_id
      ? ((
          await tx.query<NonNullable<UidLockedState['allocation']>>(
            `SELECT a.id,a.uid::text,a.institution_id,a.admission_id FROM whaleu_school_uid.allocations a JOIN whaleu_school_uid.school_admissions ad ON ad.id=a.admission_id AND ad.institution_id=a.institution_id WHERE a.id=$1 AND a.account_id=$2 AND a.institution_id=$3 AND ((a.uid>ad.reserved_floor AND EXISTS(SELECT 1 FROM whaleu_school_uid.producing_causes c WHERE c.id=a.cause_id AND c.kind<>'imported')) OR (a.uid<=ad.reserved_floor AND EXISTS(SELECT 1 FROM whaleu_school_uid.producing_causes c WHERE c.id=a.cause_id AND c.kind='imported')))`,
            [head.allocation_id, account, head.institution_id],
          )
        ).rows[0] ?? null)
      : null;
    if (head?.allocation_id && !allocation)
      throw new ApplicationError('SCHOOL_UID_UNAVAILABLE');
    const coverageId =
      (
        await tx.query<{ id: string }>(
          'SELECT id FROM whaleu_school_uid.account_coverage WHERE account_id=$1',
          [account],
        )
      ).rows[0]?.id ?? null;
    return { head, allocation, coverageId };
  }

  /** Account serialization must already be held; at most old/new schools. */
  async lockInstitutions(
    institutions: readonly string[],
    tx: PoolClient,
  ): Promise<void> {
    const ordered = [...new Set(institutions)].sort();
    if (
      ordered.length < 1 ||
      ordered.length > 2 ||
      ordered.some(
        (id) =>
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
            id,
          ),
      )
    )
      throw new ApplicationError('SCHOOL_UID_UNAVAILABLE');
    // Missing rows stay missing. No synthetic zero head and no implicit admission.
    await tx.query(
      'SELECT institution_id FROM whaleu_school_uid.admission_heads WHERE institution_id=ANY($1::uuid[]) ORDER BY institution_id FOR UPDATE',
      [ordered],
    );
  }

  async registerCause(input: UidCauseInput, tx: PoolClient): Promise<void> {
    await tx.query(
      `INSERT INTO whaleu_school_uid.producing_causes(id,kind,account_id,actor_account_id,source_id,institution_id,affiliation_assertion_id,snapshot_id,verification_event_id,old_snapshot_id,old_revision,coverage_observation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        input.id,
        input.kind,
        input.account,
        input.actor,
        input.sourceId,
        input.institutionId,
        input.assertionId,
        input.snapshotId,
        input.verificationEventId,
        input.oldSnapshotId,
        input.oldRevision,
        input.coverageObservationId ?? null,
      ],
    );
  }

  async produce(
    input: {
      causeId: string;
      eventId: string;
      coverageObservation: NativeAbsenceObservation | null;
    },
    tx: PoolClient,
  ): Promise<UidResult> {
    const c = (
      await tx.query<CauseRow>(
        'SELECT * FROM whaleu_school_uid.producing_causes WHERE id=$1 AND creation_transaction=pg_current_xact_id()',
        [input.causeId],
      )
    ).rows[0];
    if (!c || c.kind === 'unchanged')
      throw new ApplicationError('SCHOOL_UID_UNAVAILABLE');
    const old = await this.lockAccount(c.account_id, tx);
    let coverage = old.coverageId;
    if (input.coverageObservation)
      coverage = await this.coverage.establishNativeAbsence(
        c.account_id,
        c.id,
        input.coverageObservation,
        tx,
      );
    if (coverage) {
      const known = (
        await tx.query<{ known: boolean }>(
          'SELECT whaleu_school_uid.runtime_history_known(c) known FROM whaleu_school_uid.producing_causes c WHERE c.id=$1',
          [c.id],
        )
      ).rows[0]?.known;
      if (known !== true) coverage = null;
    }
    let outcome: UidResult['outcome'];
    let unavailableReason: UidResult['unavailableReason'] = null;
    let allocationId: string | null = null;
    let uid: string | null = null;
    // A proven existing number does not depend on tomorrow's issuance capacity.
    if (coverage && old.allocation?.institution_id === c.institution_id) {
      outcome = 'retained';
      allocationId = old.allocation.id;
      uid = old.allocation.uid;
    } else if (!coverage) {
      if (c.kind !== 'student_approval' || old.allocation)
        throw new ApplicationError('SCHOOL_UID_UNAVAILABLE');
      outcome = 'deferred_unavailable';
      unavailableReason = 'account_history_unknown';
    } else {
      const institutions = [
        ...new Set([
          c.institution_id,
          ...(old.head ? [old.head.institution_id] : []),
        ]),
      ].sort();
      const rows = (
        await tx.query<{
          institution_id: string;
          admission_id: string;
          high_water: string;
          issuance_available: boolean;
        }>(
          'SELECT h.institution_id,h.admission_id,h.high_water::text,a.issuance_available FROM whaleu_school_uid.admission_heads h JOIN whaleu_school_uid.school_admissions a ON a.id=h.admission_id WHERE h.institution_id=ANY($1::uuid[]) ORDER BY h.institution_id FOR UPDATE OF h',
          [institutions],
        )
      ).rows;
      const admission = rows.find((a) => a.institution_id === c.institution_id);
      if (!admission || !admission.issuance_available) {
        if (c.kind !== 'student_approval' || old.allocation)
          throw new ApplicationError('SCHOOL_UID_UNAVAILABLE');
        outcome = 'deferred_unavailable';
        unavailableReason = 'inventory_unknown';
      } else {
        const current = BigInt(admission.high_water);
        if (current >= SCHOOL_UID_MAX)
          throw new ApplicationError('SCHOOL_UID_EXHAUSTED');
        if (current < 0n) throw new ApplicationError('SCHOOL_UID_UNAVAILABLE');
        uid = (current + 1n).toString();
        allocationId = randomUUID();
        outcome = 'issued';
        await tx.query(
          `INSERT INTO whaleu_school_uid.allocations(id,account_id,institution_id,uid,admission_id,cause_id,predecessor_allocation_id) VALUES($1,$2,$3,$4::bigint,$5,$6,$7)`,
          [
            allocationId,
            c.account_id,
            c.institution_id,
            uid,
            admission.admission_id,
            c.id,
            old.head?.allocation_id ?? null,
          ],
        );
      }
    }
    const revision = (old.head?.revision ?? 0) + 1;
    await tx.query(
      `INSERT INTO whaleu_school_uid.assignment_events(id,cause_id,account_id,institution_id,previous_allocation_id,resulting_allocation_id,affiliation_assertion_id,snapshot_id,revision,outcome,unavailable_reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        input.eventId,
        c.id,
        c.account_id,
        c.institution_id,
        old.head?.allocation_id ?? null,
        allocationId,
        c.affiliation_assertion_id,
        c.snapshot_id,
        revision,
        outcome,
        unavailableReason,
      ],
    );
    // Avoid UPSERT: INSERT ... ON CONFLICT fires an empty UPDATE statement hook.
    if (old.head) {
      const changed = await tx.query(
        'UPDATE whaleu_school_uid.account_heads SET revision=$2,event_id=$3,allocation_id=$4,institution_id=$5,cause_id=$6 WHERE account_id=$1 AND revision=$7',
        [
          c.account_id,
          revision,
          input.eventId,
          allocationId,
          c.institution_id,
          c.id,
          old.head.revision,
        ],
      );
      if (changed.rowCount !== 1)
        throw new ApplicationError('SCHOOL_UID_UNAVAILABLE');
    } else {
      await tx.query(
        'INSERT INTO whaleu_school_uid.account_heads(account_id,revision,event_id,allocation_id,institution_id,cause_id) VALUES($1,$2,$3,$4,$5,$6)',
        [
          c.account_id,
          revision,
          input.eventId,
          allocationId,
          c.institution_id,
          c.id,
        ],
      );
    }
    return {
      outcome,
      unavailableReason,
      eventId: input.eventId,
      allocationId,
      uid,
    };
  }

  async recordApprovedDecision(
    causeId: string,
    eventId: string,
    tx: PoolClient,
  ): Promise<void> {
    const inserted = await tx.query(
      `INSERT INTO whaleu_school_uid.issuance_decisions(student_decision_id,cause_id,event_id,outcome,unavailable_reason) SELECT c.source_id,c.id,e.id,e.outcome,e.unavailable_reason FROM whaleu_school_uid.producing_causes c JOIN whaleu_school_uid.assignment_events e ON e.cause_id=c.id AND e.id=$2 WHERE c.id=$1 AND c.kind='student_approval' AND c.creation_transaction=pg_current_xact_id()`,
      [causeId, eventId],
    );
    if (inserted.rowCount !== 1)
      throw new ApplicationError('SCHOOL_UID_UNAVAILABLE');
  }
}
