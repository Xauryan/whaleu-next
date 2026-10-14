import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { registerTransactionExactDeadline } from '../database/transaction-deadlines.js';
import { ApplicationError } from '../http/application-error.js';

/** Transaction-only values. Exact timestamp text must not pass through Date. */
export interface SchoolIdentityVerificationObservation {
  readonly head: {
    readonly account_id: string;
    readonly revision: number;
    readonly snapshot_id: string;
  };
  readonly snapshot: {
    readonly id: string;
    readonly account_id: string;
    readonly revision: number;
    readonly affiliation_assertion_id: string;
    readonly student_number_assertion_id: string | null;
    readonly phone_assertion_id: string | null;
    readonly application_state: string;
    readonly application_coverage: string;
    readonly recorded_at: string;
  };
  readonly affiliation: {
    readonly id: string;
    readonly account_id: string;
    readonly issuer_institution_id: string;
    readonly origin_region_id: string;
    readonly expiry_kind: 'at' | 'policy_exempt';
    readonly expires_at: string | null;
    readonly [key: string]: unknown;
  };
  readonly headXmin: string;
  readonly headCtid: string;
  readonly eventId: string;
}
export interface SchoolIdentityCorrectionIds {
  readonly assertionId: string;
  readonly snapshotId: string;
  readonly eventId: string;
}
export function schoolIdentityCorrectionIds(): SchoolIdentityCorrectionIds {
  return {
    assertionId: randomUUID(),
    snapshotId: randomUUID(),
    eventId: randomUUID(),
  };
}
/** This is the complete historical vector, not a capacity-sized slot prefix. */
export type SchoolIdentityAdmissionVector = Readonly<Record<string, string>>;

@Injectable()
export class SchoolIdentityVerificationFacade {
  /** Capture before source/Verification/UID waits; no deadline registration. */
  async observe(accountId: string, tx: PoolClient) {
    const observation = (
      await tx.query<{
        observation: SchoolIdentityVerificationObservation | null;
      }>(
        'SELECT whaleu_verification.school_identity_observation($1) observation',
        [accountId],
      )
    ).rows[0]?.observation;
    return observation ?? null;
  }

  /** Recheck the original complete observation instead of refreshing it. */
  async lock(
    observation: SchoolIdentityVerificationObservation,
    tx: PoolClient,
  ): Promise<void> {
    await tx.query(
      'SELECT account_id FROM whaleu_verification.account_heads WHERE account_id=$1 FOR UPDATE',
      [observation.head.account_id],
    );
    const current = (
      await tx.query<{ unchanged: boolean }>(
        'SELECT whaleu_verification.school_identity_observation($1) IS NOT DISTINCT FROM $2::jsonb unchanged',
        [observation.head.account_id, JSON.stringify(observation)],
      )
    ).rows[0];
    if (!current?.unchanged)
      throw new ApplicationError('SCHOOL_IDENTITY_UNAVAILABLE');
    registerTransactionExactDeadline(
      tx,
      observation.affiliation.expires_at,
      'SCHOOL_IDENTITY_UNAVAILABLE',
    );
  }

  async observeGeneration(
    tx: PoolClient,
    accountId?: string,
  ): Promise<SchoolIdentityAdmissionVector> {
    if (accountId !== undefined) {
      // One immutable first observation per account/transaction. ON CONFLICT
      // never refreshes it; all actual vector bytes come from the owner trigger.
      await tx.query(
        `INSERT INTO whaleu_verification.school_identity_source_observations(id,account_id)
         VALUES($1,$2) ON CONFLICT(account_id,creation_transaction) DO NOTHING`,
        [randomUUID(), accountId],
      );
      const row = (
        await tx.query<{ vector: SchoolIdentityAdmissionVector }>(
          'SELECT initial_vector vector FROM whaleu_verification.school_identity_source_observations WHERE account_id=$1 AND creation_transaction=pg_current_xact_id()',
          [accountId],
        )
      ).rows[0];
      if (!row) throw new ApplicationError('SCHOOL_IDENTITY_UNAVAILABLE');
      return Object.freeze(row.vector);
    }
    return Object.freeze(
      (
        await tx.query<{ vector: SchoolIdentityAdmissionVector }>(
          'SELECT whaleu_verification.school_identity_admission_vector() vector',
        )
      ).rows[0]!.vector,
    );
  }

