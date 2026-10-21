import type { PoolClient } from 'pg';
import { DeletionError } from '../contracts.js';
import { retainedBaselineTables } from '../owner-registry.js';
import { relationSql, sha } from './preflight.js';
export type Baseline = Record<string, Record<string, unknown>[]>;
export async function readBaseline(
  tx: PoolClient,
  account: string,
): Promise<Baseline> {
  const result: Baseline = {};
  for (const table of retainedBaselineTables) {
    const col = table.startsWith('whaleu_experience.')
      ? 'owner_id'
      : 'account_id';
    result[table] = (
      await tx.query<{ v: Record<string, unknown> }>(
        `SELECT to_jsonb(t) v FROM ${relationSql(table)} t WHERE ${col}=$1 ORDER BY to_jsonb(t)::text`,
        [account],
      )
    ).rows.map((r) => r.v);
  }
  return result;
}
const exact = (row: Record<string, unknown>, fields: readonly string[]) =>
  Object.keys(row).sort().join(',') === [...fields].sort().join(',');
const keys = (text: string) => text.split(' ');
/** No arbitrary snapshot, assertion payload or future column is retained merely
 * because its event says native. Every baseline column is enumerated. */
export function validateNativeBaseline(b: Baseline, account: string): void {
  if (
    !exact(b, retainedBaselineTables) ||
    Object.entries(b).some(
      ([table, rows]) =>
        !Array.isArray(rows) ||
        rows.some(
          (row) =>
            row === null ||
            typeof row !== 'object' ||
            row[
              table.startsWith('whaleu_experience.') ? 'owner_id' : 'account_id'
            ] !== account,
        ),
    )
  )
    throw new DeletionError('NATIVE_BASELINE_UNSUPPORTED');
  const one = (name: string, fields: string) => {
    const rows = b[name];
    if (rows?.length !== 1 || !exact(rows[0]!, keys(fields)))
      throw new DeletionError('NATIVE_BASELINE_UNSUPPORTED');
    return rows[0]!;
  };
  const owner = one('whaleu_experience.owners', 'owner_id');
  if (owner['owner_id'] !== account)
    throw new DeletionError('NATIVE_BASELINE_UNSUPPORTED');
  const base = one(
    'whaleu_experience.baselines',
    'owner_id origin opening_balance opening_signin_day opening_streak history_coverage entitlement_coverage rule_version recorded_at',
  );
  if (
    base['origin'] !== 'native_account_creation' ||
    base['opening_balance'] !== 0 ||
    base['opening_signin_day'] !== null ||
    base['opening_streak'] !== 0 ||
    base['history_coverage'] !== 'complete' ||
    base['entitlement_coverage'] !== 'complete' ||
    base['rule_version'] !== 'local-experience-v1'
  )
    throw new DeletionError('NATIVE_BASELINE_UNSUPPORTED');
  const state = one(
    'whaleu_experience.account_states',
    'owner_id balance last_signin_day streak revision',
  );
  if (
    state['balance'] !== 0 ||
    state['last_signin_day'] !== null ||
    state['streak'] !== 0 ||
    state['revision'] !== 0
  )
    throw new DeletionError('NATIVE_BASELINE_UNSUPPORTED');
  const appearance = one(
    'whaleu_experience.appearance',
    'owner_id title_key color_id revision',
  );
  if (
    appearance['title_key'] !== null ||
    appearance['color_id'] !== null ||
    appearance['revision'] !== 0
  )
    throw new DeletionError('NATIVE_BASELINE_UNSUPPORTED');
  const entitlements = b['whaleu_experience.entitlements'] ?? [];
  if (
    entitlements.length !== 2 ||
    entitlements
      .map((r) => r['title_key'])
      .sort()
      .join(',') !== 'default_jingxiaoyu,level_1' ||
    entitlements.some(
      (r) =>
        !exact(
          r,
          keys(
            'owner_id title_key origin settlement_id earned_at recorded_at redemption_request_id creation_transaction maintenance_actor_id maintenance_request_id school_admin_actor_id school_admin_request_id',
          ),
        ) ||
        r['origin'] !== 'registration' ||
        [
          'settlement_id',
          'redemption_request_id',
          'creation_transaction',
          'maintenance_actor_id',
          'maintenance_request_id',
          'school_admin_actor_id',
          'school_admin_request_id',
        ].some((k) => r[k] !== null),
    )
  )
    throw new DeletionError('NATIVE_BASELINE_UNSUPPORTED');
  const head = one(
    'whaleu_safety.account_heads',
    'account_id block_coverage restriction_coverage provenance actions_allowed valid_until created_at',
  );
  if (
    head['block_coverage'] !== 'complete' ||
    head['restriction_coverage'] !== 'complete' ||
    head['provenance'] !== 'native_account_creation' ||
    head['actions_allowed'] !== true ||
    head['valid_until'] !== null
  )
    throw new DeletionError('NATIVE_BASELINE_UNSUPPORTED');
  const event = one(
    'whaleu_safety.events',
    'id account_id relationship_id kind revision created_at',
  );
  if (
    event['kind'] !== 'native_account_created' ||
    event['relationship_id'] !== null ||
    event['revision'] !== null
  )
    throw new DeletionError('NATIVE_BASELINE_UNSUPPORTED');
  const verification = b['whaleu_verification.assertions'] ?? [];
  if (verification.length === 0) {
    if (
      Object.entries(b).some(
        ([k, v]) => k.startsWith('whaleu_verification.') && v.length > 0,
      )
    )
      throw new DeletionError('NATIVE_BASELINE_UNSUPPORTED');
    return;
  }
  if (
    verification.length !== 3 ||
    verification
      .map((r) => r['fact_kind'])
      .sort()
      .join(',') !== 'affiliation,phone,student_number'
  )
    throw new DeletionError('NATIVE_BASELINE_UNSUPPORTED');
  for (const row of verification) {
    if (
      !exact(
        row,
        keys(
          'id account_id fact_kind assertion_state coverage_state provenance_state method source_reference policy_reference source_account_id issuer_institution_id source_issuer_institution_id origin_region_id student_number phone_binding_reference verified_at expiry_kind expires_at previous_assertion_id recorded_at',
        ),
      ) ||
      row['assertion_state'] !== 'unverified' ||
      row['coverage_state'] !== 'complete' ||
      row['provenance_state'] !== 'accepted' ||
      row['method'] !== 'native_enrollment' ||
      row['source_reference'] !== `native_enrollment:${account}` ||
      row['source_account_id'] !== account ||
      row['policy_reference'] !== 'native-account-absence/v1' ||
      row['expiry_kind'] !== 'policy_exempt' ||
      keys(
        'issuer_institution_id source_issuer_institution_id origin_region_id student_number phone_binding_reference verified_at expires_at previous_assertion_id',
      ).some((k) => row[k] !== null)
    )
      throw new DeletionError('NATIVE_BASELINE_UNSUPPORTED');
  }
  const snapshot = one(
    'whaleu_verification.snapshots',
    'id account_id revision affiliation_assertion_id student_number_assertion_id phone_assertion_id application_state application_coverage recorded_at',
  );
  if (
    snapshot['revision'] !== 1 ||
    snapshot['application_state'] !== 'none' ||
    snapshot['application_coverage'] !== 'complete' ||
    verification.some(
      (r) => snapshot[`${String(r['fact_kind'])}_assertion_id`] !== r['id'],
    )
  )
    throw new DeletionError('NATIVE_BASELINE_UNSUPPORTED');
  const vh = one(
    'whaleu_verification.account_heads',
    'account_id revision snapshot_id',
  );
  if (vh['revision'] !== 1 || vh['snapshot_id'] !== snapshot['id'])
    throw new DeletionError('NATIVE_BASELINE_UNSUPPORTED');
  const ve = one(
    'whaleu_verification.events',
    'id account_id operation_id kind fact_kind actor_account_id expected_revision snapshot_id revision reason_code recorded_at',
  );
  if (
    ve['kind'] !== 'native_enrollment' ||
    ve['fact_kind'] !== null ||
    ve['actor_account_id'] !== account ||
    ve['expected_revision'] !== 0 ||
    ve['revision'] !== 1 ||
    ve['snapshot_id'] !== snapshot['id'] ||
    ve['reason_code'] !== 'native_account_created'
  )
    throw new DeletionError('NATIVE_BASELINE_UNSUPPORTED');
  const enrollment = one(
    'whaleu_verification.native_enrollments',
    'account_id app_id operation_id affiliation_id student_number_id phone_id snapshot_id event_id creation_transaction created_at',
  );
  if (
    enrollment['app_id'] !== 'synthetic-account-deletion-rehearsal' ||
    enrollment['snapshot_id'] !== snapshot['id'] ||
    enrollment['event_id'] !== ve['id'] ||
    enrollment['operation_id'] !== ve['operation_id'] ||
    verification.some(
      (r) => enrollment[`${String(r['fact_kind'])}_id`] !== r['id'],
    )
  )
    throw new DeletionError('NATIVE_BASELINE_UNSUPPORTED');
  const generation = one(
    'whaleu_verification.relevant_fact_generations',
    'account_id tracking_epoch affiliation_generation student_number_generation head_revision head_snapshot_id',
  );
  if (
    generation['affiliation_generation'] !== 1 ||
    generation['student_number_generation'] !== 1 ||
    generation['head_revision'] !== 1 ||
    generation['head_snapshot_id'] !== snapshot['id']
  )
    throw new DeletionError('NATIVE_BASELINE_UNSUPPORTED');
}
export async function baselineProof(tx: PoolClient, account: string) {
  const current = await readBaseline(tx, account);
  validateNativeBaseline(current, account);
  const sealed = (
    await tx.query<{ baseline: Baseline }>(
      'SELECT baseline FROM whaleu_account_deletion.fixture_accounts WHERE account_id=$1',
      [account],
    )
  ).rows[0]?.baseline;
  if (sha(current) !== sha(sealed))
    throw new DeletionError('NATIVE_BASELINE_CHANGED');
  return sha(current);
}
