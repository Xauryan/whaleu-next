import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';

/** An opaque server-recorded BEFORE-WAIT observation; callers cannot supply facts. */
export interface NativeAbsenceObservation {
  readonly id: string;
  readonly accountId: string;
  readonly transaction: string;
}
interface ObservationRow {
  id: string;
  account_id: string;
  creation_transaction: string;
  existing_coverage_id: string | null;
  native_proof: { enrollment: { operation_id: string } } | null;
  eligible: boolean;
  unchanged: boolean;
}
export class SchoolUidCoverageFacade {
  async observeNativeAbsence(
    account: string,
    tx: PoolClient,
  ): Promise<NativeAbsenceObservation> {
    const existing = (
      await tx.query<{ id: string; transaction: string }>(
        `SELECT id,creation_transaction::text transaction FROM whaleu_school_uid.native_absence_observations WHERE account_id=$1 AND creation_transaction=pg_current_xact_id()`,
        [account],
      )
    ).rows[0];
    // Reuse the first observation. A second caller never replaces the baseline.
    const observed =
      existing ??
      (
        await tx.query<{ id: string; transaction: string }>(
          `INSERT INTO whaleu_school_uid.native_absence_observations(id,account_id,history_proof) VALUES($1,$2,'{}') RETURNING id,creation_transaction::text transaction`,
          [randomUUID(), account],
        )
      ).rows[0];
    if (!observed) throw new ApplicationError('SCHOOL_UID_UNAVAILABLE');
    return Object.freeze({
      id: observed.id,
      accountId: account,
      transaction: observed.transaction,
    });
  }

  /** Only an authorized producing transaction, after Verification and UID locks. */
  async establishNativeAbsence(
    account: string,
    producingCause: string,
    observation: NativeAbsenceObservation,
    tx: PoolClient,
  ): Promise<string | null> {
    if (observation.accountId !== account)
      throw new ApplicationError('SCHOOL_UID_UNAVAILABLE');
    const row = (
      await tx.query<ObservationRow>(
        `SELECT o.*,o.creation_transaction::text,
          o.history_proof=whaleu_school_uid.account_history_proof(o.account_id) AND o.native_proof IS NOT DISTINCT FROM whaleu_school_uid.native_identity_proof(o.account_id) unchanged,
          o.native_proof IS NOT NULL AND o.history_proof=jsonb_build_object('mappings','[]'::jsonb,'coverage','[]'::jsonb,'allocations','[]'::jsonb,'events','[]'::jsonb,'head',NULL) eligible
         FROM whaleu_school_uid.native_absence_observations o JOIN whaleu_school_uid.producing_causes c ON c.id=$3 AND c.account_id=o.account_id AND c.coverage_observation_id=o.id
         WHERE o.id=$1 AND o.account_id=$2 AND o.creation_transaction=pg_current_xact_id() AND c.creation_transaction=pg_current_xact_id()`,
        [observation.id, account, producingCause],
      )
    ).rows[0];
    if (
      !row ||
      row.creation_transaction !== observation.transaction ||
      !row.unchanged
    )
      throw new ApplicationError('SCHOOL_UID_UNAVAILABLE');
    if (row.existing_coverage_id) {
      const valid =
        (
          await tx.query(
            `SELECT 1 FROM whaleu_school_uid.account_coverage WHERE id=$1 AND account_id=$2 AND whaleu_school_uid.coverage_valid($2)`,
            [row.existing_coverage_id, account],
          )
        ).rowCount === 1;
      return valid ? row.existing_coverage_id : null;
    }
    if (!row.eligible || !row.native_proof) return null;
    const id = randomUUID();
    await tx.query(
      `INSERT INTO whaleu_school_uid.account_coverage(id,account_id,kind,observation_id,cause_id,enrollment_operation_id) VALUES($1,$2,'native_absence',$3,$4,$5)`,
      [
        id,
        account,
        observation.id,
        producingCause,
        row.native_proof.enrollment.operation_id,
      ],
    );
    return id;
  }
}
