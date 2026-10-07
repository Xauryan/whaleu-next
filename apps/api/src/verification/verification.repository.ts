import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  AssertionRecord,
  SnapshotRecord,
  VerificationRead,
} from './contracts.js';
import { assertionStatus } from './policy.js';

function unavailable(): VerificationRead {
  return {
    summary: {
      affiliation: { status: 'unavailable' },
      studentNumber: { status: 'unavailable' },
      phone: { status: 'unavailable' },
      application: { status: 'unavailable' },
    },
    studentNumber: null,
    studentNumberValidUntil: null,
  };
}

@Injectable()
export class VerificationRepository {
  async read(
    accountId: string,
    transaction: PoolClient,
  ): Promise<VerificationRead> {
    // One account head locks the entire current snapshot, including missing fact pointers.
    // Writers must UPDATE-lock it first. No provider or cross-domain query runs here.
    const head = (
      await transaction.query<{ snapshot_id: string | null }>(
        'SELECT snapshot_id FROM whaleu_verification.account_heads WHERE account_id=$1 FOR SHARE',
        [accountId],
      )
    ).rows[0];
    if (!head?.snapshot_id) return unavailable();
    const snapshot = (
      await transaction.query<SnapshotRecord>(
        'SELECT id,account_id,revision,affiliation_assertion_id,student_number_assertion_id,phone_assertion_id,application_state,application_coverage FROM whaleu_verification.snapshots WHERE id=$1 AND account_id=$2',
        [head.snapshot_id, accountId],
      )
    ).rows[0];
    if (!snapshot) return unavailable();
    const ids = [
      snapshot.affiliation_assertion_id,
      snapshot.student_number_assertion_id,
      snapshot.phone_assertion_id,
    ].filter((id): id is string => id !== null);
    const assertions = (
      await transaction.query<AssertionRecord>(
        `SELECT id,account_id,fact_kind,assertion_state,coverage_state,provenance_state,method,source_reference,policy_reference,source_account_id,
              issuer_institution_id,source_issuer_institution_id,origin_region_id,student_number,phone_binding_reference,verified_at,expiry_kind,expires_at
       FROM whaleu_verification.assertions WHERE account_id=$1 AND id=ANY($2::uuid[])`,
        [accountId, ids],
      )
    ).rows;
    // Separate statement AFTER every lock. A predicate timestamp before a wait is unsafe.
    const now = (
      await transaction.query<{ now: Date }>('SELECT clock_timestamp() AS now')
    ).rows[0]!.now;
    const find = (id: string | null) =>
      assertions.find((assertion) => assertion.id === id);
    const affiliation = find(snapshot.affiliation_assertion_id);
    const number = find(snapshot.student_number_assertion_id);
    let affiliationStatus = assertionStatus(
      affiliation,
      accountId,
      'affiliation',
      now,
    );
    let numberStatus = assertionStatus(
      number,
      accountId,
      'student_number',
      now,
    );
    if (
      affiliationStatus === 'verified' &&
      numberStatus === 'verified' &&
      affiliation!.issuer_institution_id !== number!.issuer_institution_id
    ) {
      affiliationStatus = 'unavailable';
      numberStatus = 'unavailable';
    }
    return {
      summary: {
        affiliation: { status: affiliationStatus },
        studentNumber: { status: numberStatus },
        phone: {
          status: assertionStatus(
            find(snapshot.phone_assertion_id),
            accountId,
            'phone',
            now,
          ),
        },
        application: {
          status:
            snapshot.application_coverage === 'complete'
              ? snapshot.application_state
              : 'unavailable',
        },
      },
      studentNumber:
        numberStatus === 'verified' ? number!.student_number : null,
      studentNumberValidUntil:
        numberStatus === 'verified'
          ? (number!.expires_at?.getTime() ?? null)
          : null,
    };
  }
}
