import type { PoolClient } from 'pg';
/** Only the identity owner's genuinely new account transaction may call this.
 * The SQL guard independently requires same-top-level-transaction creation. */
export async function initializeNativeExperienceAccount(
  owner: string,
  tx: PoolClient,
): Promise<void> {
  await tx.query('INSERT INTO whaleu_experience.owners(owner_id) VALUES($1)', [
    owner,
  ]);
  await tx.query(
    "INSERT INTO whaleu_experience.baselines(owner_id,origin,opening_balance,opening_streak,history_coverage,entitlement_coverage) VALUES($1,'native_account_creation',0,0,'complete','complete')",
    [owner],
  );
  await tx.query(
    'INSERT INTO whaleu_experience.account_states(owner_id,balance,streak) VALUES($1,0,0)',
    [owner],
  );
  await tx.query(
    "INSERT INTO whaleu_experience.entitlements(owner_id,title_key,origin,earned_at) VALUES($1,'default_jingxiaoyu','registration',clock_timestamp()),($1,'level_1','registration',clock_timestamp())",
    [owner],
  );
  await tx.query(
    'INSERT INTO whaleu_experience.appearance(owner_id) VALUES($1)',
    [owner],
  );
}
