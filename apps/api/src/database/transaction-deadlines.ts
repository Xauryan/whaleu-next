import type { PoolClient } from 'pg';
import { ApplicationError } from '../http/application-error.js';
import type { ApplicationErrorCode } from '../http/application-error.js';
/** Internal owner facts only. A deadline is registered only while its canonical
 * source is locked. The transaction wrapper checks after ALL deferred waits. */
const deadlines = new WeakMap<PoolClient, Map<ApplicationErrorCode, number>>();
const optionalDeadlines = new WeakMap<
  PoolClient,
  { until: number; expire: () => void }[]
>();
export function startTransactionDeadlines(tx: PoolClient) {
  deadlines.set(tx, new Map());
  optionalDeadlines.set(tx, []);
}
export function clearTransactionDeadlines(tx: PoolClient) {
  deadlines.delete(tx);
  optionalDeadlines.delete(tx);
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
  const optional = optionalDeadlines.get(tx) ?? [];
  if (!current?.size && !optional.length) return;
  await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
  const now = (
    await tx.query<{ now: Date }>('SELECT clock_timestamp() AS now')
  ).rows[0]!.now.getTime();
  if (!Number.isFinite(now))
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  for (const [code, until] of current ?? [])
    if (until <= now) throw new ApplicationError(code);
  for (const entry of optional) if (entry.until <= now) entry.expire();
}

const optionalCheckpoints = new WeakMap<
  Map<ApplicationErrorCode, number>,
  number
>();
export function checkpointTransactionDeadlines(tx: PoolClient) {
  const snapshot = new Map(deadlines.get(tx));
  optionalCheckpoints.set(snapshot, optionalDeadlines.get(tx)?.length ?? 0);
  return snapshot;
}
export function restoreTransactionDeadlines(
  tx: PoolClient,
  checkpoint: Map<ApplicationErrorCode, number>,
) {
  if (deadlines.has(tx)) {
    deadlines.set(tx, new Map(checkpoint));
    const size = optionalCheckpoints.get(checkpoint);
    if (size !== undefined) optionalDeadlines.get(tx)?.splice(size);
  }
}

/** Optional display counts retain their source locks but must not turn their
 * expiry into a failure of separately authorized mandatory profile basics.
 * The callback updates the still-private response before it leaves commit. */
export function registerOptionalTransactionDeadline(
  tx: PoolClient,
  until: number | null,
  expire: () => void,
) {
  if (until === null) return;
  if (!Number.isFinite(until))
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  optionalDeadlines.get(tx)?.push({ until, expire });
}
