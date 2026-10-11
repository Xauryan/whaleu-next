import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';

/** Only identity's newly inserted native account branch may call this, after its
 * WeChat provider row exists. SQL independently checks the current creation xid,
 * absence of prior history and legacy mappings, and the complete commit result.
 * No imported/old account repair and no verified fact is issued here. */
export async function initializeNativeVerificationAccount(
  accountId: string,
  appId: string,
  tx: PoolClient,
): Promise<void> {
  const affiliation = randomUUID();
  const number = randomUUID();
  const phone = randomUUID();
  const snapshot = randomUUID();
  const operation = randomUUID();
  const event = randomUUID();
  await tx.query(
    `INSERT INTO whaleu_verification.native_enrollments
     (account_id,app_id,operation_id,affiliation_id,student_number_id,phone_id,snapshot_id,event_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [accountId, appId, operation, affiliation, number, phone, snapshot, event],
  );
  await tx.query(
    'INSERT INTO whaleu_verification.account_heads(account_id) VALUES($1)',
    [accountId],
  );
  for (const [kind, id] of [
    ['affiliation', affiliation],
    ['student_number', number],
    ['phone', phone],
  ] as const) {
    await tx.query(
      `INSERT INTO whaleu_verification.assertions
       (id,account_id,fact_kind,assertion_state,coverage_state,provenance_state,method,
        source_reference,policy_reference,source_account_id,expiry_kind)
       VALUES($1,$2,$3,'unverified','complete','accepted','native_enrollment',
        $4,'native-account-absence/v1',$2,'policy_exempt')`,
      [id, accountId, kind, `native_enrollment:${accountId}`],
    );
  }
  await tx.query(
    `INSERT INTO whaleu_verification.snapshots
     (id,account_id,revision,affiliation_assertion_id,student_number_assertion_id,phone_assertion_id,application_state,application_coverage)
     VALUES($1,$2,1,$3,$4,$5,'none','complete')`,
    [snapshot, accountId, affiliation, number, phone],
  );
  await tx.query(
    `INSERT INTO whaleu_verification.events
     (id,account_id,operation_id,kind,fact_kind,actor_account_id,expected_revision,snapshot_id,revision,reason_code)
     VALUES($1,$2,$3,'native_enrollment',NULL,$2,0,$4,1,'native_account_created')`,
    [event, accountId, operation, snapshot],
  );
  await tx.query(
    'UPDATE whaleu_verification.account_heads SET revision=1,snapshot_id=$2 WHERE account_id=$1',
    [accountId, snapshot],
  );
}
