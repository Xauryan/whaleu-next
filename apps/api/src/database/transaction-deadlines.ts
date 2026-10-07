import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import type { ApplicationErrorCode } from '../http/application-error.js';
/** Internal owner facts only. A deadline is registered only while its canonical
 * source is locked. The transaction wrapper checks after ALL deferred waits. */
const deadlines = new WeakMap<PoolClient, Map<ApplicationErrorCode, number>>();
export function startTransactionDeadlines(tx: PoolClient) {
  deadlines.set(tx, new Map());
}
export function clearTransactionDeadlines(tx: PoolClient) {
  deadlines.delete(tx);
}
export function registerTransactionDeadline(
  tx: PoolClient,
  until: number | null,
  code: ApplicationErrorCode,
) {
  if (until === null) return;
  if (!Number.isFinite(until)) throw new ApplicationError(code);
  const current = deadlines.get(tx);
  if (!current) return; // Standalone owner reads still perform their own current-clock check.
  current.set(
    code,
    Math.min(current.get(code) ?? Number.POSITIVE_INFINITY, until),
  );
}
export async function checkTransactionDeadlines(tx: PoolClient) {
  const current = deadlines.get(tx);
  if (!current?.size) return;
  await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
  const now = (
    await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
  ).rows[0]!.now.getTime();
  if (!Number.isFinite(now))
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  for (const [code, until] of current)
    if (until <= now) throw new ApplicationError(code);
}

export function checkpointTransactionDeadlines(tx: PoolClient) {
  return new Map(deadlines.get(tx));
}
export function restoreTransactionDeadlines(
  tx: PoolClient,
  checkpoint: Map<ApplicationErrorCode, number>,
) {
  if (deadlines.has(tx)) deadlines.set(tx, new Map(checkpoint));
}
