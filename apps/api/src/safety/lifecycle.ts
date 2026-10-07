import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
/** Called only inside the identity owner's NEW native account transaction.
 * Never use login of an existing account as evidence of empty imported history. */
export async function initializeNativeSafetyAccount(
  accountId: string,
  tx: PoolClient,
) {
  await tx.query(
    "INSERT INTO whaleu_safety.account_heads(account_id,block_coverage,restriction_coverage,provenance,actions_allowed) VALUES($1,'complete','complete','native_account_creation',true)",
    [accountId],
  );
  await tx.query(
    "INSERT INTO whaleu_safety.events(id,account_id,kind) VALUES($1,$2,'native_account_created')",
    [randomUUID(), accountId],
  );
}
