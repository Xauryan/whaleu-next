import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApplicationError } from '../../http/application-error.js';
import type { SnapshotRecord, ApplicationStatus } from '../contracts.js';
export async function lockStudentLedger(account: string, tx: PoolClient) {
  const head = (
    await tx.query<{ revision: number; snapshot_id: string | null }>(
      'SELECT revision,snapshot_id FROM whaleu_verification.account_heads WHERE account_id=$1 FOR UPDATE',
      [account],
    )
  ).rows[0];
  if (!head?.snapshot_id)
    throw new ApplicationError('VERIFICATION_UNAVAILABLE');
  const prior = (
    await tx.query<SnapshotRecord>(
      'SELECT * FROM whaleu_verification.snapshots WHERE id=$1 AND account_id=$2',
      [head.snapshot_id, account],
    )
  ).rows[0];
  if (!prior) throw new ApplicationError('VERIFICATION_UNAVAILABLE');
  return { head, prior };
}
export async function appendStudentSnapshot(
  input: {
    account: string;
    actor: string;
    operationId: string;
    state: ApplicationStatus;
    decisionId?: string;
    assertionId?: string;
    ids?: { snapshot: string; event: string };
    locked?: Awaited<ReturnType<typeof lockStudentLedger>>;
  },
  tx: PoolClient,
) {
  const { head, prior } =
      input.locked ?? (await lockStudentLedger(input.account, tx)),
    snapshot = input.ids?.snapshot ?? randomUUID(),
    event = input.ids?.event ?? randomUUID();
  await tx.query(
    `INSERT INTO whaleu_verification.snapshots(id,account_id,revision,affiliation_assertion_id,student_number_assertion_id,phone_assertion_id,application_state,application_coverage) VALUES($1,$2,$3,$4,$5,$6,$7,'complete')`,
    [
      snapshot,
      input.account,
      head.revision + 1,
      input.assertionId ?? prior.affiliation_assertion_id,
      prior.student_number_assertion_id,
      prior.phone_assertion_id,
      input.state,
    ],
  );
  await tx.query(
    `INSERT INTO whaleu_verification.events(id,account_id,operation_id,kind,fact_kind,actor_account_id,expected_revision,snapshot_id,revision,reason_code) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      event,
      input.account,
      input.operationId,
      input.decisionId ? 'student_decision' : 'student_application',
      input.assertionId ? 'affiliation' : null,
      input.actor,
      head.revision,
      snapshot,
      head.revision + 1,
      input.decisionId
        ? input.assertionId
          ? 'student_document_approved'
          : 'student_document_rejected'
        : `student_application_${input.state}`,
    ],
  );
  const changed = await tx.query(
    'UPDATE whaleu_verification.account_heads SET revision=$2,snapshot_id=$3 WHERE account_id=$1 AND revision=$4',
    [input.account, head.revision + 1, snapshot, head.revision],
  );
  if (changed.rowCount !== 1)
    throw new ApplicationError('STUDENT_VERIFICATION_CONFLICT');
  return { snapshot, event, revision: head.revision + 1 };
}
