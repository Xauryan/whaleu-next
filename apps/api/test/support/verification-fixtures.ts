import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { inTransaction } from '../../src/database/database.js';
import type {
  ApplicationStatus,
  AssertionRecord,
  FactKind,
} from '../../src/verification/contracts.js';

/** Tests only. Never registered as a runtime provider, CLI, seed or HTTP route. */
export function syntheticAssertion(
  accountId: string,
  issuerId: string,
  kind: FactKind,
  override: Partial<AssertionRecord> = {},
): AssertionRecord {
  return {
    id: randomUUID(),
    account_id: accountId,
    fact_kind: kind,
    assertion_state: 'verified',
    coverage_state: 'complete',
    provenance_state: 'accepted',
    method: 'reconciled_import',
    source_reference: 'synthetic-record-only',
    policy_reference: 'synthetic-test-policy-only',
    source_account_id: accountId,
    issuer_institution_id: kind === 'phone' ? null : issuerId,
    source_issuer_institution_id: kind === 'phone' ? null : issuerId,
    origin_region_id: null,
    student_number: kind === 'student_number' ? '00004721' : null,
    phone_binding_reference: kind === 'phone' ? randomUUID() : null,
    verified_at: new Date(Date.now() - 60000),
    expiry_kind: 'at',
    expires_at: new Date(Date.now() + 3600000),
    ...override,
  };
}
export async function insertSyntheticAssertion(
  tx: PoolClient,
  record: AssertionRecord,
): Promise<void> {
  const columns = Object.keys(record);
  // columns originate only from the fixed test helper, never request data.
  await tx.query(
    `INSERT INTO whaleu_verification.assertions(${columns.join(',')}) VALUES(${columns.map((_, index) => `$${index + 1}`).join(',')})`,
    Object.values(record),
  );
}
export async function setSyntheticSnapshot(
  pool: Pool,
  accountId: string,
  records: readonly AssertionRecord[],
  application: ApplicationStatus = 'none',
  applicationCoverage: 'complete' | 'missing' | 'conflict' = 'complete',
): Promise<{ revision: number; snapshotId: string }> {
  return inTransaction(pool, async (tx) => {
    await tx.query(
      'INSERT INTO whaleu_verification.account_heads(account_id) VALUES($1) ON CONFLICT DO NOTHING',
      [accountId],
    );
    const head = (
      await tx.query<{ revision: number }>(
        'SELECT revision FROM whaleu_verification.account_heads WHERE account_id=$1 FOR UPDATE',
        [accountId],
      )
    ).rows[0]!;
    for (const record of records) await insertSyntheticAssertion(tx, record);
    const revision = head.revision + 1,
      snapshotId = randomUUID();
    const id = (kind: FactKind) =>
      records.find((record) => record.fact_kind === kind)?.id ?? null;
    await tx.query(
      'INSERT INTO whaleu_verification.snapshots(id,account_id,revision,affiliation_assertion_id,student_number_assertion_id,phone_assertion_id,application_state,application_coverage) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        snapshotId,
        accountId,
        revision,
        id('affiliation'),
        id('student_number'),
        id('phone'),
        application,
        applicationCoverage,
      ],
    );
    await tx.query(
      "INSERT INTO whaleu_verification.events(id,account_id,operation_id,kind,actor_account_id,expected_revision,snapshot_id,revision,reason_code) VALUES($1,$2,$3,'reconciled_snapshot',$2,$4,$5,$6,'synthetic_fixture')",
      [
        randomUUID(),
        accountId,
        randomUUID(),
        head.revision,
        snapshotId,
        revision,
      ],
    );
    await tx.query(
      'UPDATE whaleu_verification.account_heads SET revision=$2,snapshot_id=$3 WHERE account_id=$1',
      [accountId, revision, snapshotId],
    );
    return { revision, snapshotId };
  });
}
