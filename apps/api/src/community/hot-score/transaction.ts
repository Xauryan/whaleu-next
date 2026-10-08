import type { PoolClient } from 'pg';

export async function boundHotTransaction(tx: PoolClient): Promise<void> {
  await tx.query("SET LOCAL statement_timeout='1500ms'");
  await tx.query("SET LOCAL lock_timeout='500ms'");
  await tx.query("SET LOCAL transaction_timeout='5000ms'");
}
