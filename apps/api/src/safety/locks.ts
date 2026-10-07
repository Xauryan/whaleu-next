import type { PoolClient } from 'pg';
/** Coarse bounded S1A policy gate: acquire before content locks. Shared ordinary
 * reads/interactions run concurrently; a block transition owns the exclusive gate
 * through commit. This covers absent pairs as well as existing relationships. */
export async function lockSafetyPolicy(tx: PoolClient, write = false) {
  await tx.query(
    `SELECT pg_advisory_xact_lock${write ? '' : '_shared'}(hashtextextended('whaleu:named-block-policy:v1',0))`,
  );
}
export async function lockNamedPair(a: string, b: string, tx: PoolClient) {
  const pair = [a, b].sort();
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
    JSON.stringify(['whaleu:named-block-pair:v1', ...pair]),
  ]);
}