  /** The producing cause already binds all generated IDs and the old head.
   * Call after cause INSERT and before the first Verification source statement.
   * This never replaces the initial vector with a post-wait observation. */
  async registerGeneration(
    causeId: string,
    initialVector: SchoolIdentityAdmissionVector,
    tx: PoolClient,
  ): Promise<void> {
    await tx.query(
      `INSERT INTO whaleu_verification.school_identity_source_proofs(cause_id,observation_id,initial_vector,old_head,old_snapshot)
       SELECT c.id,o.id,$2::jsonb,to_jsonb(h),to_jsonb(s)
       FROM whaleu_school_uid.producing_causes c
       JOIN whaleu_verification.school_identity_source_observations o ON o.account_id=c.account_id AND o.creation_transaction=c.creation_transaction
       JOIN whaleu_verification.account_heads h ON h.account_id=c.account_id AND h.snapshot_id=c.old_snapshot_id AND h.revision=c.old_revision
       JOIN whaleu_verification.snapshots s ON(s.id,s.account_id,s.revision)=(h.snapshot_id,h.account_id,h.revision)
       WHERE c.id=$1 AND c.creation_transaction=pg_current_xact_id()`,
      [causeId, JSON.stringify(initialVector)],
    );
    const registered = (
      await tx.query<{ present: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM whaleu_verification.school_identity_source_proofs WHERE cause_id=$1 AND creation_transaction=pg_current_xact_id()) present',
        [causeId],
      )
    ).rows[0]?.present;
    if (!registered) throw new ApplicationError('SCHOOL_IDENTITY_UNAVAILABLE');
  }

  /** Exactly assertion INSERT, snapshot INSERT, head UPDATE. Events do not
   * advance admission generation. UID issuance follows in the same transaction. */
  async append(
    input: {
      readonly causeId: string;
      readonly commandId: string;
      readonly actorAccountId: string;
      readonly accountId: string;
      readonly destinationInstitutionId: string;
      readonly destinationRegionId: string;
      readonly observation: SchoolIdentityVerificationObservation;
      readonly ids: SchoolIdentityCorrectionIds;
    },
    tx: PoolClient,
  ) {
    await tx.query(
      `INSERT INTO whaleu_verification.school_identity_corrections(cause_id,command_id,account_id,actor_account_id,old_observation,institution_id,origin_region_id,assertion_id,snapshot_id,event_id)
       VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10)`,
      [
        input.causeId,
        input.commandId,
        input.accountId,
        input.actorAccountId,
        JSON.stringify(input.observation),
        input.destinationInstitutionId,
        input.destinationRegionId,
        input.ids.assertionId,
        input.ids.snapshotId,
        input.ids.eventId,
      ],
    );
    await tx.query(
      `INSERT INTO whaleu_verification.assertions(id,account_id,fact_kind,assertion_state,coverage_state,provenance_state,method,source_reference,policy_reference,source_account_id,issuer_institution_id,source_issuer_institution_id,origin_region_id,verified_at,expiry_kind,expires_at,previous_assertion_id)
       SELECT c.assertion_id,c.account_id,'affiliation','verified','complete','accepted','administrator_correction','school_identity_correction:'||c.command_id::text,'verified-school-correction/v1',c.account_id,c.institution_id,c.institution_id,c.origin_region_id,c.verified_at,a.expiry_kind,a.expires_at,a.id
       FROM whaleu_verification.school_identity_corrections c JOIN whaleu_verification.assertions a ON a.id=(c.old_observation->'affiliation'->>'id')::uuid AND a.account_id=c.account_id WHERE c.cause_id=$1`,
      [input.causeId],
    );
    await tx.query(
      `INSERT INTO whaleu_verification.snapshots(id,account_id,revision,affiliation_assertion_id,student_number_assertion_id,phone_assertion_id,application_state,application_coverage)
       SELECT c.snapshot_id,c.account_id,s.revision+1,c.assertion_id,s.student_number_assertion_id,s.phone_assertion_id,s.application_state,s.application_coverage
       FROM whaleu_verification.school_identity_corrections c JOIN whaleu_verification.snapshots s ON s.id=(c.old_observation->'head'->>'snapshot_id')::uuid AND s.account_id=c.account_id WHERE c.cause_id=$1`,
      [input.causeId],
    );
    await tx.query(
      `INSERT INTO whaleu_verification.events(id,account_id,operation_id,kind,fact_kind,actor_account_id,expected_revision,snapshot_id,revision,reason_code)
       SELECT c.event_id,c.account_id,c.command_id,'school_identity_correction','affiliation',c.actor_account_id,(c.old_observation->'head'->>'revision')::integer,c.snapshot_id,(c.old_observation->'head'->>'revision')::integer+1,'verified_school_corrected'
       FROM whaleu_verification.school_identity_corrections c WHERE c.cause_id=$1`,
      [input.causeId],
    );
    const changed = await tx.query(
      'UPDATE whaleu_verification.account_heads SET revision=$2,snapshot_id=$3 WHERE account_id=$1 AND revision=$4 AND snapshot_id=$5',
      [
        input.accountId,
        input.observation.head.revision + 1,
        input.ids.snapshotId,
        input.observation.head.revision,
        input.observation.head.snapshot_id,
      ],
    );
    if (changed.rowCount !== 1)
      throw new ApplicationError('SCHOOL_IDENTITY_UNAVAILABLE');
    return { ...input.ids, revision: input.observation.head.revision + 1 };
  }

  /** Invoke within the command's one existing bounded required UID proof. */
  async finalProof(causeId: string, tx: PoolClient): Promise<void> {
    const row = (
      await tx.query<{ valid: boolean }>(
        'SELECT whaleu_verification.school_identity_source_final($1) valid',
        [causeId],
      )
    ).rows[0];
    if (!row?.valid) throw new ApplicationError('SCHOOL_IDENTITY_UNAVAILABLE');
  }
}
