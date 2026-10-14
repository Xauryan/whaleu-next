import type { PoolClient, QueryResultRow } from 'pg';
import { ApplicationError } from '../http/application-error.js';

export interface DependencyReadBudget {
  consume(bytes: number): void;
  remainingBytes(): number;
}
// Preserve the real PoolClient identity used by transaction owner proofs.
const observers = new WeakMap<PoolClient, DependencyReadBudget>();
export async function withDependencyReadBudget<T>(
  tx: PoolClient,
  budget: DependencyReadBudget,
  read: () => Promise<T>,
): Promise<T> {
  if (observers.has(tx)) throw new ApplicationError('RATING_UNAVAILABLE');
  observers.set(tx, budget);
  try {
    return await read();
  } finally {
    observers.delete(tx);
  }
}
export function observeDependencyReadBytes(
  tx: PoolClient,
  bytes: number,
): void {
  observers.get(tx)?.consume(bytes);
}
/** Optional caller budget; historical owner callers keep their own limits. */
export function observeDependencyRead(tx: PoolClient, value: unknown): void {
  if (observers.has(tx))
    observeDependencyReadBytes(
      tx,
      Buffer.byteLength(JSON.stringify(value), 'utf8'),
    );
}
/** Refuse excessive dependency bytes inside PostgreSQL before returning the
 * sensitive body/proof vector. This retains native column parsers (Dates) and
 * the original client/transaction identity. Caller charges its retained rows. */
export async function dependencyRows<T extends QueryResultRow>(
  tx: PoolClient,
  sql: string,
  values: unknown[],
  cap: number,
): Promise<T[]> {
  const budget = observers.get(tx);
  if (!budget) return (await tx.query<T>(sql, values)).rows;
  const remaining = budget.remainingBytes();
  if (
    !Number.isSafeInteger(remaining) ||
    remaining < 0 ||
    !Number.isSafeInteger(cap) ||
    cap < 1
  )
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  const rows = (
    await tx.query<
      T & { __dependency_count: string; __dependency_bytes: string }
    >(
      `WITH dependency_source AS MATERIALIZED (${sql}),dependency_size AS (
    SELECT count(*)::text __dependency_count,coalesce(sum(CASE WHEN pg_column_size(s)>${remaining} THEN ${remaining + 1} ELSE octet_length(row_to_json(s)::text) END),0)::text __dependency_bytes FROM dependency_source s)
    SELECT s.*,m.__dependency_count,m.__dependency_bytes FROM dependency_size m LEFT JOIN dependency_source s ON m.__dependency_count::bigint<=${cap} AND m.__dependency_bytes::bigint<=${remaining}`,
      values,
    )
  ).rows;
  const first = rows[0],
    count = Number(first?.__dependency_count),
    bytes = Number(first?.__dependency_bytes);
  if (
    !Number.isSafeInteger(count) ||
    count > cap ||
    !Number.isSafeInteger(bytes) ||
    bytes > remaining
  )
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  if (count === 0) return [];
  if (rows.length !== count)
    throw new ApplicationError('COMMUNITY_UNAVAILABLE');
  return rows.map((row) => {
    const data: Record<string, unknown> = { ...row };
    delete data['__dependency_count'];
    delete data['__dependency_bytes'];
    return data as T;
  });
}
