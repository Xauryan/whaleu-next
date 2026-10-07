import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { SnapshotRecord } from './contracts.js';

const revokeSchema = z.strictObject({
  accountId: z.uuid(),
  actorAccountId: z.uuid(),
  operationId: z.uuid(),
  fact: z.enum(['affiliation', 'student_number', 'phone']),
  expectedRevision: z.number().int().positive(),
  reasonCode: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
});
export type RevokeAssertion = z.infer<typeof revokeSchema>;
export interface RevocationReceipt {
  readonly eventId: string;
  readonly revision: number;
}
export class VerificationConflict extends Error {
  constructor() {
    super('Verification transition conflict');
  }
}

/** Internal transaction primitive, NOT an authorization facade or registered HTTP provider.
 * A future scoped workflow must authorize the actor before calling, in the same transaction.
 * There is deliberately no general issuer/approval/attestation mutation API in V1.
 */
export async function revokeAssertion(
  transaction: PoolClient,
  input: RevokeAssertion,
): Promise<RevocationReceipt> {
  const command = revokeSchema.parse(input);
  const head = (
    await transaction.query<{ revision: number; snapshot_id: string | null }>(
      'SELECT revision,snapshot_id FROM whaleu_verification.account_heads WHERE account_id=$1 FOR UPDATE',
      [command.accountId],
    )
  ).rows[0];
  if (!head) throw new VerificationConflict();
  const replay = (
    await transaction.query<{
      id: string;
      revision: number;
      kind: string;
      fact_kind: string | null;
      actor_account_id: string;
      expected_revision: number;
      reason_code: string;
    }>(
      'SELECT id,revision,kind,fact_kind,actor_account_id,expected_revision,reason_code FROM whaleu_verification.events WHERE account_id=$1 AND operation_id=$2',
      [command.accountId, command.operationId],
    )
  ).rows[0];
  if (replay) {
    if (
      replay.kind !== 'revoke' ||
      replay.fact_kind !== command.fact ||
      replay.actor_account_id !== command.actorAccountId ||
      replay.expected_revision !== command.expectedRevision ||
      replay.reason_code !== command.reasonCode
    )
      throw new VerificationConflict();
    return { eventId: replay.id, revision: replay.revision };
  }
  if (head.revision !== command.expectedRevision || !head.snapshot_id)
    throw new VerificationConflict();
  const snapshot = (
    await transaction.query<SnapshotRecord>(
      'SELECT id,account_id,revision,affiliation_assertion_id,student_number_assertion_id,phone_assertion_id,application_state,application_coverage FROM whaleu_verification.snapshots WHERE id=$1',
      [head.snapshot_id],
    )
  ).rows[0]!;
  const pointer =
    command.fact === 'affiliation'
      ? 'affiliation_assertion_id'
      : command.fact === 'student_number'
        ? 'student_number_assertion_id'
        : 'phone_assertion_id';
  const previousId = snapshot[pointer];
  if (!previousId) throw new VerificationConflict();
  const assertionId = randomUUID(),
    snapshotId = randomUUID(),
    eventId = randomUUID();
  const inserted = await transaction.query(
    `INSERT INTO whaleu_verification.assertions(id,account_id,fact_kind,assertion_state,coverage_state,provenance_state,method,source_reference,policy_reference,source_account_id,
      issuer_institution_id,source_issuer_institution_id,origin_region_id,student_number,phone_binding_reference,verified_at,expiry_kind,expires_at,previous_assertion_id)
     SELECT $1,account_id,fact_kind,'revoked',coverage_state,provenance_state,method,source_reference,policy_reference,source_account_id,
      issuer_institution_id,source_issuer_institution_id,origin_region_id,student_number,phone_binding_reference,verified_at,expiry_kind,expires_at,id
     FROM whaleu_verification.assertions WHERE id=$2 AND account_id=$3 AND fact_kind=$4 AND assertion_state IN ('verified','expired')`,
    [assertionId, previousId, command.accountId, command.fact],
  );
  if (inserted.rowCount !== 1) throw new VerificationConflict();
  const revision = head.revision + 1;
  await transaction.query(
    `INSERT INTO whaleu_verification.snapshots(id,account_id,revision,affiliation_assertion_id,student_number_assertion_id,phone_assertion_id,application_state,application_coverage) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      snapshotId,
      command.accountId,
      revision,
      pointer === 'affiliation_assertion_id'
        ? assertionId
        : snapshot.affiliation_assertion_id,
      pointer === 'student_number_assertion_id'
        ? assertionId
        : snapshot.student_number_assertion_id,
      pointer === 'phone_assertion_id'
        ? assertionId
        : snapshot.phone_assertion_id,
      snapshot.application_state,
      snapshot.application_coverage,
    ],
  );
  await transaction.query(
    `INSERT INTO whaleu_verification.events(id,account_id,operation_id,kind,fact_kind,actor_account_id,expected_revision,snapshot_id,revision,reason_code) VALUES($1,$2,$3,'revoke',$4,$5,$6,$7,$8,$9)`,
    [
      eventId,
      command.accountId,
      command.operationId,
      command.fact,
      command.actorAccountId,
      command.expectedRevision,
      snapshotId,
      revision,
      command.reasonCode,
    ],
  );
  await transaction.query(
    'UPDATE whaleu_verification.account_heads SET revision=$2,snapshot_id=$3 WHERE account_id=$1',
    [command.accountId, revision, snapshotId],
  );
  return { eventId, revision };
}
